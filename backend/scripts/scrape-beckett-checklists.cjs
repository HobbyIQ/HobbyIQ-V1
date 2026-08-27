#!/usr/bin/env node
/**
 * CF-BUILD-FROM-A-CLEAN-CHECKLIST (Drew, 2026-08-26).
 *
 * "We want to build from a clean checklist, because if it is sales derived it
 * could be wrong."
 *
 * That is the whole argument for this script. Measured on 2026 Bowman Chrome
 * Mega Box: of its catalog rows, 944 came from `ingest-auto-seed` -- built FROM
 * the sales -- and 614 from a checklist. A sale seeds a row and that row then
 * confirms the sale, so the match proves nothing about whether the card is
 * real, spelled right, or numbered right. A checklist is the manufacturer's
 * own list, and it is the only thing that can contradict a sale.
 *
 * Beckett's baseball checklist archive runs 29 pages, roughly 1,100 set pages,
 * each linking a workbook at a predictable address:
 *
 *     https://img.beckett.com/news/news-content/uploads/YYYY/MM/<Set>-Checklist.xlsx
 *
 * The page 403s a plain fetch and serves fine with a browser user-agent, which
 * is why this exists rather than a WebFetch.
 *
 * WHAT IT DOES NOT DO. It does not write to Cosmos. Output is the canonical
 * CSV plus a manifest per set, staged for review -- a scraper that wrote
 * straight into the catalog would be another self-confirming source, which is
 * the defect this whole effort exists to remove.
 *
 * ONE CONVERTER, NOT TWO. Workbooks are handed to convertBeckettChecklistXlsx,
 * so the parallel ladder, the Master-sheet skip and the TBA-placeholder
 * handling all come from the same code the single-set path uses. A second
 * implementation would drift.
 *
 * Usage:
 *   node backend/scripts/scrape-beckett-checklists.cjs \
 *     [--sport=baseball] [--pages=29] [--limit=N] [--delayMs=1200]
 *     [--outDir=C:/tmp/beckett-bulk] [--skipExisting]
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const PAGES = Number(arg("pages", "29"));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const DELAY_MS = Number(arg("delayMs", "1200"));
const OUT_DIR = arg("outDir", "C:/tmp/beckett-bulk");
const SKIP_EXISTING = process.argv.includes("--skipExisting");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const ARCHIVE = (p) =>
  `https://www.beckett.com/news/category/${SPORT}/${SPORT}-card-checklists/${p > 1 ? `page/${p}/` : ""}`;

const f = (n) => Number(n).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, binary = false) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
}

/**
 * Year, sport and set name out of a Beckett news slug:
 *   2025-topps-inception-baseball-cards -> 2025, baseball, "Topps Inception"
 *   2025-26-upper-deck-premier-hockey-cards -> 2025, hockey, "Upper Deck Premier"
 *
 * The season form ("2025-26") takes the FIRST year, matching how the catalog
 * keys a season product.
 */
