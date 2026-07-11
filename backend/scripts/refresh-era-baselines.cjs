#!/usr/bin/env node
/**
 * CF-NO-NULL-PRICING PR 5 (2026-07-11, Drew).
 *
 * Daily refresh job for the `era-baselines` Cosmos container.
 *
 * For every (productKey, year, cardClass) bucket the reference-catalog
 * container carries a ParallelDoc for, this job:
 *
 *   1. Queries CH for all comps in the bucket (product + year, cross-
 *      player, cross-parallel) via fetchCompsByPlayer with empty
 *      playerName.
 *   2. Calls computeEraBaselineForBucket to produce the recency-weighted
 *      currentValue + 7-day predictedValue + trend direction.
 *   3. Batches and bulk-upserts the result to the era-baselines container.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." \
 *   CARD_HEDGE_API_KEY="..." \
 *   node backend/scripts/refresh-era-baselines.cjs [--dry-run] [--limit=N]
 *
 * Flags:
 *   --dry-run       — compute + report but do not write to Cosmos
 *   --limit=N       — process only the first N buckets (smoke test)
 *   --product=<pk>  — restrict to a single productKey (targeted refresh)
 *
 * Exit codes:
 *   0  every bucket processed (regardless of individual write outcome)
 *   1  Cosmos read/write failure / CH auth failure / bad usage
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  // Load compiled dist output.
  const distCompute = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "compiq",
    "eraBaselineCompute.js",
  );
  const distRepo = path.resolve(
    __dirname,
    "..",
    "dist",
    "repositories",
    "eraBaselines.repository.js",
  );
  const distCatalog = path.resolve(
    __dirname,
    "..",
    "dist",
    "repositories",
    "referenceCatalog.repository.js",
  );
  const distComps = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "compiq",
    "compsByPlayer.service.js",
  );

  let computeEraBaselineForBucket, bulkUpsertEraBaselines, fetchCompsByPlayer;
  try {
    ({ computeEraBaselineForBucket } = await import(pathToFileURL(distCompute).href));
    ({ bulkUpsertEraBaselines } = await import(pathToFileURL(distRepo).href));
    ({ fetchCompsByPlayer } = await import(pathToFileURL(distComps).href));
  } catch (err) {
    console.error("Cannot find dist output — run `npm run build` first.");
    console.error(err.message);
    process.exit(1);
  }

  // Direct Cosmos query for bucket enumeration (avoids TS build friction).
  const { CosmosClient } = require("@azure/cosmos");
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_REFERENCE_CATALOG_CONTAINER ?? "reference-catalog");

  // Enumerate unique (productKey, year) tuples that have at least one
  // ParallelDoc — those are the buckets worth computing baselines for.
  console.log("[refresh] enumerating buckets from reference-catalog...");
  let query =
    "SELECT DISTINCT c.productKey, c.year, c.product FROM c WHERE c.docType = 'parallel'";
  if (args.product) {
    query += ` AND c.productKey = '${args.product.replace(/'/g, "")}'`;
  }
  const { resources: bucketRows } = await container.items
    .query({ query })
    .fetchAll();
  console.log(`[refresh] found ${bucketRows.length} unique (productKey, year) tuples`);

  // Expand to (productKey, year, cardClass) — two classes per tuple.
  const buckets = [];
  for (const b of bucketRows) {
    if (!b.productKey || !b.year || !b.product) continue;
    for (const cardClass of ["base", "auto"]) {
      buckets.push({ ...b, cardClass });
    }
  }
  const bucketsToProcess = args.limit ? buckets.slice(0, args.limit) : buckets;
  console.log(
    `[refresh] processing ${bucketsToProcess.length}/${buckets.length} buckets` +
      (args.dryRun ? " (dry-run: no writes)" : ""),
  );

  const now = new Date().toISOString();
  const docs = [];
  const summary = { computed: 0, skipped: 0, errors: 0 };
  let processed = 0;

  for (const bucket of bucketsToProcess) {
    processed++;
    if (processed % 25 === 0) {
      console.log(
        `[refresh] progress ${processed}/${bucketsToProcess.length} — ${summary.computed} computed, ${summary.skipped} skipped`,
      );
    }
    try {
      const pool = await fetchCompsByPlayer({
        playerName: "",
        product: bucket.product,
        cardYear: bucket.year,
      });
      // CF-ERA-BASELINES-FIELD-NAME-FIX (2026-07-11, Drew — Padparadscha
      // smoke-test followup): fetchCompsByPlayer returns CompByPlayer[]
      // where each row has `.date` (see compsByPlayer.service.ts:263).
      // Original script read `.saleDate ?? .dateOfSale` — both undefined,
      // so `.filter((c) => c.saleDate)` dropped 100% of comps and the
      // 11:05 UTC daily-refresh run computed 0 out of 1630 buckets (log
      // in run 29150385040). Read the field the interface actually emits.
      const comps = (pool?.comps ?? [])
        .filter((c) => Number.isFinite(c.price) && c.price > 0)
        .map((c) => ({ price: c.price, saleDate: c.date }))
        .filter((c) => c.saleDate);
      if (comps.length < 3) {
        summary.skipped++;
        continue;
      }
      const doc = computeEraBaselineForBucket({
        productKey: bucket.productKey,
        year: bucket.year,
        cardClass: bucket.cardClass,
        comps,
        now,
      });
      if (!doc) {
        summary.skipped++;
        continue;
      }
      summary.computed++;
      docs.push(doc);
    } catch (err) {
      summary.errors++;
      console.warn(
        `[refresh] bucket ${bucket.productKey} ${bucket.year} ${bucket.cardClass} failed:`,
        err.message,
      );
    }
  }

  console.log(`\n[refresh] compute summary:`);
  console.log(`  computed:  ${summary.computed}`);
  console.log(`  skipped:   ${summary.skipped} (fewer than 3 comps)`);
  console.log(`  errors:    ${summary.errors}`);

  if (args.dryRun) {
    console.log(`\n[refresh] dry-run: skipping writes. Sample doc:`);
    if (docs.length > 0) console.log(JSON.stringify(docs[0], null, 2));
    process.exit(0);
  }

  if (docs.length === 0) {
    console.log("[refresh] no docs to write. exiting.");
    process.exit(0);
  }

  console.log(`\n[refresh] upserting ${docs.length} docs to era-baselines...`);
  const outcome = await bulkUpsertEraBaselines(docs);
  console.log(`  succeeded: ${outcome.succeeded}`);
  console.log(`  failed:    ${outcome.failed}`);
  if (outcome.errors.length > 0) {
    console.log(`  first errors:`);
    for (const e of outcome.errors.slice(0, 5)) {
      console.log(`    ${e.id}: ${e.message}`);
    }
  }

  process.exit(outcome.failed > 0 ? 1 : 0);
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, product: null };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--product=")) args.product = a.slice(10);
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
