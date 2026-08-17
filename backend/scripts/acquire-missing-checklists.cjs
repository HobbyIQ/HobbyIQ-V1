#!/usr/bin/env node
/**
 * CF-ACQUIRE-MISSING-CHECKLISTS (Drew, 2026-08-16: "lets get every catalog we
 * need and ingest the FULL checklist for all of those and that way we can run
 * it daily to stay on top of it").
 *
 * Takes the ranking from checklist-gap-report — products our SALES reference
 * that have little or no CHECKLIST behind them — and goes and gets them.
 *
 * DRIVEN BY THE GAP REPORT, NOT THE SEED QUEUE. The queue is fed by match
 * failures, and only 22% of those were genuinely missing checklists; its top
 * entry asked for 2025 Topps against 2.9M checklist-backed rows we already
 * had. Working from stranded-sales-per-product instead means the job spends
 * publisher goodwill only on things we actually lack.
 *
 * ALREADY-COVERED PRODUCTS ARE SKIPPED AT RUN TIME, not just at ranking time.
 * A daily job re-reads the gap each run, so once a product is covered it stops
 * being fetched — that is what makes this safe to leave on a schedule.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/acquire-missing-checklists.cjs [--apply] [--max=12] [--gaps=path]
 *
 * Defaults to DRY-RUN.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const backend = path.join(__dirname, "..");

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);

/**
 * setKey -> the brand slug the publisher uses in its URLs.
 *
 * Only the cases where OUR key and THEIR name genuinely differ. Everything
 * else falls through to the setKey, which is already a slug. Guessing a URL
 * costs one 404 and nothing else, so this stays small on purpose rather than
 * trying to be a second product vocabulary.
 */
const URL_BRAND = {
  "panini-optic": "donruss-optic",
  "panini-donruss": "donruss",
  "panini-prizm": "prizm",
  "panini-select": "select",
  "panini-mosaic": "mosaic",
  "panini-chronicles": "chronicles",
  "topps-chrome-update-series": "topps-chrome-update",
  "topps-series-1": "topps-series-1",
  "topps-series-2": "topps-series-2",
  "bowman-chrome-sapphire": "bowman-chrome-sapphire",
};

const FETCHER = path.join(backend, "scripts/fetchCardboardConnectionChecklist.cjs");
const INGESTER = path.join(backend, "scripts/ingest-scraped-checklist.cjs");

function titleCase(slug) {
  return String(slug).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function run(file, args, env) {
  return execFileSync(process.execPath, [file, ...args], {
    cwd: backend, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) }, timeout: 300_000,
  });
}

async function main() {
  const APPLY = has("apply");
  const MAX = Math.max(1, Number(arg("max", "12")));
  const GAPS = arg("gaps", "");
  if (!GAPS || !fs.existsSync(GAPS)) {
    console.error("need --gaps=<json from checklist-gap-report.cjs>");
    process.exit(2);
  }
  const gaps = JSON.parse(fs.readFileSync(GAPS, "utf8"));
  const outDir = path.join(backend, "data/checklists/scraped/acquired");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[acquire] mode=${APPLY ? "APPLY" : "DRY-RUN"} max=${MAX} candidates=${gaps.length}\n`);

  let fetched = 0, ingested = 0, rows = 0, missing = 0, failed = 0;
  for (const g of gaps.slice(0, MAX)) {
    const brand = URL_BRAND[g.setKey] || g.setKey;
    const url = `https://www.cardboardconnection.com/${g.year}-${brand}-${g.sport}-cards`;
    const stem = path.join(outDir, `${g.year}-${g.setKey}-${g.sport}`);
    const label = `${g.year} ${g.setKey} ${g.sport}`.padEnd(38);

    if (!APPLY) { console.log(`  would fetch  ${label} ${g.comps} comps / ${g.checklistRows} rows`); continue; }

    try {
      run(FETCHER, ["--url", url, "--year", String(g.year), "--brand", titleCase(brand),
        "--sport", g.sport, "--set-key", g.setKey, "--out", `${stem}.csv`]);
    } catch {
      missing++; console.log(`  MISS  ${label} (publisher has no page)`); continue;
    }
    const lines = fs.existsSync(`${stem}.csv`)
      ? fs.readFileSync(`${stem}.csv`, "utf8").split("\n").filter(Boolean).length - 1 : 0;
    // A handful of rows means the page parsed but held no real checklist.
    // Ingesting that writes noise into the catalog for no coverage gain.
    if (lines < 5) { missing++; console.log(`  THIN  ${label} (${lines} rows)`); continue; }
    fetched++;

    try {
      const out = run(INGESTER, [], {
        CSV_PATH: `${stem}.csv`, SOURCE_LABEL: "cardboardconnection", APPLY: "true",
      });
      const m = out.match(/wrote=(\d+)/);
      const n = m ? Number(m[1]) : 0;
      rows += n; ingested++;
      console.log(`  OK    ${label} csv=${lines} wrote=${n}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${label} ingest: ${String(e.message).slice(0, 80)}`);
    }
  }

  console.log(`\nfetched=${fetched} ingested=${ingested} rows=${rows} missing=${missing} failed=${failed}`);
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
