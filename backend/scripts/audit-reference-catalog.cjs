#!/usr/bin/env node
/**
 * CF-REFERENCE-CATALOG-AUDIT (2026-07-10, Drew — Phase 5 sanity gate).
 *
 * Reads every ParallelDoc + SetDoc out of the Cosmos reference-catalog
 * container and produces a triage-priority audit:
 *
 *   * Per-productKey rollup: total rows, confidence distribution
 *     (Verified/High/Medium), auto/base split, print-run tier
 *     distribution (/1, /5, /10, /25, /50, /75, /99, /150, /299, /500+,
 *     null-numbered, unnumbered).
 *
 *   * Anomalies:
 *       A1  numbered=true AND printRun=null AND !runVaries AND !perCardRun
 *           (should be flagged one of those two, or have a real number)
 *       A2  auto=true + printRun=null (autos are ~always numbered)
 *       A3  runVaries=true + numbered=false (contradiction)
 *       A4  perCardRun=true + printRun!=null (perCardRun forces null; ingest
 *           does the coercion so this should not fire, but it's the
 *           post-ingest invariant check)
 *       A5  parallelKey collision within (productKey, year) —
 *           two ParallelDocs sharing same slug but different rows
 *       A6  printRun=0 or negative (should never exist)
 *
 * Output:
 *   * Machine-readable JSON at
 *     backend/data/reference-catalog-audit-<YYYY-MM-DD>.json
 *   * Human-readable summary to stdout
 *
 * Runbook:
 *   $env:COSMOS_CONNECTION_STRING = "..."  # pull from HobbyIQ3 app settings
 *   node backend/scripts/audit-reference-catalog.cjs
 *
 * Exit codes:
 *   0  audit ran + wrote artifact (regardless of anomaly count)
 *   1  Cosmos read failed / config missing
 */

