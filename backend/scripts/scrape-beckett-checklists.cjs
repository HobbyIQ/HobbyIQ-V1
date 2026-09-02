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
 * each linking a workbook. The host has MOVED: workbooks now serve from
 *
 *     https://beckett-www.s3.amazonaws.com/news/news-content/uploads/YYYY/MM/<Set>-Checklist.xlsx
 *
 * and the old img.beckett.com form documented here until 2026-09-01 is stale.
 * The extraction regex below is host-agnostic and was never wrong -- only this
 * comment was, which is worth saying because a reader who trusts it will go
 * looking for a bug in working code.
 *
 * The page 403s a plain fetch and serves fine with a browser user-agent, which
 * is why this exists rather than a WebFetch.
 *
 * THE ARCHIVE INDEX IS BASEBALL-ONLY (measured 2026-09-01: all 29 pages walked
 * live -> 719 set pages, 708 baseball, 1 basketball, 1 football, 1 soccer; the
 * nested basketball/football category 404s in every form). --sport therefore
 * cannot reach, e.g., 2020-21 Panini Prizm Basketball. --urls is the escape:
 * hand it the set page (or the workbook) directly and the archive walk is
 * skipped. Same shape as the hobbymonitor direct-URL lane, for the same
 * reason -- a release the index cannot name.
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
 *     [--urls=<setPageOrWorkbookUrl>[,<url>...]]
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
// Direct-URL lane: comma-separated set pages and/or workbook URLs. When given,
// the archive walk is skipped entirely -- the index is baseball-only and
// cannot name these releases.
const DIRECT_URLS = String(arg("urls", "")).split(",").map((s) => s.trim()).filter(Boolean);

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
  // A workbook URL carries the same identity in its FILENAME, one segment
  // deeper and with "-Checklist[-N].xlsx" where a page says "-cards":
  //   .../uploads/2021/03/2020-21-Panini-Prizm-Basketball-Checklist-1.xlsx
  // The direct-URL lane accepts either form, so both parse here rather than
  // the caller guessing which one it was handed.
  if (/\.xlsx?$/i.test(url)) {
    const file = decodeURIComponent((url.split("/").pop() || "").replace(/\.xlsx?$/i, ""));
    const w = file.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+?)-(baseball|basketball|football|hockey|soccer|wrestling)-checklist(?:-\d+)?$/i);
    if (!w) return null;
    const [, year, middle, sport] = w;
    const setName = middle.split("-").map((x) => (x.length > 2 ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join(" ");
    return { year: Number(year), sport: sport.toLowerCase(), setKey: slugify(middle), setName, slug: slugify(file), xlsxUrl: url };
  }
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

  // ── 1. the work list: direct URLs, or a walk of the archive ──────────────
  let urls;
  if (DIRECT_URLS.length) {
    urls = DIRECT_URLS;
    console.log(`direct-URL lane: ${f(urls.length)} url(s), archive walk SKIPPED`);
    for (const u of urls) console.log(`  ${u}`);
    console.log("");
  } else {
    const setUrls = new Set();
    for (let p = 1; p <= PAGES; p++) {
      const html = await get(ARCHIVE(p));
      await sleep(DELAY_MS);
      if (!html) { console.error(`  archive page ${p} unreachable`); continue; }
      for (const m of html.matchAll(/https:\/\/www\.beckett\.com\/news\/[a-z0-9-]+-cards\//g)) setUrls.add(m[0]);
      process.stderr.write(`\r  archive page ${p}/${PAGES}  sets=${setUrls.size}   `);
    }
    process.stderr.write("\n");
    urls = [...setUrls];
    console.log(`${f(urls.length)} set pages indexed\n`);

    // AN EMPTY SCRAPE IS A FAILURE, not a quiet success. Exiting 0 here let the
    // end-to-end wrapper record "beckett-acquired" and walk on to an ingest
    // with nothing staged -- the same hole scrape-checklistinsider.cjs closed
    // at its own sitemap step. Mirrored here because Beckett 403s a plain
    // fetch: an IP block on the runner looks EXACTLY like an empty archive.
    if (!urls.length) {
      console.error(`FATAL: 0 set pages indexed across ${PAGES} archive page(s).`);
      console.error("       The archive answers 200 from a residential IP and 403s an unbranded");
      console.error("       fetch, so suspect an IP block or a user-agent rejection on the runner");
      console.error("       before suspecting the regex. Read the HTTP lines above.");
      console.error("       For a release the index cannot name, use --urls=<setPage|workbook>.");
      process.exit(1);
    }
  }

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
      // A direct workbook URL is already the address; there is no page to fetch.
      let xlsxUrl = id.xlsxUrl;
      if (!xlsxUrl) {
        const html = await get(url);
        await sleep(DELAY_MS);
        if (!html) { failed++; report.push({ url, issue: "page unreachable" }); continue; }
        xlsxUrl = (html.match(/https?:\/\/[^"' ]+\.xlsx?/) || [])[0];
      }
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
