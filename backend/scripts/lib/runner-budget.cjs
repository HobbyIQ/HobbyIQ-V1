// CF-A-KILLED-JOB-CANNOT-REPORT-PROGRESS — the shared clock for every
// budgeted lane the backfill runner can dispatch.
//
// THE RULE (#1799, generalised here). A lane's own clock must stop, print,
// verify AND reconcile with margin under the runner step's `timeout-minutes`,
// because a killed step reports nothing at all — not its counts, not its
// verify, not its exit code. The margin is not decoration: it is the only
// thing that makes a budget stop distinguishable from a crash.
//
// #1799 fixed one lane (retire-self-derived-identities) by hand. The census
// behind this file found the same two defects across the whole whitelist:
//
//   61 of 62 budgeted lanes ran RUN_MINUTES=140 under a 150-minute step
//   ceiling — 10 minutes of margin, and no lane reserved any of it for the
//   unit still in flight when the budget expired.
//
//   45 of those checked `Date.now() - t0 > RUN_MS` at the TOP of the loop,
//   which admits one more unit of unbounded size AFTER expiry. On
//   rematch-sold-comps a unit is a (cardYear, sportClass) slice: run
//   33966990494 spent 51 minutes on one census unit of 508,645 rows.
//
//   16 of them then ran an unbounded post-loop `SELECT VALUE COUNT(1)`
//   cross-partition aggregate — the exact shape that ran 887 seconds and got
//   run 33960686247 killed at the ceiling AFTER its reconciliation had
//   printed clean.
//
// THE THREE CONSTANTS. Every budgeted lane declares the same three, so an
// operator sizing a fleet reads one vocabulary and the pin
// (tests/runnerBudgetMargin.test.ts) can compute every lane's worst case:
//
//   RUN_MINUTES   the work loop's budget
//   RESERVE_MS    wall clock the largest single unit may still be granted.
//                 CHECKED BEFORE EACH UNIT, never at the loop top: a unit
//                 costing more than the reserve is stopped BEFORE it starts.
//   VERIFY_MS     hard cap on the post-loop verify-by-read. It answers or it
//                 says it could not; it never holds the step open.
//
//   worst case = RUN_MINUTES + RESERVE_MS + VERIFY_MS + startup
//
// and the pin requires >= 15 minutes of margin under the workflow's real
// timeout-minutes, read from the YAML rather than hard-coded, so shrinking
// the ceiling turns CI red.
//
// SIZING IS PER LANE, NOT GLOBAL. A lane whose unit is a whole product
// reserves minutes; a lane whose unit is a 400-row page reserves seconds.
// Both are correct; a lane that reserves NOTHING is not. `budget()` takes the
// reserve from the caller for exactly that reason and only defaults it when a
// lane has no measurement to offer.

/** Minutes on the clock for the work loop itself. Env override keeps the
 *  operator's `RUN_MINUTES=` dispatch input working on every lane. */