const fs = require("node:fs");
const path = require("node:path");
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const connStr = process.env.COSMOS_CONNECTION_STRING;
  if (!connStr) {
    console.error("COSMOS_CONNECTION_STRING not set. Pull from HobbyIQ3.");
    process.exit(1);
  }
  const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
  const containerName =
    process.env.COSMOS_REFERENCE_CATALOG_CONTAINER ?? "reference-catalog";

  const client = new CosmosClient(connStr);
  const container = client.database(dbName).container(containerName);

  console.log(`[audit] reading ${dbName}/${containerName} ...`);
  const parallels = [];
  const sets = [];
  const iter = container.items.query({ query: "SELECT * FROM c" });
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    for (const doc of page.resources ?? []) {
      if (doc.docType === "parallel") parallels.push(doc);
      else if (doc.docType === "set") sets.push(doc);
    }
  }
  console.log(`[audit] read ${parallels.length} parallels + ${sets.length} sets`);

  const perProductKey = new Map();
  const anomalies = [];

  for (const d of parallels) {
    let rollup = perProductKey.get(d.productKey);
    if (!rollup) {
      rollup = {
        productKey: d.productKey,
        product: d.product,
        total: 0,
        confidence: { Verified: 0, High: 0, Medium: 0 },
        auto: { true: 0, false: 0 },
        licensed: { true: 0, false: 0 },
        printRunTiers: {
          "/1": 0, "/5": 0, "/10": 0, "/25": 0, "/50": 0,
          "/75": 0, "/99": 0, "/150": 0, "/299": 0, "/500+": 0,
          "runVaries": 0, "perCardRun": 0, "unnumbered": 0, "other": 0,
        },
        yearRange: { min: Infinity, max: -Infinity },
      };
      perProductKey.set(d.productKey, rollup);
    }
    rollup.total++;
    rollup.confidence[d.confidence] = (rollup.confidence[d.confidence] ?? 0) + 1;
    rollup.auto[d.auto ? "true" : "false"]++;
    rollup.licensed[d.licensed ? "true" : "false"]++;
    rollup.yearRange.min = Math.min(rollup.yearRange.min, d.year);
    rollup.yearRange.max = Math.max(rollup.yearRange.max, d.year);

    // Tier bucket
    let tier;
    if (d.runVaries) tier = "runVaries";
    else if (d.perCardRun) tier = "perCardRun";
    else if (!d.numbered) tier = "unnumbered";
    else if (d.printRun === 1) tier = "/1";
    else if (d.printRun && d.printRun <= 5) tier = "/5";
    else if (d.printRun && d.printRun <= 10) tier = "/10";
    else if (d.printRun && d.printRun <= 25) tier = "/25";
    else if (d.printRun && d.printRun <= 50) tier = "/50";
    else if (d.printRun && d.printRun <= 75) tier = "/75";
    else if (d.printRun && d.printRun <= 99) tier = "/99";
    else if (d.printRun && d.printRun <= 150) tier = "/150";
    else if (d.printRun && d.printRun <= 299) tier = "/299";
    else if (d.printRun && d.printRun >= 500) tier = "/500+";
    else tier = "other";
    rollup.printRunTiers[tier]++;

    // Anomalies
    if (d.numbered && d.printRun === null && !d.runVaries && !d.perCardRun) {
      anomalies.push({ type: "A1", id: d.id, productKey: d.productKey, year: d.year, parallel: d.parallel, reason: "numbered=true but printRun=null and neither runVaries nor perCardRun" });
    }
    if (d.auto && d.printRun === null && !d.runVaries && !d.perCardRun) {
      anomalies.push({ type: "A2", id: d.id, productKey: d.productKey, year: d.year, parallel: d.parallel, reason: "auto=true + printRun=null (autographs are typically numbered)" });
    }
    if (d.runVaries && !d.numbered) {
      anomalies.push({ type: "A3", id: d.id, productKey: d.productKey, year: d.year, parallel: d.parallel, reason: "runVaries=true but numbered=false" });
    }
    if (d.perCardRun && d.printRun !== null) {
      anomalies.push({ type: "A4", id: d.id, productKey: d.productKey, year: d.year, parallel: d.parallel, reason: "perCardRun=true but printRun is non-null (ingest should have coerced to null)" });
    }
    if (typeof d.printRun === "number" && d.printRun <= 0) {
      anomalies.push({ type: "A6", id: d.id, productKey: d.productKey, year: d.year, parallel: d.parallel, reason: `printRun=${d.printRun} (must be positive)` });
    }
  }

  // A5: parallelKey collision within (productKey, year, auto, cardSet).
  // Auto+base of the same-name parallel is EXPECTED (e.g. "Gold Refractor"
  // exists as both a base card and an autograph), and different card sets
  // within a product legitimately reuse parallel names ("Blue Refractor"
  // appears in both Chrome Prospects and Chrome flagship the same year).
  // Only same-(product, year, cardSet, parallel, auto) rows are real dups.
  const parallelKeyIndex = new Map();
  for (const d of parallels) {
    const key = `${d.productKey}|${d.year}|${d.cardSetKey}|${d.parallelKey}|${d.auto}`;
    const bucket = parallelKeyIndex.get(key);
    if (bucket) bucket.push(d);
    else parallelKeyIndex.set(key, [d]);
  }
  for (const [key, bucket] of parallelKeyIndex) {
    if (bucket.length > 1) {
      anomalies.push({
        type: "A5",
        key,
        count: bucket.length,
        productKey: bucket[0].productKey,
        year: bucket[0].year,
        cardSet: bucket[0].cardSet,
        parallel: bucket[0].parallel,
        auto: bucket[0].auto,
        reason: `${bucket.length} rows share (productKey, year, cardSet, parallel, auto)`,
        printRuns: bucket.map((d) => d.printRun),
        ids: bucket.map((d) => d.id),
      });
    }
  }

  // Sort productKeys by triage priority: highest Medium-confidence count first
  const rollupSorted = [...perProductKey.values()].sort((a, b) => {
    const aMed = a.confidence.Medium;
    const bMed = b.confidence.Medium;
    if (aMed !== bMed) return bMed - aMed;
    return b.total - a.total;
  });

  const audit = {
    generatedAt: new Date().toISOString(),
    totals: {
      parallels: parallels.length,
      sets: sets.length,
      productKeys: perProductKey.size,
      anomalies: anomalies.length,
      confidence: {
        Verified: parallels.filter((d) => d.confidence === "Verified").length,
        High: parallels.filter((d) => d.confidence === "High").length,
        Medium: parallels.filter((d) => d.confidence === "Medium").length,
      },
    },
    triagePriority: rollupSorted.slice(0, 20).map((r) => ({
      productKey: r.productKey,
      product: r.product,
      total: r.total,
      mediumRows: r.confidence.Medium,
      mediumPct: Math.round((100 * r.confidence.Medium) / r.total),
    })),
    anomalies,
    perProductKey: rollupSorted,
  };

  // Persist
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `reference-catalog-audit-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2), "utf8");
  console.log(`\n[audit] wrote ${outPath}`);

  // Human-readable summary
  console.log("\n=== REFERENCE-CATALOG AUDIT SUMMARY ===");
  console.log(`  parallels:            ${audit.totals.parallels}`);
  console.log(`  sets:                 ${audit.totals.sets}`);
  console.log(`  productKeys:          ${audit.totals.productKeys}`);
  console.log(`  Verified rows:        ${audit.totals.confidence.Verified} (${Math.round(100*audit.totals.confidence.Verified/audit.totals.parallels)}%)`);
  console.log(`  High rows:            ${audit.totals.confidence.High} (${Math.round(100*audit.totals.confidence.High/audit.totals.parallels)}%)`);
  console.log(`  Medium rows:          ${audit.totals.confidence.Medium} (${Math.round(100*audit.totals.confidence.Medium/audit.totals.parallels)}%)`);
  console.log(`  anomalies:            ${audit.totals.anomalies}`);
  if (anomalies.length > 0) {
    const byType = {};
    for (const a of anomalies) byType[a.type] = (byType[a.type] ?? 0) + 1;
    for (const [t, c] of Object.entries(byType)) console.log(`    ${t}: ${c}`);
  }
  console.log("\n=== TOP-20 productKeys BY MEDIUM-CONFIDENCE ROW COUNT ===");
  console.log("  (highest triage priority — verify these first)");
  console.log("  productKey                            total  medium  pct");
  for (const r of audit.triagePriority) {
    console.log(`  ${r.productKey.padEnd(38)} ${String(r.total).padStart(4)}   ${String(r.mediumRows).padStart(4)}  ${String(r.mediumPct).padStart(3)}%`);
  }
}

main().catch((err) => {
  console.error("[audit] fatal:", err.message ?? err);
  process.exit(1);
});
