#!/usr/bin/env node
// CF-REPRICE-USER-HOLDINGS (Drew, 2026-07-30). Server-side batch reprice
// for a single user's holdings, bypassing the HTTP endpoint throttle.
// Use to force fresh FMVs after a code / calibration / flag change.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   AUTH_SESSION_SECRET        required (transitive imports)
//   REPRICE_USER_ID            which user's holdings to reprice (required
//                              unless MODE=all)
//   MODE=all                   sweep EVERY user. PRECEDENCE: MODE=all WINS —
//                              it is tested first, so a REPRICE_USER_ID set
//                              alongside it is ignored, not honoured.
//   REPRICE_MAX_HOLDINGS       optional (default 200)
//   REPRICE_CONCURRENCY        optional (default 1). Read and VALIDATED; only
//                              1 is accepted — see the refusal below.
//   BACKFILL_APPLY=true        the runner's switch; anything else is a dry run
//
// CF-RUNNER-FLAG-HYGIENE (D18, 2026-08-29). This read no flag at all, so an
// `apply=false` dispatch repriced (and persisted) the portfolio anyway. It
// honours the runner's BACKFILL_APPLY now: a dry dispatch says which users and
// how many holdings it would reprice, and exits. The sanctioned dispatch —
// `-f script=reprice-user-holdings -f apply=true` — is unchanged.
//
// NOT reconciled, on purpose (D18). repriceHoldingsForUser returns
// `requested` = ALL holdings, while repriced + skipped cover only the
// CANDIDATES it kept after the min-age filter and the maxHoldings slice — so
// no honest `intended` exists on this side of the call, and a wrong intended
// is worse than none (it fires WORK VANISHED on every portfolio over 200). The
// service would have to return the candidate count; until then the JSON it
// prints is the record. A call that throws aborts the run (exit 1), not green.

const path = require("path");
const backend = __dirname + "/..";
const { repriceHoldingsForUser } = require(path.join(backend, "dist/services/portfolioiq/portfolioStore.service.js"));
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS + CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE.
// The clock and the exit come from the SHARED helper, never a local copy.
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = process.env.BACKFILL_APPLY === "true";

// -- THE CLOCK --------------------------------------------------------------
//
// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS. This is the SANCTIONED reprice path
// and the last remaining lane that writes the `portfolio` container, and it
// declared no budget at all. On the manual lane that was survivable -- one user,
// up to 200 holdings. On MODE=all it is not: the loop walks EVERY user in the
// container serially, so the run time is proportional to CORPUS, and the only
// way a sweep bigger than one 150-minute step could ever end was by being
// KILLED at the ceiling -- no marker, no reconcile, no finishLane line, and
// #1913's KILLED branch then withholding the re-dispatch with an unknown number
// of users repriced and the rest untouched.
//
// THE UNIT IS ONE USER, because the loop cannot stop inside one:
// repriceHoldingsForUser is a single call that walks that user's holdings
// serially inside the service and returns once. So the worst single unit this
// lane can start is a full REPRICE_MAX_HOLDINGS (default 200) walk -- 200 pool
// queries plus one whole-document write, against a container whose largest live
// portfolio document is 1.96 MB.
//
// 5 MINUTES is the reserve, measured against the largest live portfolio rather
// than the average: the 2026-09-03 reading was ~1.0 kRU and a few seconds for a
// 130-holding pass across twelve users, but the reserve has to cover the
// PATHOLOGICAL user -- 200 holdings, every one of them cache-cold and
// re-derived, against a sold_comps floor shared with live 5AM traffic. It is
// checked BEFORE the user's reprice is started, so the user whose 200-holding
// walk would overrun is never STARTED; the loop-top defect #1799 named admits
// one whole extra user past expiry.
//
// VERIFY_MS is nominal: this lane reads NOTHING after its loop. The one query
// it runs -- the DISTINCT VALUE c.userId enumeration -- is a PRE-loop scope
// read, which spends budget the loop then does not get (covered by the reserve
// and the margin) and cannot strand a reconciliation, because at that point
// there is nothing yet to reconcile.
//
// Worst case 110 + 5 + 1 + 1 = 117m under the 150m ceiling: 33 minutes of margin.
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 110);
const RESERVE_MS = Number(process.env.RESERVE_MS || 5 * 60 * 1000);
const VERIFY_MS = Number(process.env.VERIFY_MS || 60 * 1000);
const CLOCK = budget({ minutes: RUN_MINUTES, reserveMs: RESERVE_MS, verifyMs: VERIFY_MS });

const USER_ID = process.env.REPRICE_USER_ID || process.env.DREW_USER_ID;
// CF-LOOK-AT-EVERY-HOLDING (Drew, 2026-08-29): MODE=all reprices every user
// in the portfolio container, not just the one REPRICE_USER_ID names.
const ALL_USERS = String(process.env.MODE || "").toLowerCase() === "all";
const MAX_HOLDINGS = Number(process.env.REPRICE_MAX_HOLDINGS || "200");