function runMinutes(fallback) {
  const n = Number(process.env.RUN_MINUTES || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The three-constant clock.
 *
 * @param {object} opts
 * @param {number} opts.minutes      default RUN_MINUTES for this lane
 * @param {number} opts.reserveMs    wall clock the largest single unit may
 *                                   still be granted after the budget expires
 * @param {number} [opts.verifyMs]   hard cap on the post-loop verify-by-read
 * @param {number} [opts.startedAt]  loop t0, when the caller already has one
 */
function budget({ minutes, reserveMs, verifyMs = 10 * 60 * 1000, startedAt = Date.now() }) {
  const RUN_MINUTES = runMinutes(minutes);
  const BUDGET_MS = Number(process.env.BUDGET_MS || RUN_MINUTES * 60 * 1000);
  const RESERVE_MS = Number(process.env.RESERVE_MS || reserveMs);
  const VERIFY_MS = Number(process.env.VERIFY_MS || verifyMs);

  /** Set when a verify cap fired, i.e. when an abandoned query may still be
   *  in flight holding a handle. `finishLane()` reports it. */
  let capFired = false;

  /** Milliseconds left before the budget expires. Negative once it has. */
  const left = () => BUDGET_MS - (Date.now() - startedAt);

  /**
   * THE PRE-CHECK. True when there is not enough clock left to start another
   * unit of the largest size this lane has measured. Call it BEFORE the unit,
   * never after — the defect #1799 fixed was a bare `> BUDGET_MS` at the loop
   * top, which grants one whole extra unit past expiry.
   */
  const outOfClock = () => left() < RESERVE_MS;

  /** The banner operators gate the relaunch on. The runner greps
   *  `stopped at the .*budget` (CF-RELAUNCH-ONLY-ON-BUDGET, #1361), so the
   *  wording around it may change but that phrase may not. */
  const stoppedAtBudget = () => `stopped at the ${RUN_MINUTES}-minute budget`;

  /** One line for the header every lane prints, so the sizing is visible in
   *  the log of the run it governed rather than only in this file. */
  const describe = () =>
    `budget ${RUN_MINUTES}m loop + ${fmtMs(RESERVE_MS)} unit reserve + ${fmtMs(VERIFY_MS)} verify cap`;

  /**
   * Run a post-loop verify-by-read under the cap. Returns the query's value,
   * or null when the cap ran out — and null is printed as UNCONFIRMED, never
   * as a zero (feedback_never_dismiss_small_numbers_as_noise).
   *
   * @param {number} vt0 the verify phase's own t0, shared across calls so a
   *                     lane's several counts share ONE cap between them.
   */
  /**
   * Run a post-loop verify-by-read under the cap. Returns the query's value,
   * or null when the cap ran out — and null is printed as UNCONFIRMED, never
   * as a zero (feedback_never_dismiss_small_numbers_as_noise).
   *
   * WHY THIS CANNOT SIMPLY `Promise.race` AND RETURN (#1809).
   *
   * Runs 33975816175/25863/34391/40824 each reconciled clean and were then
   * killed at the 150-minute ceiling with 55-123 minutes of TOTAL SILENCE
   * after their last printed line. The cap was not the problem; abandonment
   * was. `Promise.race` settles on the winner and ABANDONS the loser — it
   * does not cancel it. The loser here is a Cosmos query wrapped in the
   * lane's own `retry()`, and that retry loop keeps looping on its own
   * REF'd `setTimeout` sleeps long after the race has resolved. A ref'd
   * handle is exactly what keeps node alive, so `main()` returned, the
   * report finished, and the process still sat there until the runner
   * killed the step and took the exit code with it.
   *
   * So the cap does two things a bare race does not:
   *
   *   1. It hands the caller an ABORT SIGNAL. A caller that passes it to the
   *      SDK (`{ abortSignal }`) lets the request actually be cancelled
   *      rather than merely ignored, and a `retry()` that checks it stops
   *      looping instead of sleeping its way past the ceiling.
   *   2. It records that the cap fired, so `finishLane()` knows the process
   *      may be holding an abandoned handle and must exit explicitly rather
   *      than wait for a drain that will never come.
   *
   * Neither makes the exit optional: `finishLane()` is what guarantees it.
   * This only keeps the abandoned work from doing damage in the meantime.
   */
  const capped = async (vt0, label, run) => {
    const remaining = VERIFY_MS - (Date.now() - vt0);
    if (remaining <= 0) {
      capFired = true;
      console.log(`  VERIFY BY READ  ${label}: could not confirm within the cap (verify-cap)`);
      return null;
    }
    const ac = new AbortController();
    let timer = null;
    try {
      return await Promise.race([
        // The caller receives the signal; passing it to the SDK is what makes
        // the abandoned request cancellable instead of merely ignored.
        run(ac.signal),
        new Promise((_, rej) => {
          // The cap timer is deliberately REF'd, and the `finally` below is
          // what makes that safe. An unref'd cap is worse than no cap: if the
          // query happens to hold no ref'd handle of its own, node exits the
          // instant main() awaits -- BEFORE the cap fires -- and the operator
          // loses the VERIFY BY READ line entirely rather than reading
          // UNCONFIRMED. Silence is the one thing this whole change exists to
          // prevent, so the cap holds the loop just long enough to report,
          // and clearTimeout in the `finally` releases it either way.
          timer = setTimeout(() => rej(new Error("verify-cap")), remaining);
        }),
      ]);
    } catch (e) {
      capFired = true;
      console.log(`  VERIFY BY READ  ${label}: could not confirm within the cap (${String(e && e.message)})`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      // Cancel the loser. Without this the query keeps retrying past the
      // ceiling; with it the SDK rejects and the retry loop unwinds.
      ac.abort();
    }
  };

  /** How an unconfirmed count is printed. Never "0". */
  const shown = (n, unit = "rows") => (n === null ? "UNCONFIRMED (verify cap)" : `${fmt(n)} ${unit}`);

  /** The line that follows any UNCONFIRMED count, so nobody reads a missing
   *  number as an empty result. */
  const unreadNote = () =>
    "  the verify count is UNREAD, not zero — the writes above reconciled and are durable.";

  return {
    RUN_MINUTES, BUDGET_MS, RESERVE_MS, VERIFY_MS,
    startedAt, left, outOfClock, stoppedAtBudget, describe,
    capped, shown, unreadNote,
    /** True once a verify cap fired — an abandoned request may still hold a
     *  handle, so the lane MUST exit explicitly rather than wait for a drain. */
    capFired: () => capFired,
  };
}


/** ── THE LANE MUST EXIT WHEN ITS WORK IS DONE ──────────────────────────────
 *
 * CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809).
 *
 * Four APPLY shards of retire-self-derived-identities — runs 33975816175,
 * 33975825863, 33975834391, 33975840824 — each printed their banner, their
 * `RECONCILE ... BALANCES` and their `reconciled: intended ... = written ...
 * + skipped ...`, and were then killed by
 *
 *   ##[error] The action 'Run backfill (APPLY)' has timed out after 150 minutes
 *
 * with NOTHING printed in between. Slot 1's last line was 17:22:23; the kill
 * landed 18:17:31 — 55 minutes of silence. Slot 2 was silent for 123 minutes.
 * Not one of the four ever printed a `VERIFY BY READ` line at all.
 *
 * That is not a slow verify. A slow verify still prints when its cap fires.
 * This was the process REFUSING TO EXIT: `main()` had resolved, and node sat
 * on a live handle until the runner killed it. The handle came from the
 * verify's abandoned Cosmos query — `Promise.race` picks a winner and walks
 * away from the loser, and the loser was a query inside the lane's `retry()`,
 * which keeps sleeping on REF'd timers and re-issuing the request. The
 * connection policy compounded it (`maxWaitTimeInSeconds: 300`), so the SDK
 * was itself still retrying throttles.
 *
 * The lesson generalises past this one lane, and past Cosmos: a lane that
 * ends by letting the event loop drain is betting that every library it
 * touched released every handle. That bet is worth 150 minutes of a runner
 * and the exit code of a run whose data was already correct and durable.
 *
 * So a lane does not END. It EXITS — explicitly, after its last line is
 * flushed, with the code it means. All 62 budgeted lanes ended with only a
 * `main().catch(... process.exit(non-zero))`: a failure path that exits and a
 * SUCCESS path that hopes. That asymmetry is the bug, and this closes it.
 *
 * Flushing is not optional either. `process.exit()` truncates a pipe that has
 * not drained, and the runner reads this lane through `| tee /tmp/backfill.log`
 * — a pipe, not a TTY, so stdout is ASYNCHRONOUS. Exiting without waiting
 * would drop the very reconcile lines the relaunch gate greps for
 * (CF-RELAUNCH-ONLY-ON-BUDGET). So: flush, then exit.
 */
async function flushStdio() {
  // Wait for each stream's buffer to drain, but never forever — a wedged pipe
  // must not become a new way to hold the process open.
  await Promise.all(["stdout", "stderr"].map((name) => {
    const s = process[name];
    if (!s || typeof s.write !== "function" || s.writableLength === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      s.write("", finish);
      const t = setTimeout(finish, 2000);
      if (t.unref) t.unref();
    });
  }));
}

/**
 * End a lane: flush what it printed, then exit with `code`.
 *
 * @param {number}  [code]        exit code (0 = the work is done)
 * @param {object}  [opts]
 * @param {object}  [opts.client] a CosmosClient to dispose before exiting
 * @param {Function}[opts.budget] the lane's budget(), so a fired verify cap
 *                                is named in the log as the reason the exit
 *                                had to be explicit
 */
const EXIT_CLEANUP_CAP_MS = Number(process.env.LANE_EXIT_CAP_MS || 5000);

/**
 * Run cleanup under a HARD cap. Whatever `work` is still doing when the cap
 * fires is abandoned, because the caller is about to `process.exit` and an
 * abandoned handle cannot outlive the process.
 *
 * The timer is unref'd here, and that is safe ONLY because process.exit()
 * follows unconditionally on the very next line of every caller: unlike the
 * verify cap in capped() -- which must be REF'd so node cannot exit before
 * the cap reports -- nothing here needs to be reported. If node drains and
 * exits early, the lane has exited, which is the goal.
 */
async function underExitCap(work) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(work).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, EXIT_CLEANUP_CAP_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
  } catch { /* a cap is not a failure */ }
  finally { if (timer) clearTimeout(timer); }
}

