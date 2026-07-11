#!/usr/bin/env node
/**
 * CF-STRESS-TEST-REFERENCE-CATALOG (2026-07-10, Drew).
 *
 * Runs Drew's Bowman_2022_2026_Pricing_Stress_Test.xlsx against the
 * live prod reference-catalog Cosmos container, surfacing THREE gap
 * classes:
 *
 *   1. RESOLVE MISSES — (productKey, year, parallel, auto) tuples in
 *      the stress-test that do NOT resolve in Cosmos. Highest-severity
 *      gap; the ladder wire-up literally cannot fire on these.
 *
 *   2. PRINT-RUN MISMATCHES — tuples that resolve but where Cosmos's
 *      printRun disagrees with the workbook's Serial Number. Flags
 *      calibration drift between the source workbook and what got
 *      ingested.
 *
 *   3. UNIQUE-PARALLEL AUDIT — unique parallels in the stress-test,
 *      per year, and whether Cosmos has coverage for each. Same shape
 *      as (1) but pivoted for triage-priority.
 *
 * Runbook:
 *   $env:COSMOS_CONNECTION_STRING = "..."  # pull from HobbyIQ3
 *   node scripts/stress-test-reference-catalog.cjs \
 *     "path/to/Bowman_2022_2026_Pricing_Stress_Test.xlsx"
 *
 * Output:
 *   backend/data/stress-test-<YYYY-MM-DD>.json      (machine)
 *   Human-readable summary to stdout.
 *
 * Exit codes:
 *   0  test ran (regardless of gap count)
 *   1  Cosmos read failed / workbook parse failed / config missing
 */

const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const { CosmosClient } = require("@azure/cosmos");

