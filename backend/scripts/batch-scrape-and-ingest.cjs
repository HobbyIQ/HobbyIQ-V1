// CF-BATCH-SCRAPE-INGEST (Drew, 2026-08-10). Driver: reads
// catalog-coverage-gap.json (from discoverMissingCatalog.cjs), picks the
// top-N products, tries scrapers in priority order, ingests into
// card_catalog.
//
// Scraper priority:
//   1. baseballcardpedia (broadest coverage for vintage + modern)
//   2. tcdb (fallback)
//   [beckett may need auth; skipped for now]
//
// URL patterns:
//   BCP: https://baseballcardpedia.com/index.php/{setName_underscored}
//        e.g. "1999 Upper Deck Black Diamond" → 1999_Upper_Deck_Black_Diamond
//   TCDB: https://www.tcdb.com/Checklist.cfm/sid/... — needs the SID from
//        their search. Not deterministic from setKey; require a lookup pass.
//
// Env:
//   TOP_N               default 20 (products to attempt)
//   APPLY=true          write to catalog (default dry-run)
//   GAP_JSON            default scripts/catalog-coverage-gap.json
//   ONLY_ZERO_CATALOG   default false — only try products with 0 catalog

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TOP_N = Number(process.env.TOP_N || 20);
const APPLY = process.env.APPLY === "true";
const GAP_JSON = process.env.GAP_JSON || path.join(__dirname, "catalog-coverage-gap.json");
const ONLY_ZERO_CATALOG = process.env.ONLY_ZERO_CATALOG === "true";

// Common setKey → BCP URL name mapping. Many are direct.
// Special-case a few that BCP uses differently (e.g. "black diamond"
// pages are titled "1999 Black Diamond" not "1999 Upper Deck Black Diamond").
function bcpUrlFor(product) {
  const { year, setKey, sport } = product;
  if (sport !== "baseball") return null; // BCP is baseball-only
  const nameCandidates = [];
  const setSlug = setKey.replace(/-/g, " ");
  // Try both "1999 <setName>" and "1999 Upper Deck <setName>" style variants
  nameCandidates.push(`${year}_${setKey.replace(/-/g, "_")}`);
  // Special renames — BCP URL name for each canonical setKey.
  // Verified live 2026-08-11 against baseballcardpedia.com.
  const renames = {
    "upper-deck-black-diamond": ["Black_Diamond", "Upper_Deck_Black_Diamond"],
    "spx-finite": ["SPx_Finite"],
    "upper-deck-retro": ["Upper_Deck_Retro"],
    "upper-deck-choice": ["Upper_Deck_Choice"],
    "topps-chrome": ["Topps_Chrome"],
    "topps-chrome-platinum": ["Topps_Chrome_Platinum_Anniversary"],
    "topps-chrome-update": ["Topps_Chrome_Update", "Topps_Update"],
    "topps-chrome-sapphire": ["Topps_Chrome_Sapphire"],
    "topps-heritage": ["Topps_Heritage"],
    "topps-finest": ["Finest"],
    "topps-pristine": ["Topps_Pristine"],
    "topps-total": ["Topps_Total"],
    "topps-traded": ["Topps_Traded"],
    "topps-tiffany": ["Topps_Tiffany"],
    "topps-stadium-club": ["Stadium_Club", "Topps_Stadium_Club"],
    "topps-allen-ginter": ["Allen_and_Ginter", "Topps_Allen_and_Ginter"],
    "topps-gypsy-queen": ["Gypsy_Queen"],
    "topps-big-league": ["Topps_Big_League"],
    "topps-archives": ["Topps_Archives"],
    "bowman-chrome": ["Bowman_Chrome"],
    "bowman-chrome-sapphire": ["Bowman_Chrome_Sapphire", "Bowman_Sapphire"],
    "bowman-mega": ["Bowman_Mega_Box", "Bowman_Mega"],
    "bowman-draft": ["Bowman_Draft"],
    "bowman-heritage": ["Bowman_Heritage"],
    "bowman-sterling": ["Bowman_Sterling"],
    "bowman-paper": ["Bowman"],
    "bowman-draft-paper": ["Bowman_Draft"],
    "bowman": ["Bowman"],
    "topps": ["Topps"],
    "fleer": ["Fleer"],
    "score": ["Score"],
    "leaf": ["Leaf"],
    "donruss": ["Donruss"],
    "goudey": ["Goudey"],
    "sp-authentic": ["SP_Authentic"],
    "sp-prospects": ["SP_Prospects", "SP_Top_Prospects"],
    "upper-deck": ["Upper_Deck"],
    "flair": ["Flair", "Flair_Showcase"],
    "pinnacle": ["Pinnacle"],
    "skybox": ["Skybox"],
    "skybox-premium": ["Skybox_Premium"],
    "metal-universe": ["Metal_Universe"],
    "o-pee-chee": ["O-Pee-Chee"],
  };
  const alt = renames[setKey];
  if (alt) for (const a of alt) nameCandidates.push(`${year}_${a}`);
  return nameCandidates.map((n) => `https://baseballcardpedia.com/index.php/${n}`);
}