async function finishLane(code = 0, opts = {}) {
  const { client, budget: b } = opts;

  if (b && typeof b.capFired === "function" && b.capFired()) {
    // Name it, so the operator reading the log knows the exit was forced and
    // that the UNCONFIRMED count above is the reason — not a crash.
    console.log("  the verify cap fired — exiting explicitly so an abandoned"
      + " query cannot hold the step to the ceiling.");
  }

  // CF-A-LANE-EXITS-UNCONDITIONALLY (2026-09-05). #1809 made every lane CALL
  // this function, and four sharded APPLY runs of retire-self-derived-
  // identities dispatched AFTER it merged (bf47ba1, 21:30Z) STILL hit
  // "The action 'Run backfill (APPLY)' has timed out after 150 minutes" —
  // runs 33993974633, 33994076178, 33994101308 and 33994112578, every one of
  // them having already printed its full RECONCILE and its
  // "reconciled: intended … = written … + skipped …".
  //
  // So the call was reached and the process still did not exit. The reason is
  // that this function AWAITED its cleanup. Against the pin's fake container
  // both awaits settle instantly; against the real @azure/cosmos SDK, with an
  // abandoned cross-partition request still pending, they need not settle at
  // all — `dispose()` tears down an agent whose sockets are mid-request, and
  // `flushStdio` waits on a `write` callback from a pipe whose reader (`tee`)
  // is not draining. An await that never resolves is the same bug #1809 set
  // out to kill, one frame further in: the exit line is never reached.
  //
  // The guarantee is therefore restated as: cleanup is BEST-EFFORT and CAPPED;
  // the exit is UNCONDITIONAL. Everything below runs under one short cap, and
  // the explicit exit below is reached whether that cleanup finished, threw, or
  // is still running. Tidiness may be sacrificed; the exit may not be.
  await underExitCap(async () => {
    try {
      // Disposing closes the SDK's keep-alive sockets. It is documented as
      // synchronous, but a version that returns a promise (or one that hangs
      // on an in-flight request) must not be able to strand the exit, so it
      // is awaited INSIDE the cap rather than outside it.
      if (client && typeof client.dispose === "function") await client.dispose();
    } catch { /* never let cleanup fail a run whose writes already reconciled */ }
    await flushStdio();
  });

  // THE OPERATOR'S PROOF. A log that ends at the reconcile leaves "did it
  // exit, or was it killed?" unanswerable — which is exactly the question the
  // four timed-out runs above posed. This line is the answer, and it is
  // written with a SYNCHRONOUS `writeSync` rather than console.log because a
  // buffered write on a wedged pipe is precisely what could not be relied on
  // to arrive.
  try {
    require("node:fs").writeSync(1, "finishLane: exiting code " + code + "\n");
  } catch { /* the exit matters, the narration does not */ }

  process.exit(code);
}

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const fmtMs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

module.exports = { budget, runMinutes, finishLane, flushStdio };