function slug(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’‘"`]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const [xlsxPath] = process.argv.slice(2);
  if (!xlsxPath) {
    console.error("Usage: node stress-test-reference-catalog.cjs <path-to-xlsx>");
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error("File not found:", xlsxPath);
    process.exit(1);
  }
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    console.error("COSMOS_CONNECTION_STRING not set. Pull from HobbyIQ3.");
    process.exit(1);
  }

  console.log(`[stress-test] reading workbook: ${xlsxPath}`);
  const wb = XLSX.readFile(xlsxPath);
  const cards = XLSX.utils.sheet_to_json(wb.Sheets["Cards"] ?? wb.Sheets[wb.SheetNames[0]]);
  console.log(`[stress-test] loaded ${cards.length} test cards`);

  // Build unique (productKey, year, parallel, auto) tuples from the workbook.
  const tuples = new Map(); // key -> { productKey, year, parallel, auto, workbookRun, sampleCount }
  for (const c of cards) {
    const year = Number(c.Year);
    const productRaw = String(c.Set ?? "").trim();
    const parallelRaw = String(c.Parallel ?? "").trim();
    const autoStr = String(c["Auto Y/N"] ?? "").trim().toUpperCase();
    const auto = autoStr === "Y" || autoStr === "YES";
    const serialRaw = c["Serial Number"];
    const workbookRun =
      serialRaw !== undefined && serialRaw !== null && String(serialRaw).trim() !== ""
        ? Number(String(serialRaw).replace(/[^0-9]/g, ""))
        : null;
    if (!year || !productRaw || !parallelRaw) continue;
    const productKey = slug(productRaw);
    const parallelKey = slug(parallelRaw);
    const tupleKey = `${productKey}|${year}|${parallelKey}|${auto}`;
    const existing = tuples.get(tupleKey);
    if (existing) {
      existing.sampleCount++;
    } else {
      tuples.set(tupleKey, {
        productKey,
        year,
        product: productRaw,
        parallel: parallelRaw,
        parallelKey,
        auto,
        workbookRun: Number.isFinite(workbookRun) ? workbookRun : null,
        sampleCount: 1,
      });
    }
  }
  console.log(`[stress-test] ${tuples.size} unique (productKey, year, parallel, auto) tuples\n`);

  // Query Cosmos for every parallel doc in Bowman-family productKeys 2022-2026.
  const client = new CosmosClient(connStr);
  const container = client.database("hobbyiq").container("reference-catalog");

  const uniqueProductKeys = new Set([...tuples.values()].map((t) => t.productKey));
  const cosmosDocs = [];
  // Year range derived from workbook — no hardcoded years (was 2022-2026,
  // broke on Topps 2020-2021 rows).
  const yearMin = Math.min(...[...tuples.values()].map((t) => t.year));
  const yearMax = Math.max(...[...tuples.values()].map((t) => t.year));
  for (const pk of uniqueProductKeys) {
    const { resources } = await container.items
      .query({
        query:
          "SELECT * FROM c WHERE c.productKey = @pk AND c.docType = 'parallel' AND c.year >= @ymin AND c.year <= @ymax",
        parameters: [
          { name: "@pk", value: pk },
          { name: "@ymin", value: yearMin },
          { name: "@ymax", value: yearMax },
        ],
      })
      .fetchAll();
    cosmosDocs.push(...resources);
  }
  console.log(`[stress-test] Cosmos returned ${cosmosDocs.length} parallel docs across ${uniqueProductKeys.size} productKeys`);

  // Index Cosmos by (productKey, year, parallelKey, auto).
  const cosmosIndex = new Map();
  for (const d of cosmosDocs) {
    const key = `${d.productKey}|${d.year}|${d.parallelKey}|${d.auto}`;
    const bucket = cosmosIndex.get(key);
    if (bucket) bucket.push(d);
    else cosmosIndex.set(key, [d]);
  }

  // Also index with auto-flag-agnostic key for a softer match.
  const cosmosIndexNoAuto = new Map();
  for (const d of cosmosDocs) {
    const key = `${d.productKey}|${d.year}|${d.parallelKey}`;
    const bucket = cosmosIndexNoAuto.get(key);
    if (bucket) bucket.push(d);
    else cosmosIndexNoAuto.set(key, [d]);
  }

  // Classify each tuple.
  const resolveMisses = [];
  const printRunMismatches = [];
  const softMatches = []; // matched parallelKey but wrong auto flag
  let exactHits = 0;

  for (const t of tuples.values()) {
    const strictKey = `${t.productKey}|${t.year}|${t.parallelKey}|${t.auto}`;
    const softKey = `${t.productKey}|${t.year}|${t.parallelKey}`;
    const strictHits = cosmosIndex.get(strictKey);
    if (strictHits && strictHits.length > 0) {
      exactHits++;
      // Print-run comparison.
      const cosmosRun = strictHits[0].printRun;
      if (
        t.workbookRun !== null &&
        cosmosRun !== null &&
        cosmosRun !== undefined &&
        cosmosRun !== t.workbookRun
      ) {
        printRunMismatches.push({
          productKey: t.productKey,
          year: t.year,
          parallel: t.parallel,
          auto: t.auto,
          workbookRun: t.workbookRun,
          cosmosRun,
          delta: cosmosRun - t.workbookRun,
          sampleCount: t.sampleCount,
        });
      }
    } else {
      const softHits = cosmosIndexNoAuto.get(softKey);
      if (softHits && softHits.length > 0) {
        softMatches.push({
          productKey: t.productKey,
          year: t.year,
          parallel: t.parallel,
          workbookAuto: t.auto,
          cosmosAutos: softHits.map((d) => d.auto),
          sampleCount: t.sampleCount,
        });
      } else {
        resolveMisses.push({
          productKey: t.productKey,
          year: t.year,
          parallel: t.parallel,
          parallelKey: t.parallelKey,
          auto: t.auto,
          workbookRun: t.workbookRun,
          sampleCount: t.sampleCount,
        });
      }
    }
  }

  // Aggregate by (product, year) for headline gaps.
  const gapsByProductYear = new Map();
  for (const m of resolveMisses) {
    const key = `${m.productKey}|${m.year}`;
    const bucket = gapsByProductYear.get(key) ?? { productKey: m.productKey, year: m.year, missingParallels: [] };
    bucket.missingParallels.push(m.parallel + (m.auto ? " (auto)" : ""));
    gapsByProductYear.set(key, bucket);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    workbook: path.basename(xlsxPath),
    workbookCards: cards.length,
    uniqueTuples: tuples.size,
    exactHits,
    softMatches: softMatches.length,
    resolveMisses: resolveMisses.length,
    printRunMismatches: printRunMismatches.length,
    coveragePct: Math.round((100 * exactHits) / tuples.size),
    gapsByProductYear: [...gapsByProductYear.values()],
    resolveMissesDetail: resolveMisses,
    printRunMismatchesDetail: printRunMismatches,
    softMatchesDetail: softMatches,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `stress-test-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("\n=== STRESS TEST SUMMARY ===");
  console.log(`workbook cards:          ${summary.workbookCards}`);
  console.log(`unique tuples:           ${summary.uniqueTuples}`);
  console.log(`exact hits:              ${summary.exactHits} (${summary.coveragePct}%)`);
  console.log(`soft (auto-mismatch):    ${summary.softMatches}`);
  console.log(`RESOLVE MISSES:          ${summary.resolveMisses}  ← ladder can't fire`);
  console.log(`PRINT-RUN MISMATCHES:    ${summary.printRunMismatches}  ← calibration drift`);
  console.log(`\nartifact: ${outPath}`);

  if (summary.resolveMisses > 0) {
    console.log("\n=== TOP RESOLVE MISSES (by sample count) ===");
    const sorted = [...resolveMisses].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 15);
    for (const m of sorted) {
      console.log(`  ${m.productKey} ${m.year} "${m.parallel}"${m.auto ? " (auto)" : ""} — ${m.sampleCount} cards affected`);
    }
  }

  if (summary.softMatches > 0) {
    console.log("\n=== SOFT MATCHES (parallel exists but auto flag disagrees) ===");
    for (const s of softMatches.slice(0, 10)) {
      console.log(`  ${s.productKey} ${s.year} "${s.parallel}" — workbook auto=${s.workbookAuto}, cosmos autos=[${s.cosmosAutos.join(",")}]`);
    }
  }

  if (summary.printRunMismatches > 0) {
    console.log("\n=== PRINT-RUN MISMATCHES ===");
    const sorted = [...printRunMismatches].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15);
    for (const m of sorted) {
      console.log(`  ${m.productKey} ${m.year} "${m.parallel}"${m.auto ? " (auto)" : ""}: workbook=/${m.workbookRun} cosmos=/${m.cosmosRun} delta=${m.delta > 0 ? "+" : ""}${m.delta}`);
    }
  }

  console.log("\n=== GAPS BY (productKey, year) — where the ladder has NO coverage ===");
  const gapsSorted = [...gapsByProductYear.values()].sort((a, b) => b.missingParallels.length - a.missingParallels.length);
  for (const g of gapsSorted.slice(0, 15)) {
    console.log(`  ${g.productKey} ${g.year} — ${g.missingParallels.length} missing: ${g.missingParallels.slice(0, 5).join(", ")}${g.missingParallels.length > 5 ? " ..." : ""}`);
  }
}

main().catch((e) => {
  console.error("[stress-test] fatal:", e.message ?? e);
  process.exit(1);
});
