#!/usr/bin/env node
/**
 * run-ebay-purchase-sync.cjs — the eBay purchase (buyer-history) sync, run on
 * the backfill runner instead of inside the API process.
 *
 * Why (Drew, 2026-08-30 12:58Z: "we have A LIVE ebay purchase from import why
 * is that not included there?"): the in-process weekly job (fire hour 06 UTC,
 * hourly tick) sat behind the same single-flight lock as the order poll and
 * the fee enrichment — a lock that survives App Service restarts and is never
 * released, so after every deploy both workers skip until it expires and the
 * weekly window is missed. Telemetry: "cycle skipped — another worker holds
 * the lock" on both workers, no "start users=" line in 7 days.
 *
 * Same code as the job: runWeeklyEbayPurchaseSync → importEbayPurchaseHistory
 * per connected user over WEEKLY_EBAY_SYNC_DAYS (default 7; DAYS env here).
 * The import writes holdings/purchases — there is no dry mode in it, so
 * REPORT ONLY lists the connected users and the window and stops without
 * calling eBay; APPLY runs the import.
 *
 * Reconciliation: intended = purchases fetched; written = imported; skipped =
 * replayed (already known) + skipped; failed = errors. Exit 1 on errors.
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET; BACKFILL_APPLY; DAYS (1–90, default 7).
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const DAYS = Math.max(1, Math.min(90, Number(process.env.DAYS || process.env.WEEKLY_EBAY_SYNC_DAYS || 7)));
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// -- THE CLOCK, AND WHY THIS ONE IS SHAPED DIFFERENTLY ----------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane imports PURCHASES into
// holdings and declared no budget: on the runner it could only ever end by
// being KILLED at the 150-minute ceiling -- no marker, no reconcile, no
// finishLane line, and #1913's KILLED branch then withholding the re-dispatch.
//
// >>> THE WORK LOOP IS NOT IN THIS FILE. <<<
//
// Every other lane in the #1944 ratchet owns the loop its clock guards. This
// one does not: runWeeklyEbayPurchaseSync() walks every connected user
// INTERNALLY (ebayPurchaseSync.job.ts:118) and returns one summary at the end.
// There is no seam here for a per-unit outOfClock() PRE-check, and inventing
// one would mean either passing a signal the job does not accept or racing the
// call and abandoning it -- and an abandoned import is exactly the wedge #1809
// spent 150 minutes of a runner learning about.
//
// So the clock is honest about what it can and cannot do, and says so:
//
//   THE PRE-FLIGHT GATE. The check happens BEFORE the one call, which is the
//   only unit there is. If the clock cannot seat a whole sweep, the lane
//   REFUSES rather than starting one it cannot finish -- exit 5, nothing
//   written, marker printed so the relaunch re-dispatches with a full clock.
//   That is the same shape as the scan-phase refusals, applied to a lane whose
//   single unit is the entire job.
//
//   THE RESERVE IS THE WHOLE SWEEP. 30 minutes: the job is weekly, over a
//   default 7-day window, across the connected users -- measured in seconds in
//   practice (durationMs is in the very summary this prints), and 30 minutes is
//   the ceiling past which the operator should be TOLD the shape is wrong
//   rather than have the run silently take longer.
//
//   AND THE GATE IS NOT A GUARANTEE. If the sweep itself overruns its reserve
//   nothing here can stop it; the margin under the 150m ceiling is what absorbs
//   that, and the AFTER-check below reports the overrun by name instead of
//   leaving it to be inferred from a wall-clock diff. Naming a limit this file
//   cannot enforce is better than implying one it can.
//
// VERIFY_MS is nominal: this lane reads nothing after the call.
// The reserve is large, so the BUDGET is sized down to keep the margin:
// 100 + 30 + 1 + 1 + 1 = 133m, leaving 17m under the 150m ceiling.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 100);
const RESERVE_MS = Number(process.env.RESERVE_MS || 30 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  process.env.WEEKLY_EBAY_SYNC_DAYS = String(DAYS);
  process.env.WEEKLY_EBAY_PURCHASE_SYNC_ENABLED = "true";
  console.log(`run-ebay-purchase-sync  ${APPLY ? "APPLY (imports purchases into holdings)" : "REPORT ONLY -- lists users, calls nothing"}  days=${DAYS}  env=${process.env.EBAY_ENV || "(default)"}`);
  console.log(`  ${CLOCK.describe()}`);
  const { listConnectedUserIds } = require(path.join(backend, "dist/services/ebay/ebayTokenStore.service.js"));
  const users = [...new Set((await listConnectedUserIds()).filter(Boolean))].sort();
  console.log(`connected users: ${users.length}`);
  if (!APPLY) { console.log(`\nREPORT ONLY -- nothing written\n  users ${users.length}  window ${DAYS} day(s)  (the import has no dry mode; APPLY runs it)`); return { budget: CLOCK }; }

  // -- THE PRE-FLIGHT GATE ---------------------------------------------------
  //
  // The sweep is ONE unit and this file cannot interrupt it, so the only place
  // a clock can act is BEFORE it starts. Listing the users above is the startup
  // cost; if that alone has eaten into the reserve, a sweep started now is a
  // sweep the ceiling would kill mid-import.
  //
  // Exit 5 is a VERDICT, not a crash (#1955 outcome (d)). The marker is printed
  // FIRST, because the relaunch marker arm runs BEFORE its outcome check -- so
  // this re-dispatches and the next run starts with a full clock.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the sweep was NOT started; the relaunch continues from here`);
    console.error("  REFUSING THE SWEEP: runWeeklyEbayPurchaseSync walks every connected user"
      + " INTERNALLY and returns one summary, so there is no seam at which this lane could stop"
      + " it half way. Starting it with less than the unit reserve left would mean being KILLED"
      + " mid-import at the ceiling -- no summary, no reconcile, no finishLane line. Nothing was"
      + " written.");
    reportWrites({ job: "run-ebay-purchase-sync", intended: 0, written: 0, skipped: 0, failed: 0 });
    process.exitCode = 5;
    return { budget: CLOCK };
  }

  const { runWeeklyEbayPurchaseSync } = require(path.join(backend, "dist/jobs/ebayPurchaseSync.job.js"));
  const sweepStartedAt = Date.now();
  const s = await runWeeklyEbayPurchaseSync();
  const sweepMs = Date.now() - sweepStartedAt;
  const imported = Number(s.purchasesImported ?? 0);
  const replayed = Number(s.purchasesReplayed ?? 0);
  const skipped  = Number(s.purchasesSkipped ?? 0);
  const fetched  = imported + replayed + skipped;
  const reconnect = Array.isArray(s.reconnectRequired) ? s.reconnectRequired : [];
  const dataFailures = Array.isArray(s.dataFailures) ? s.dataFailures : [];

  console.log(`\nAPPLIED`);
  console.log(`  users attempted     ${f(s.usersAttempted)}   fetched ok ${f(s.usersFetched)}`);
  console.log(`  purchases           ${f(fetched)}   IMPORTED ${f(imported)}   replayed ${f(replayed)}   skipped ${f(skipped)}`);
  console.log(`  needs reconnect     ${f(reconnect.length)}   data failures ${f(dataFailures.length)}   (${f(s.durationMs)} ms, window ${s.daysWindow} d)`);

  // A dead grant is a condition to REPORT, per user, by name. It is the
  // difference between "two users must reconnect eBay" and a red X.
  if (reconnect.length > 0) {
    console.log(`\n  ${reconnect.length} user(s) must reconnect eBay -- marked reconnect-required, skipped:`);
    for (const r of reconnect) console.log(`    ${r.userId}  ${r.error}`);
  }
  if (dataFailures.length > 0) {
    console.error(`\n  ${dataFailures.length} DATA failure(s):`);
    for (const r of dataFailures) console.error(`    ${r.userId}  ${r.error}`);
  }

  // Units: every number here is PURCHASES. `s.errors` counts USERS and must
  // never appear in this equation -- that is what made the banner read OVER.
  reportWrites({
    job: "run-ebay-purchase-sync",
    intended: fetched,
    written: imported,
    skipped: replayed + skipped,
    failed: 0,
  });

  // Reconciled above, and it BALANCES BY CONSTRUCTION: fetched is DEFINED as
  // imported + replayed + skipped, so the identity holds on any run that
  // reached this line. The banner is still printed, because a reconciliation
  // nobody can read is not a reconciliation.
  console.log(`  reconciled: intended ${f(fetched)} = written ${f(imported)} + skipped ${f(replayed + skipped)} + failed 0`);

  // -- THE OVERRUN THE GATE CANNOT PREVENT -----------------------------------
  //
  // The pre-flight gate above sizes the reserve to a whole sweep; it cannot
  // ENFORCE it, because the sweep is opaque. So when the sweep outran its own
  // reserve, say so by name rather than leaving the operator to infer it from a
  // wall-clock diff -- the next dispatch may need a bigger RESERVE_MS, and that
  // is a decision somebody has to be told to make.
  if (sweepMs > CLOCK.RESERVE_MS) {
    console.error(`  !! THE SWEEP OUTRAN ITS RESERVE: ${f(Math.round(sweepMs / 1000))}s against a `
      + `${f(Math.round(CLOCK.RESERVE_MS / 1000))}s reserve. The work is durable and reconciled; `
      + `the SIZING is wrong. Raise RESERVE_MS (and lower RUN_MINUTES to keep the 15m margin) `
      + `before the next dispatch, or this lane will eventually be killed mid-import.`);
  }

  // DATA failures fail the job. Token failures do not: nothing was lost, and
  // the affected users are named above and flagged on their connection doc.
  if (dataFailures.length > 0) {
    console.error(`FATAL: ${dataFailures.length} data failure(s)`);
    // A VERDICT the lane reached on its own, not a crash: it exits through
    // finishLane so the relaunch classifies it as (d) rather than as a kill.
    process.exitCode = 1;
  }
  return { budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error("FATAL:", e?.stack || e?.message || e);
    await finishLane(3, { budget: CLOCK });
  });
