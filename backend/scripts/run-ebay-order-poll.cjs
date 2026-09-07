#!/usr/bin/env node
/**
 * run-ebay-order-poll.cjs — the hourly eBay order poll, run on the backfill
 * runner instead of inside the API process (Drew, 2026-08-30: "cut over to the
 * GH cron; flip the flag").
 *
 * Why here: the in-process scheduler doubled (64 cycles/24h across 2 workers —
 * an App Service restart re-arms the first-run timer inside the lock TTL) and
 * its reconciliation exit code meant nothing in a web process. On a runner a
 * shortfall goes red.
 *
 * Same code as the API's job: every connected user through
 * pollEbayOrdersForUser (D26: resolve → record → mark → cursor advance), the
 * user's own lastPolledAt cursor. Writes and cursor moves happen only with
 * BACKFILL_APPLY=true; otherwise every user runs dryRun and nothing is written.
 *
 * Reconciliation: intended = line items processed; written = sales recorded;
 * skipped = the rest (parked / unresolvable / already recorded); failed =
 * failed + markFailures. Exit 1 on a thrown per-user error; reconnect-required
 * and fetch-failed users are reported, not counted as failures (they are
 * states the account page shows).
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET (ebayAuth throws at import without it); BACKFILL_APPLY.
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This lane records SALES and marks
// holdings sold, and it declared no budget at all: on the runner it could only
// ever end by being KILLED at the 150-minute ceiling -- no marker, no
// reconcile, no finishLane line, and #1913's KILLED branch then withholding the
// re-dispatch.
//
// THE UNIT IS ONE USER, and it is genuinely bounded: pollEbayOrdersForUser
// walks at most MAX_PAGES(20) x PAGE_LIMIT(50) = 1,000 orders for that user,
// resolving and recording each line item. A user at that ceiling with a slow
// eBay is the largest single unit this lane has, so the reserve is 5 minutes --
// generous rather than tight, because the cost is an EXTERNAL API's latency
// and the reserve is what keeps a slow user from being started with four
// minutes left on the clock.
//
// THE STOP IS SAFE MID-SWEEP, which is why this lane refuses nothing. Each
// user's cursor advances only after that user's own orders are recorded
// (D26: resolve -> record -> mark -> cursor advance), so a stop between users
// leaves every completed user durable and every remaining user exactly where
// the next run will find them. There is no cross-user statistic.
//
// VERIFY_MS is nominal: this lane reads nothing after its loop.
// Worst case 110 + 5 + 1 + 1 + 1 = 118m under the 150m ceiling.
//
// THE CRON PASSES ITS OWN RUN_MINUTES. ebay-order-poll-hourly.yml runs this
// every hour, so a 110-minute default would let one slow run overlap the next;
// budget() reads RUN_MINUTES from the env, and that workflow sets it.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  const { pollEbayOrdersForUser } = require(path.join(backend, "dist/services/ebay/ebayOrderPoll.service.js"));
  const { listConnectedUserIds } = require(path.join(backend, "dist/services/ebay/ebayTokenStore.service.js"));
  console.log(`run-ebay-order-poll  ${APPLY ? "APPLY (records sales, marks holdings, advances cursors)" : "REPORT ONLY -- nothing written, cursors untouched"}  env=${process.env.EBAY_ENV || "(default)"}`);
  console.log(`  ${CLOCK.describe()}`);

  const users = [...new Set((await listConnectedUserIds()).filter(Boolean))].sort();
  console.log(`connected users: ${users.length}`);
  const s = { users: 0, reconnect: 0, fetchFailed: 0, ordersFetched: 0, ordersProcessed: 0, cursors: 0, lines: 0, resolved: 0, parked: 0, unresolvable: 0, recorded: 0, viaHolding: 0, viaAccount: 0, marked: 0, failed: 0, errors: 0 };
  let stoppedAtBudget = false;
  for (const userId of users) {
    // THE PRE-CHECK, before the user is started rather than after their 1,000
    // orders have been walked. A stop here is safe: the cursor advances per
    // user, so every finished user is durable and every unstarted one is
    // untouched.
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    s.users++;
    try {
      const r = await pollEbayOrdersForUser(userId, { dryRun: !APPLY });
      s.ordersFetched += r.ordersFetched ?? 0; s.ordersProcessed += r.ordersProcessed ?? 0; s.lines += r.lineItemsProcessed ?? 0;
      s.resolved += r.resolvedAuto ?? 0; s.parked += r.parked ?? 0; s.unresolvable += r.unresolvable ?? 0;
      s.recorded += r.recorded ?? 0; s.viaHolding += r.recordedViaHolding ?? 0; s.viaAccount += r.recordedViaAccount ?? 0;
      s.marked += r.holdingsMarked ?? 0; s.failed += (r.failed ?? 0) + (r.markFailures ?? 0);
      if (r.cursorAdvanced) s.cursors++;
      if (r.status === "fetch-failed") s.fetchFailed++;
      if (r.status === "reconnect-required") { s.reconnect++; console.log(`  reconnect-required: ${String(userId).slice(0, 13)}`); }
    } catch (e) {
      s.errors++;
      console.error(`  ERROR ${String(userId).slice(0, 13)}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users attempted       ${f(s.users)}   reconnect-required ${f(s.reconnect)}   fetch-failed ${f(s.fetchFailed)}`);
  console.log(`  orders fetched        ${f(s.ordersFetched)}   processed ${f(s.ordersProcessed)}   cursors advanced ${f(s.cursors)}`);
  console.log(`  line items            ${f(s.lines)}   resolved ${f(s.resolved)}   parked ${f(s.parked)}   unresolvable ${f(s.unresolvable)}`);
  console.log(`  RECORDED              ${f(s.recorded)}   <- via holding ${f(s.viaHolding)} / via account ${f(s.viaAccount)}`);
  console.log(`  holdings marked sold  ${f(s.marked)}`);
  console.log(`  failed                ${f(s.failed)}   per-user errors ${f(s.errors)}`);
  // RECONCILE OVER WHAT THIS RUN SAW. `intended` is the line items actually
  // processed by the users that were STARTED -- there is no denominator for
  // the users the budget did not reach, so the identity holds whether the
  // sweep finished or the clock stopped it (a slice is not a sibling counter).
  if (APPLY) {
    const skipped = Math.max(0, s.lines - s.recorded - s.failed);
    console.log(`  reconciled: intended ${f(s.lines)} = written ${f(s.recorded)} + skipped ${f(skipped)} + failed ${f(s.failed)}`);
    if (s.recorded + skipped + s.failed !== s.lines) {
      console.error("  !! RECONCILE MISMATCH -- a processed line item was neither recorded, skipped nor failed");
      process.exitCode = 4;
    }
    reportWrites({ job: "run-ebay-order-poll", intended: s.lines, written: s.recorded, skipped, failed: s.failed });
  }

  // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
  // variables.
  if (stoppedAtBudget) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `${f(users.length - s.users)} connected user(s) were NOT polled; the relaunch continues from here`);
    console.log("  the continuation never re-reads what this pass wrote: each user's lastPolledAt"
      + " cursor advances only after that user's own orders are recorded, so a finished user"
      + " starts from the new cursor and an unstarted one from the old.");
  }

  if (s.errors > 0) {
    console.error(`FATAL: ${s.errors} per-user error(s)`);
    // A per-user error is a VERDICT the lane reached on its own, not a crash --
    // it exits through finishLane so the relaunch classifies it as (d) rather
    // than as a kill.
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