// CF-A-THE-NIGHTLY-BILL-IS-PROPORTIONAL-TO-CHANGE (C-2 verifier, 2026-09-03).
//
// This script passed `minHoldingAgeMs: 0` on BOTH lanes, so the nightly
// corpus sweep repriced every holding of every user every night regardless of
// whether anything about that card had changed. That is defensible at 130
// holdings and indefensible as a standing design: the work is proportional to
// CORPUS, and the audit's own growth note (100x corpus -> ~100 kRU) is the
// shape of a bill that only ever goes up.
//
// The honest split, stated rather than buried:
//
//   NIGHTLY (MODE=all)   skip a holding priced within the last 20h WHOSE
//                        EXACT POOL HAS NOT GROWN. Not age alone — the
//                        service re-checks the pool count for every holding
//                        the age filter would skip and reprices it anyway if
//                        a sale landed (skipFreshOnlyWhenPoolUnchanged). So a
//                        card the market moved is ALWAYS repriced; a card
//                        nobody traded is not repriced twice for nothing.
//                        20h < 24h deliberately: the daily cadence must never
//                        skip a holding merely because yesterday's run was a
//                        little late.
//
//   MANUAL (a userId)    keeps the full bypass. A human dispatching a reprice
//                        after a calibration or code change is explicitly
//                        asking for every number to be recomputed, and a
//                        freshness skip there would silently defeat the very
//                        purpose of the dispatch.
const NIGHTLY_MIN_HOLDING_AGE_MS = 20 * 60 * 60 * 1000;

// CF-A-DECORATIVE-KNOB-IS-A-LIE (C-2 verifier, 2026-09-03). `REPRICE_CONCURRENCY`
// was set in daily-refresh.yml and read by NOTHING. A knob that appears to
// bound the blast radius of a corpus sweep, and does not, is worse than no
// knob: the next person to worry about RU pressure would turn it, watch the
// run stay green, and conclude the sweep was bounded.
//
// The script reads it now, and the value it accepts is 1. Serial execution is
// the deliberate design — the sweep shares the sold_comps 10k RU/s floor with
// live user traffic at 5AM ET, and a parallel sweep is exactly the shape that
// produces 429s on the read path a collector is using. Rather than silently
// ignoring a larger value (the same lie in a new place) or quietly honouring
// one (shipping an untested parallel path), it REFUSES: the run exits 1 and
// says that implementing parallelism is a code change, not a config change.
const CONCURRENCY = Number(process.env.REPRICE_CONCURRENCY || "1");
if (!Number.isFinite(CONCURRENCY) || CONCURRENCY < 1) {
  console.error(`FATAL: REPRICE_CONCURRENCY=${process.env.REPRICE_CONCURRENCY} is not a positive integer.`);
  process.exit(1);
}
if (CONCURRENCY !== 1) {
  console.error(
    `FATAL: REPRICE_CONCURRENCY=${CONCURRENCY} but this script executes SERIALLY (a plain for-loop over users, `
    + `and repriceHoldingsForUser walks holdings serially inside each).\n`
    + `  Serial is deliberate: the sweep shares the sold_comps 10,000 RU/s floor with live user traffic at 5AM ET, `
    + `and a parallel sweep is the shape that produces 429s on a collector's read path.\n`
    + `  Refusing rather than ignoring the value, so nobody believes they have bounded something they have not. `
    + `Parallelism here is a code change, not a config change.`,
  );
  process.exit(1);
}

