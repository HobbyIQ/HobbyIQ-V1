#!/usr/bin/env node
/**
 * CF-CH-HISTORICAL-BACKFILL (Drew, 2026-08-14).
 *
 * Walks CardHedge's per-day CSV export forward from the retention
 * cutoff, streaming each day into sold_comps via recordSoldComp.
 * Runs from .github/workflows/ch-historical-backfill.yml; safe to run
 * by hand.
 *
 * Resumable for real: the cursor is a Cosmos doc advanced only after a
 * day completes end-to-end. Kill it at any point and the next run picks
 * up on the following day. (The older bulk-import script claimed a
 * checkpoint in its header but only printed a date for an operator to
 * re-pass by hand — that does not survive an unattended run.)
 *
 * MEASURED FACTS (2026-08-14, live probes — do not re-derive by guess):
 *   - Retention cutoff is 2025-01-01. 2024-12-31 and older return 500.
 *     Boundary verified monotonic 3 days each side.
 *   - A daily file is ~75% its own day's sales plus a decaying tail of
 *     late-arriving sales reaching back ~3 years (2025-12-01 carried
 *     1,083 distinct sale_dates). soldAt therefore comes from each
 *     row's own sale_date, never from the file date.
 *   - Volume per file: ~30.6K (2025-01-02), ~19.3K (2025-06-15),
 *     ~43.2K (2025-12-01). Roughly 67% survive the 5-sport filter;
 *     Pokemon alone is ~28% of a file.
 *
 * Usage:
 *
 *   COSMOS_CONNECTION_STRING="..." CARD_HEDGE_API_KEY="..." \
 *   node backend/scripts/backfill-ch-historical.cjs \
 *        [--apply] [--days=N] [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]
 *        [--sports=baseball,football] [--concurrency=8]
 *        [--time-budget-min=N] [--ignore-cursor] [--status]
 *
 * Defaults to DRY-RUN. Nothing is written without --apply.
 *
 * Exit codes:
 *   0  run completed (range exhausted, max-days, or time budget)
 *   1  bad flags / missing env
 *   2  stopped on a day that failed to download or parse
 */

const path = require("path");
const backend = path.join(__dirname, "..");

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING && !process.env.COSMOS_ENDPOINT) {
    console.error("FATAL: COSMOS_CONNECTION_STRING (or COSMOS_ENDPOINT) not set");
    process.exit(1);
  }
  if (!process.env.CARD_HEDGE_API_KEY) {
    console.error("FATAL: CARD_HEDGE_API_KEY not set");
    process.exit(1);
  }

  const svc = require(path.join(backend, "dist/services/portfolioiq/chHistoricalBackfill.service.js"));
  const store = require(path.join(backend, "dist/services/portfolioiq/chHistoricalBackfillStore.service.js"));

  if (has("status")) {
    const cur = await store.readBackfillCursor();
    if (!cur) {
      console.log(`No cursor yet — a run would start at the cutoff ${svc.CH_RETENTION_CUTOFF}.`);
    } else {
      console.log(JSON.stringify({
        lastCompletedDate: cur.lastCompletedDate,
        resumesAt: svc.addDays(cur.lastCompletedDate, 1),
        cumulativeDays: cur.cumulativeDays,
        cumulativeRowsWritten: cur.cumulativeRowsWritten,
        cumulativeRowsParsed: cur.cumulativeRowsParsed,
        updatedAt: cur.updatedAt,
      }, null, 2));
    }
    return 0;
  }

  const apply = has("apply");
  // Default is ALL groups including Pokemon/TCG (Drew, 2026-08-14).
  // Pass --sports=baseball,football to narrow. Note that non-sport
  // groups map to sport=null, which means recordSoldComp cannot compute
  // a hobbyiqCardId slug for them (it needs a sport) — those rows land
  // in the pool keyed by vendor cardId only until the sport→vertical
  // refactor lands.
  const sportsRaw = arg("sports", "");
  const sportFilter = sportsRaw.trim()
    ? sportsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const timeBudgetMin = Number(arg("time-budget-min", "0"));

  const opts = {
    startDate: arg("start", undefined),
    endDate: arg("end", undefined),
    maxDays: Number(arg("days", "7")),
    sportFilter,
    concurrency: Number(arg("concurrency", "8")),
    apply,
    timeBudgetMs: Number.isFinite(timeBudgetMin) && timeBudgetMin > 0 ? timeBudgetMin * 60_000 : 0,
    ignoreCursor: has("ignore-cursor"),
  };

  console.log("[backfill-ch-historical]");
  console.log(`  mode:        ${apply ? "APPLY (writes to sold_comps)" : "DRY-RUN (no writes)"}`);
  console.log(`  maxDays:     ${opts.maxDays}`);
  console.log(`  sports:      ${sportFilter ? sportFilter.join(",") : "(all)"}`);
  console.log(`  concurrency: ${opts.concurrency}`);
  console.log(`  timeBudget:  ${timeBudgetMin > 0 ? timeBudgetMin + "m" : "none"}`);
  console.log("");

  const res = await svc.runHistoricalBackfill(opts);

  console.log("\n════════════════ SUMMARY ════════════════");
  console.log(`  window:            ${res.startDate} → ${res.endDate}`);
  console.log(`  days attempted:    ${res.daysAttempted}`);
  console.log(`  days completed:    ${res.daysCompleted}`);
  console.log(`  rows parsed:       ${res.totalRowsParsed.toLocaleString()}`);
  console.log(`  rows mappable:     ${res.totalRowsWritten.toLocaleString()}${apply ? " (written)" : " (would-be; nothing written)"}`);
  console.log(`  rows skipped:      ${res.totalRowsSkipped.toLocaleString()}`);
  if (apply) {
    console.log(`  catalog-unmatched: ${res.totalRowsUnmatched.toLocaleString()}`);
    console.log(`  rows failed:       ${res.totalRowsFailed.toLocaleString()}`);
    console.log(`  cursor:            ${res.cursorBefore ?? "(none)"} → ${res.cursorAfter ?? "(none)"}`);
  } else {
    // recordSoldComp is never called in dry-run, so match/failure counts
    // carry no information and the cursor was NOT persisted. Printing
    // them as if they were real is how a dry-run gets mistaken for a run.
    console.log(`  catalog-unmatched: n/a (dry-run — recordSoldComp not called)`);
    console.log(`  rows failed:       n/a (dry-run)`);
    console.log(`  cursor:            ${res.cursorBefore ?? "(none)"} (UNCHANGED — dry-run would have advanced to ${res.cursorAfter ?? "(none)"})`);
  }
  console.log(`  stopped because:   ${res.stoppedReason}`);
  console.log(`  elapsed:           ${(res.elapsedMs / 1000).toFixed(1)}s`);

  const failed = res.perDay.filter((d) => !d.complete);
  if (failed.length > 0) {
    console.log(`\n  INCOMPLETE DAYS (cursor held here):`);
    failed.forEach((d) => console.log(`    ${d.fileDate}  http=${d.httpStatus}  ${d.error ?? ""}`));
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e); process.exit(1); });
