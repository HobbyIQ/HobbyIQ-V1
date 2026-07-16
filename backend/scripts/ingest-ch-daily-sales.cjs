#!/usr/bin/env node
/**
 * CF-CH-DAILY-EXPORT-INGEST (Drew, 2026-07-16).
 *
 * Standalone entry point for the daily CH bulk-export ingest. Runs from
 * the .github/workflows/ch-daily-sales-ingest.yml scheduled workflow;
 * safe to invoke manually for backfill / one-off dates.
 *
 * Runbook (local dry-run against yesterday's file):
 *
 *   COSMOS_CONNECTION_STRING="..." \
 *   CARD_HEDGE_API_KEY="..." \
 *   node backend/scripts/ingest-ch-daily-sales.cjs [--date=YYYY-MM-DD]
 *                                                   [--batch=N]
 *                                                   [--limit=N]
 *                                                   [--force]
 *
 * Flags:
 *   --date=YYYY-MM-DD   File date; defaults to yesterday UTC.
 *   --batch=N           Cosmos upsert batch size (default 500).
 *   --limit=N           Cap total rows processed (smoke test).
 *   --force             Ignore an existing checkpoint for this date and
 *                       re-ingest. Idempotent by price_history_id so
 *                       replay is safe.
 *
 * Exit codes:
 *   0  ingest completed OR skipped with a benign reason (checkpoint,
 *      404 = file not yet published)
 *   1  hard failure (bad flags, missing env, unrecoverable Cosmos error)
 */

const path = require("path");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.CARD_HEDGE_API_KEY) {
    console.error("CARD_HEDGE_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }

  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "src", "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }

  const { runDailySalesIngest } = require(
    path.join(distRoot, "src", "services", "portfolioiq", "chDailySalesIngest.service.js"),
  );

  const result = await runDailySalesIngest({
    fileDate: args.date,
    batchSize: args.batch,
    rowLimit: args.limit,
    skipIfCompleted: !args.force,
  });

  console.log(JSON.stringify({ event: "ingest_final_result", ...result }));

  // Benign skip conditions still exit 0 so the workflow doesn't flag red
  // for expected transient states (file not yet published, prior success).
  if (result.rowsFailed > 0 && result.rowsUpserted === 0) {
    console.error("all rows failed to upsert — exiting 1");
    process.exit(1);
  }
  process.exit(0);
}

function parseArgs(argv) {
  const out = { force: false };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a.startsWith("--date=")) out.date = a.slice(7);
    else if (a.startsWith("--batch=")) out.batch = Number(a.slice(8));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
  }
  return out;
}

async function pathExists(p) {
  try {
    const fs = require("fs/promises");
    await fs.access(p);
    return true;
  } catch { return false; }
}

main().catch((err) => {
  console.error(JSON.stringify({
    event: "ingest_fatal",
    error: (err && err.message) || String(err),
    stack: (err && err.stack) || null,
  }));
  process.exit(1);
});