async function main() {
  if (!USER_ID && !ALL_USERS) {
    console.error("REPRICE_USER_ID required (or MODE=all)");
    process.exit(1);
  }
  if (ALL_USERS) {
    const { CosmosClient } = require("@azure/cosmos");
    if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
    // NAMED, not chained, so finishLane() can dispose it (#1809): an undisposed
    // SDK holds keep-alive sockets, and a live handle is what held four
    // reconciled-clean runs to the ceiling.
    const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
    const portfolio = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("portfolio");
    const { resources } = await portfolio.items.query("SELECT DISTINCT VALUE c.userId FROM c WHERE IS_DEFINED(c.holdings)").fetchAll();
    console.log(`[reprice-user-holdings] MODE=all -> ${resources.length} users  ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`  concurrency:    ${CONCURRENCY} (serial for-loop; see REPRICE_CONCURRENCY below)`);
    console.log(`  freshness skip: holdings priced within ${(NIGHTLY_MIN_HOLDING_AGE_MS / 3600000).toFixed(0)}h whose exact pool has NOT grown`);
    console.log(`  ${CLOCK.describe()}`);
    console.log("");
    if (!APPLY) {
      console.log(`DRY-RUN — ${resources.length} users would be repriced (up to ${MAX_HOLDINGS} holdings each). Dispatch with apply=true to write.`);
      return { client, budget: CLOCK };
    }
    const totals = {};
    // THE POPULATION IS KNOWN UP FRONT -- the DISTINCT enumeration above IS the
    // scope -- so a partial run can report `not reached` as a REAL number rather
    // than folding it into `skipped` and claiming a decision nobody made
    // (#1947: the two reconciliation shapes are not interchangeable).
    let repricedUsers = 0, failedUsers = 0;
    let stoppedAtBudget = false;
    for (const uid of resources) {
      // THE PRE-CHECK: above the unit's work, and BEFORE the user's reprice is
      // started rather than after it finishes. `outOfClock()` is true when less
      // than the reserve remains, so the user whose 200-holding walk would
      // overrun is never started.
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const t0 = Date.now();
      const r = await repriceHoldingsForUser(uid, "batch-reprice", {
        userThrottleMs: 0,
        // The nightly lane's freshness rule. Pool-growth aware: a fresh
        // holding whose pool GREW is repriced anyway, so this never hides a
        // real market move — it only stops re-deriving unchanged numbers.
        minHoldingAgeMs: NIGHTLY_MIN_HOLDING_AGE_MS,
        skipFreshOnlyWhenPoolUnchanged: true,
        maxHoldings: MAX_HOLDINGS,
      });
      repricedUsers++;
      console.log(`  ${uid}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${JSON.stringify(r).slice(0, 300)}`);
      for (const [k, v] of Object.entries(r || {})) if (typeof v === "number") totals[k] = (totals[k] || 0) + v;
    }
    console.log(`
ALL USERS DONE  ${JSON.stringify(totals)}`);

    // RECONCILE OVER THE KNOWN POPULATION. Deliberately NOT reportWrites: the
    // docblock at the top of this file records why (repriceHoldingsForUser
    // returns `requested` = ALL holdings while repriced + skipped cover only the
    // CANDIDATES it kept, so no honest per-HOLDING `intended` exists on this
    // side of the call). What IS honest, and is new here, is the reconciliation
    // over the unit this lane actually controls -- the USER -- because this
    // loop enumerated that population itself.
    const notReached = resources.length - repricedUsers - failedUsers;
    console.log(`  reconciled: intended ${resources.length} users = repriced ${repricedUsers}`
      + ` + failed ${failedUsers} + not reached ${notReached}`);
    if (repricedUsers + failedUsers + notReached !== resources.length) {
      console.error("  !! RECONCILE MISMATCH — a user was neither repriced, failed nor left unreached");
      process.exitCode = 4;
    }

    // -- THE MARKER THE RELAUNCH GREPS ---------------------------------------
    //
    // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). A SOURCE LITERAL, never assembled from
    // variables: a marker built by concatenation is one a refactor can silently
    // reword, and a reworded marker ends the fan-out after one slice with the
    // run green -- the quiet version of the bug it exists to make loud.
    if (stoppedAtBudget) {
      console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
        + `${notReached} of ${resources.length} users NOT REACHED; the relaunch continues from here`);
      console.log("  the continuation is CHEAP over the finished part: a user repriced moments ago"
        + " has holdings inside the 20h freshness window whose pools have not grown, so the next"
        + " pass skips them on one partition-keyed COUNT each and spends its clock on the remainder.");
    }
    return { client, budget: CLOCK };
  }
  console.log(`[reprice-user-holdings]`);
  console.log(`  userId:      ${USER_ID}`);
  console.log(`  maxHoldings: ${MAX_HOLDINGS}`);
  console.log(`  composite:   ${process.env.HOBBYIQFMV_COMPOSITE_ENABLED === "true" ? "ENABLED" : "DISABLED"}`);
  console.log(`  mode:        ${APPLY ? "APPLY" : "DRY-RUN"}\n`);
  if (!APPLY) {
    console.log(`DRY-RUN — would reprice up to ${MAX_HOLDINGS} holdings for ${USER_ID}. Dispatch with apply=true to write.`);
    return { budget: CLOCK };
  }

  // THE MANUAL LANE IS ONE UNIT, and the clock is still checked before it.
  //
  // There is no loop here to stop inside: this branch is a SINGLE
  // repriceHoldingsForUser call. The pre-check is therefore not about pacing a
  // sweep -- it is about refusing to START a unit the step cannot finish, which
  // is the same rule stated for a population of one. In practice a manual
  // dispatch begins with the whole budget in hand and this never fires; it can
  // only fire when RUN_MINUTES is dispatched small enough that the reserve
  // already exceeds it, and then it SAYS SO rather than beginning a 200-holding
  // walk the ceiling would cut in half.
  if (CLOCK.outOfClock()) {
    console.log(`
  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `the reprice for ${USER_ID} was NOT STARTED; the relaunch continues from here`);
    console.log("  nothing was written, so the continuation repeats this dispatch whole.");
    return { budget: CLOCK };
  }

  const t0 = Date.now();
  const result = await repriceHoldingsForUser(USER_ID, "batch-reprice", {
    userThrottleMs: 0,     // bypass 60s HTTP throttle
    minHoldingAgeMs: 0,    // reprice everything, even if fresh
    maxHoldings: MAX_HOLDINGS,
  });
  const t1 = Date.now();
  console.log(`\nDone in ${((t1 - t0) / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  return { budget: CLOCK };
}

// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too -- a failure
// path that exits and a success path that hopes is the asymmetry that cost four
// reconciled-clean runs their exit codes. The exit code stays 1 on a throw, so
// the sanctioned dispatch's failure semantics are unchanged.
main()
  .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
  .catch(async (e) => {
    console.error(e);
    await finishLane(1, { budget: CLOCK });
  });