function identify(url) {
  const slug = (url.match(/\/news\/([^/]+)\/?$/) || [])[1] || "";
  const m = slug.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+?)-(baseball|basketball|football|hockey|soccer|wrestling)-cards$/);
  if (!m) return null;
  const [, year, middle, sport] = m;
  const setName = middle.split("-").map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return { year: Number(year), sport, setKey: slugify(middle), setName, slug };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const converter = path.join(__dirname, "convertBeckettChecklistXlsx.cjs");

  // ── 1. walk the archive ──────────────────────────────────────────────────
  const setUrls = new Set();
  for (let p = 1; p <= PAGES; p++) {
    const html = await get(ARCHIVE(p));
    await sleep(DELAY_MS);
    if (!html) { console.error(`  archive page ${p} unreachable`); continue; }
    for (const m of html.matchAll(/https:\/\/www\.beckett\.com\/news\/[a-z0-9-]+-cards\//g)) setUrls.add(m[0]);
    process.stderr.write(`\r  archive page ${p}/${PAGES}  sets=${setUrls.size}   `);
  }
  process.stderr.write("\n");
  const urls = [...setUrls];
  console.log(`${f(urls.length)} set pages indexed\n`);

  let done = 0, withXlsx = 0, converted = 0, rows = 0, noXlsx = 0, failed = 0, skipped = 0;
  const report = [];

  for (const url of urls) {
    if (done >= LIMIT) break;
    done++;
    const id = identify(url);
    if (!id) { report.push({ url, issue: "could not parse year/sport from slug" }); failed++; continue; }
    const productKey = `${id.year}-${id.setKey}-${id.sport}`;
    const csvPath = path.join(OUT_DIR, `${productKey}.csv`);
    if (SKIP_EXISTING && fs.existsSync(csvPath)) { skipped++; continue; }

    try {
      const html = await get(url);
      await sleep(DELAY_MS);
      if (!html) { failed++; report.push({ url, issue: "page unreachable" }); continue; }

      const xlsxUrl = (html.match(/https?:\/\/[^"' ]+\.xlsx?/) || [])[0];
      if (!xlsxUrl) {
        // A set page with no workbook is a real gap in THEIR coverage, not a
        // parse failure -- recorded so the two never look alike.
        noXlsx++;
        report.push({ url, issue: "no workbook linked" });
        continue;
      }
      withXlsx++;

      const bin = await get(xlsxUrl, true);
      await sleep(DELAY_MS);
      if (!bin || bin.length < 2000) { failed++; report.push({ url, xlsxUrl, issue: "workbook empty or unreachable" }); continue; }
      const xlsxPath = path.join(OUT_DIR, `${productKey}.xlsx`);
      fs.writeFileSync(xlsxPath, bin);

      // Same converter as the single-set path: ladder, Master skip, TBA.
      const out = execFileSync(process.execPath, [
        converter,
        "--xlsx", xlsxPath, "--year", String(id.year),
        "--set-key", id.setKey, "--set-name", `${id.year} ${id.setName}`,
        "--sport", id.sport, "--out", csvPath, "--source-url", xlsxUrl,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      const n = Number((out.match(/rows=(\d+)/) || [])[1] || 0);
      if (!n) { report.push({ url, xlsxUrl, issue: "converted to 0 rows" }); continue; }
      converted++; rows += n;

      fs.writeFileSync(path.join(OUT_DIR, `${productKey}.manifest.json`), JSON.stringify({
        scrapedAt: new Date().toISOString(),
        sourceUrl: xlsxUrl, pageUrl: url,
        sport: id.sport, year: id.year, setName: `${id.year} ${id.setName}`,
        productKey, setKey: id.setKey, rowCount: n,
      }, null, 1) + "\n");

      fs.rmSync(xlsxPath, { force: true });
      process.stderr.write(`\r  ${done}/${urls.length}  converted=${converted} rows=${f(rows)}   `);
    } catch (e) {
      failed++;
      report.push({ url, issue: String(e.message ?? e).slice(0, 120) });
    }
  }
  process.stderr.write("\n");

  console.log(`\nset pages visited      ${f(done)}`);
  console.log(`  linked a workbook    ${f(withXlsx)}`);
  console.log(`  CONVERTED            ${f(converted)}`);
  console.log(`  card rows            ${f(rows)}`);
  console.log(`  no workbook linked   ${f(noXlsx)}   <- their gap, not our parser`);
  console.log(`  skipped (existing)   ${f(skipped)}`);
  console.log(`  failed               ${f(failed)}`);
  console.log(`\n  format: category,cardNumber,parallel,isAuto,printRun,player`);
  console.log(`  staged to ${OUT_DIR} — STAGING ONLY, nothing written to Cosmos`);
  if (report.length) {
    fs.writeFileSync(path.join(OUT_DIR, "_diagnostics.json"), JSON.stringify(report, null, 1) + "\n");
    console.log(`  ${f(report.length)} diagnostics -> _diagnostics.json`);
  }
}

module.exports = { identify };

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
}
