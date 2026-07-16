#!/usr/bin/env node
/**
 * CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4 execution pack).
 *
 * Ingest one or more of the Phase 1 reference workbooks into the Cosmos
 * `reference-catalog` container. Idempotent (deterministic ids), so
 * re-runs upsert-in-place with zero net delta when nothing changed.
 *
 * Runbook:
 *
 *   COSMOS_CONNECTION_STRING="..." \
 *     node backend/scripts/ingest-reference.cjs \
 *     backend/data/reference/bowman_parallels_1989_2026.xlsx \
 *     backend/data/reference/topps_parallels_1951_2026.xlsx
 *
 * Or use --format=sets for the vintage-set-catalog workbook:
 *
 *   node backend/scripts/ingest-reference.cjs \
 *     --format=sets \
 *     backend/data/reference/vintage_set_catalog_1887_1988.xlsx
 *
 * Flags:
 *   --dry-run       — parse + validate, do NOT write to Cosmos
 *   --format=<f>    — "parallels" (default) or "sets"
 *   --strict        — abort on any skipped row (default: warn + continue)
 *
 * Exit codes:
 *   0  every file parsed AND (dry-run OR read-back count reconciled)
 *   1  parse failed / row-count parity failed / cosmos write failed
 *   2  bad CLI usage
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.files.length === 0) {
    console.error("Usage: ingest-reference.cjs [--dry-run] [--format=parallels|sets] [--strict] <file.xlsx> [more.xlsx...]");
    process.exit(2);
  }

  // Load compiled dist output.
  const distParser = path.resolve(__dirname, "..", "dist", "services", "reference", "referenceParser.js");
  const distRepo = path.resolve(__dirname, "..", "dist", "repositories", "referenceCatalog.repository.js");
  let parseParallelsWorkbook, parseSetsWorkbook, bulkUpsertReferenceDocs, countDocsByProductKey;
  try {
    ({ parseParallelsWorkbook, parseSetsWorkbook } = await import(pathToFileURL(distParser).href));
    ({ bulkUpsertReferenceDocs, countDocsByProductKey } = await import(pathToFileURL(distRepo).href));
  } catch (err) {
    console.error("Cannot find dist output — run `npm run build` first.");
    console.error(err.message);
    process.exit(1);
  }

  let totalDocs = 0;
  let totalSkipped = 0;
  let anyFailure = false;
  const perProductKeyExpected = new Map();

  for (const filePath of args.files) {
    if (!fs.existsSync(filePath)) {
      console.error(`[ingest-reference] file not found: ${filePath}`);
      anyFailure = true;
      continue;
    }
    console.log(`\n[ingest-reference] parsing ${filePath} ...`);
    const buf = fs.readFileSync(filePath);
    let result;
    if (args.format === "sets") {
      result = parseSetsWorkbook(buf);
    } else {
      result = parseParallelsWorkbook(buf);
    }
    const { docs, sheetRowCount, skipped } = result;
    console.log(
      `  → ${docs.length} docs from ${sheetRowCount} sheet rows (${skipped} skipped)`,
    );
    if (args.strict && skipped > 0) {
      console.error(`  --strict violated: ${skipped} rows dropped from ${filePath}`);
      anyFailure = true;
      continue;
    }
    // Track per-productKey expected count for the read-back gate.
    for (const doc of docs) {
      perProductKeyExpected.set(
        doc.productKey,
        (perProductKeyExpected.get(doc.productKey) ?? 0) + 1,
      );
    }
    totalDocs += docs.length;
    totalSkipped += skipped;

    if (args.dryRun) {
      console.log(`  [dry-run] not writing to Cosmos.`);
      continue;
    }
    console.log(`  writing ${docs.length} docs to Cosmos...`);
    const outcome = await bulkUpsertReferenceDocs(docs);
    console.log(
      `  outcome: ${outcome.succeeded} ok, ${outcome.failed} failed`,
    );
    if (outcome.failed > 0) {
      anyFailure = true;
      // Log up to first 5 errors for triage; a batch failure would
      // otherwise be one line per doc.
      for (const e of outcome.errors.slice(0, 5)) {
        console.error(`    err ${e.id}: ${e.message}`);
      }
      if (outcome.errors.length > 5) {
        console.error(`    ... (+${outcome.errors.length - 5} more errors)`);
      }
    }
  }

  console.log(`\n[ingest-reference] totals: ${totalDocs} docs, ${totalSkipped} skipped`);

  if (!args.dryRun && !anyFailure) {
    // Read-back reconciliation — spot-check that Cosmos actually has the
    // count we wrote per productKey. Catches silent-partial-writes.
    console.log(`\n[ingest-reference] verifying Cosmos counts per productKey...`);
    for (const [pk, expected] of perProductKeyExpected) {
      const actual = await countDocsByProductKey(pk);
      const ok = actual !== null && actual >= expected;
      console.log(`  ${pk}: expected=${expected} actual=${actual} ${ok ? "OK" : "MISMATCH"}`);
      if (!ok) anyFailure = true;
    }
  }

  process.exit(anyFailure ? 1 : 0);
}

function parseArgs(argv) {
  const args = { files: [], dryRun: false, format: "parallels", strict: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--strict") args.strict = true;
    else if (a.startsWith("--format=")) args.format = a.slice("--format=".length);
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else args.files.push(a);
  }
  if (args.format !== "parallels" && args.format !== "sets") {
    console.error(`--format must be "parallels" or "sets" (got: ${args.format})`);
    process.exit(2);
  }
  return args;
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
