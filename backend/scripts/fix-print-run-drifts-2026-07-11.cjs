#!/usr/bin/env node
/**
 * CF-PRINT-RUN-DRIFT-FIX (2026-07-11, Drew — stress test v2 followup).
 *
 * The reference-catalog stress test on 2026-07-11 flagged 6 print-run
 * mismatches between the workbook and the shipped Cosmos ParallelDocs
 * (backend/data/stress-test-2026-07-11.json). Ledger comment in
 * scripts/build-stress-test-v2.cjs identifies the correct value on a
 * per-year basis. This migration corrects the 3 rows where Cosmos is
 * confidently wrong (leaving 3 rows where the workbook is wrong and
 * Cosmos is right):
 *
 *   bowman/2026        Purple Pattern      /250 → /199
 *   bowman-chrome/2024 Fuchsia Refractor   /299 → /199
 *   bowman-chrome/2025 Rose Gold Refractor /15  → /10
 *
 * Idempotent: reads current printRun first, no-ops if it doesn't match
 * the expected "before" value. Safe to re-run.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/fix-print-run-drifts-2026-07-11.cjs [--dry-run]
 *
 * Exit codes:
 *   0  every drift already fixed OR (with writes enabled) every drift
 *      successfully updated
 *   1  Cosmos error / doc missing / current printRun neither expected
 *      nor target (would require manual review)
 */

const { CosmosClient } = require("@azure/cosmos");

const DRIFTS = [
  {
    productKey: "bowman",
    year: 2026,
    parallelKey: "purple-pattern",
    before: 250,
    after: 199,
    reason: "stress-test-v2 ledger: Purple Pattern = /199",
  },
  {
    productKey: "bowman-chrome",
    year: 2024,
    parallelKey: "fuchsia-refractor",
    before: 299,
    after: 199,
    reason: "stress-test-v2 ledger: Fuchsia Refractor = /199",
  },
  {
    productKey: "bowman-chrome",
    year: 2025,
    parallelKey: "rose-gold-refractor",
    before: 15,
    after: 10,
    reason: "stress-test-v2 ledger: Rose Gold Refractor = /10",
  },
];

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container(process.env.COSMOS_REFERENCE_CATALOG_CONTAINER ?? "reference-catalog");

  const nowIso = new Date().toISOString();
  const summary = { alreadyCorrect: 0, updated: 0, wouldUpdate: 0, mismatched: 0, notFound: 0, errors: 0 };

  for (const drift of DRIFTS) {
    console.log(
      `\n▶ ${drift.productKey}/${drift.year} ${drift.parallelKey} — expect /${drift.before} → /${drift.after}`,
    );
    try {
      const { resources: docs } = await container.items
        .query({
          query:
            "SELECT * FROM c WHERE c.docType='parallel' AND c.productKey=@pk AND c.year=@y AND c.parallelKey=@pa",
          parameters: [
            { name: "@pk", value: drift.productKey },
            { name: "@y", value: drift.year },
            { name: "@pa", value: drift.parallelKey },
          ],
        })
        .fetchAll();

      if (docs.length === 0) {
        console.log("  ✗ NOT FOUND — no ParallelDoc matches (productKey, year, parallelKey)");
        summary.notFound++;
        continue;
      }

      for (const doc of docs) {
        const suffix = `[cardSet="${doc.cardSet}", auto=${doc.auto}]`;
        if (doc.printRun === drift.after) {
          console.log(`  ✓ already /${drift.after} ${suffix}`);
          summary.alreadyCorrect++;
          continue;
        }
        if (doc.printRun !== drift.before) {
          console.log(
            `  ⚠ MISMATCH — current printRun /${doc.printRun}, expected /${drift.before} or /${drift.after} ${suffix}`,
          );
          summary.mismatched++;
          continue;
        }
        if (dryRun) {
          console.log(`  → WOULD UPDATE /${drift.before} → /${drift.after} ${suffix}`);
          summary.wouldUpdate++;
          continue;
        }
        const updated = {
          ...doc,
          printRun: drift.after,
          notes:
            (doc.notes ?? "").trim().length > 0
              ? `${doc.notes} | ${drift.reason} (${nowIso.slice(0, 10)})`
              : `${drift.reason} (${nowIso.slice(0, 10)})`,
          updatedAt: nowIso,
        };
        await container.items.upsert(updated);
        console.log(`  ✓ UPDATED /${drift.before} → /${drift.after} ${suffix}`);
        summary.updated++;
      }
    } catch (err) {
      console.error(`  ✗ ERROR: ${err.message}`);
      summary.errors++;
    }
  }

  console.log("\n═══ SUMMARY ═══");
  console.log(`  already correct: ${summary.alreadyCorrect}`);
  if (dryRun) console.log(`  would update:    ${summary.wouldUpdate}`);
  else console.log(`  updated:         ${summary.updated}`);
  console.log(`  mismatched:      ${summary.mismatched}`);
  console.log(`  not found:       ${summary.notFound}`);
  console.log(`  errors:          ${summary.errors}`);
  process.exit(summary.errors > 0 || summary.notFound > 0 || summary.mismatched > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
