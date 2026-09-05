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
  const capped = async (vt0, label, run) => {
    const remaining = VERIFY_MS - (Date.now() - vt0);
    if (remaining <= 0) {
      console.log(`  VERIFY BY READ  ${label}: could not confirm within the cap (verify-cap)`);
      return null;
    }
    let timer = null;
    try {
      return await Promise.race([
        run(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("verify-cap")), remaining);
          if (timer.unref) timer.unref();
        }),
      ]);
    } catch (e) {
      console.log(`  VERIFY BY READ  ${label}: could not confirm within the cap (${String(e && e.message)})`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
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
  };
}

const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
const fmtMs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

module.exports = { budget, runMinutes };