function scrapeBcp(url, setKey) {
  const env = { ...process.env, BCP_URL: url, SET_KEY: setKey };
  const r = spawnSync(process.execPath, [path.join(__dirname, "scrape-baseballcardpedia.cjs")], { env, cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function ingestScraped(csvPath) {
  const env = { ...process.env, CSV_PATH: csvPath, APPLY: APPLY ? "true" : "" };
  const r = spawnSync(process.execPath, [path.join(__dirname, "ingest-scraped-checklist.cjs")], { env, cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

async function main() {
  if (!fs.existsSync(GAP_JSON)) { console.error(`gap file not found: ${GAP_JSON} — run discoverMissingCatalog.cjs first`); process.exit(1); }
  const gap = JSON.parse(fs.readFileSync(GAP_JSON, "utf8"));
  let products = gap.products || [];
  if (ONLY_ZERO_CATALOG) products = products.filter((p) => p.catalogRows === 0);
  products = products.slice(0, TOP_N);
  console.log(`▸ batch scrape+ingest  ${APPLY ? "APPLY" : "DRY-RUN"}  top=${TOP_N}  zero-only=${ONLY_ZERO_CATALOG}`);
  console.log(`  targets:`);
  for (const p of products) console.log(`    ${p.year} ${p.setKey} (${p.soldCompsRows} comps, ${p.catalogRows} catalog, gap=${p.gap})`);

  const scrapedDir = path.resolve(__dirname, "..", "data", "checklists", "scraped");
  const results = [];
  for (const p of products) {
    console.log(`\n=== ${p.year} ${p.setKey} ===`);
    const urls = bcpUrlFor(p);
    if (!urls || urls.length === 0) {
      console.log(`  no BCP URL known (sport=${p.sport}) — skip`);
      results.push({ ...p, status: "no-source" });
      continue;
    }
    let scraped = false;
    for (const url of urls) {
      console.log(`  try ${url}`);
      const scrapeResult = scrapeBcp(url, p.setKey);
      // Look for "total rows: N" in output
      const m = /total rows:\s+(\d+)/.exec(scrapeResult.stdout);
      const rows = m ? Number(m[1]) : 0;
      if (rows > 0) {
        console.log(`    ✓ scraped ${rows} rows`);
        const csvPath = path.join(scrapedDir, `${p.year}-${p.setKey}.csv`);
        // The scraper writes to a slugified URL name; find the actual file
        const actualCsv = fs.readdirSync(scrapedDir).find((f) => f.endsWith(".csv") && (
          f.startsWith(`${p.year}-`) && (
            f.includes(p.setKey.replace(/-/g, "-")) ||
            f.includes(url.split("/").pop().replace(/_/g, "-").toLowerCase())
          )
        ));
        if (!actualCsv) {
          console.log(`    ! scraped but couldn't find CSV in ${scrapedDir}`);
          continue;
        }
        const fullCsv = path.join(scrapedDir, actualCsv);
        console.log(`    ingesting ${actualCsv}`);
        const ing = ingestScraped(fullCsv);
        const wm = /wrote=(\d+)|total would-upsert=(\d+)/.exec(ing.stdout);
        const wrote = wm ? Number(wm[1] || wm[2]) : 0;
        console.log(`    ${APPLY ? "✓ wrote" : "would write"} ${wrote} catalog rows`);
        results.push({ ...p, status: "ok", scrapedFrom: url, csv: actualCsv, rowsScraped: rows, rowsWritten: wrote });
        scraped = true;
        break;
      } else {
        console.log(`    - no rows from ${url}`);
      }
    }
    if (!scraped) results.push({ ...p, status: "no-checklist-found" });
  }

  console.log(`\n=== SUMMARY ===`);
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(`  ${ok}/${results.length} products scraped + ingested`);
  const failed = results.filter((r) => r.status !== "ok");
  if (failed.length) {
    console.log(`  ${failed.length} failed (no source):`);
    for (const f of failed) console.log(`    ${f.year} ${f.setKey}: ${f.status}`);
  }

  const outPath = path.join(__dirname, "batch-scrape-results.json");
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`  wrote ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
