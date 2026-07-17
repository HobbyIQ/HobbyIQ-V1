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
 * BACKFILL mode (CF-CH-DAILY-EXPORT-BACKFILL, 2026-07-16):
 *
 *   node backend/scripts/ingest-ch-daily-sales.cjs --backfill-days=90
 *
 *   Iterates from today-1 backward for N days. Skip-if-completed remains
 *   ON so re-runs cheaply resume where the last run left off. Individual
 *   day 404s (file not yet published for that date) are logged and
 *   counted, not fatal. Each day's ingest is idempotent per
 *   price_history_id, so no dedupe risk on replay.
 *
 * Flags:
 *   --date=YYYY-MM-DD    Single file date; defaults to yesterday UTC.
 *                        Ignored if --backfill-days is set.
 *   --backfill-days=N    Ingest the last N days ending today-1.
 *                        Overrides --date.
 *   --batch=N            Cosmos upsert batch size (default 500).
 *   --limit=N            Cap total rows processed (smoke test; single-
 *                        day only, ignored in backfill mode).
 *   --force              Ignore existing checkpoints and re-ingest.
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

  // tsconfig has rootDir=src, outDir=dist → src/services/foo.ts compiles
  // to dist/services/foo.js (NOT dist/src/services/foo.js). Prior version
  // of this check assumed the nested layout and failed at runtime.
  const distRoot = path.resolve(__dirname, "..", "dist");
  const useCompiled = await pathExists(path.join(distRoot, "services"));
  if (!useCompiled) {
    console.error("backend/dist not found — run `npm run build` first");
    process.exit(1);
  }

  const { runDailySalesIngest } = require(
    path.join(distRoot, "services", "portfolioiq", "chDailySalesIngest.service.js"),
  );

  // Backfill mode: iterate over N calendar days ending yesterday UTC.
  if (args.backfillDays && args.backfillDays > 0) {
    const days = Math.min(365, args.backfillDays);
    const dates = [];
    const now = new Date();
    for (let i = 1; i <= days; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    console.log(JSON.stringify({
      event: "backfill_start",
      days: dates.length,
      first: dates[0],
      last: dates[dates.length - 1],
    }));

    let totalUpserted = 0;
    let totalFiltered = 0;
    let totalFailed = 0;
    let daysSkipped404 = 0;
    let daysSkippedCheckpoint = 0;
    let daysIngested = 0;
    let firstError = null;

    for (const date of dates) {
      let res;
      try {
        res = await runDailySalesIngest({
          fileDate: date,
          batchSize: args.batch,
          skipIfCompleted: !args.force,
        });
      } catch (err) {
        console.error(JSON.stringify({
          event: "backfill_day_error",
          date,
          error: (err && err.message) || String(err),
        }));
        if (!firstError) firstError = (err && err.message) || String(err);
        continue;
      }
      totalUpserted += res.rowsUpserted;
      totalFiltered += res.rowsFiltered || 0;
      totalFailed += res.rowsFailed;
      if (res.skipped) {
        if (res.skipReason === "checkpoint_exists") daysSkippedCheckpoint++;
        else if ((res.httpStatus ?? 0) === 404) daysSkipped404++;
      } else {
        daysIngested++;
      }
      if (res.firstError && !firstError) firstError = res.firstError;
    }

    console.log(JSON.stringify({
      event: "backfill_complete",
      daysRequested: dates.length,
      daysIngested,
      daysSkippedCheckpoint,
      daysSkipped404,
      totalRowsUpserted: totalUpserted,
      totalRowsFiltered: totalFiltered,
      totalRowsFailed: totalFailed,
      firstError,
    }));

    // Backfill returns 0 as long as at least ONE day succeeded — total
    // failure is a bad-config signal.
    if (daysIngested === 0 && daysSkippedCheckpoint === 0) {
      console.error("backfill made no progress on any day — exiting 1");
      process.exit(1);
    }
    process.exit(0);
  }

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
    else if (a.startsWith("--backfill-days=")) out.backfillDays = Number(a.slice(16));
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
