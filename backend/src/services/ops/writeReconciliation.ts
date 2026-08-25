// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (Drew, 2026-08-25).
//
// Twice in one day a backfill exited 0, printed DONE, and had written almost
// nothing:
//
//   normalize-catalog-format  changed 13,012,857  wrote 3,931,610
//                             failed  9,081,247   <- every one a 429, dropped
//   repair-refractor-mislabel 3 of 8 workers died mid-scan on a 429 and
//                             reported FATAL, abandoning every year they had
//                             not reached
//
// The first went unnoticed for a day. Nothing was watching, because the only
// signal anyone had was the exit code, and the exit code was 0.
//
// An exit code says a process ended. It does not say the work happened. So
// every job that knows how much work it INTENDED to do must reconcile that
// against what it actually wrote, and must not be allowed to look successful
// when the two disagree.
//
// This is deliberately not a logger. It sets process.exitCode, because the
// only thing a CI dashboard reads is red or green, and a job that dropped 70%
// of its writes has to be red.

export interface WriteReconciliation {
  /** Human name for the banner. */
  job: string;
  /** Rows the job decided needed writing. */
  intended: number;
  /** Rows confirmed written. */
  written: number;
  /** Rows that failed permanently, already counted and reported. */
  failed?: number;
  /** Rows deliberately NOT written -- a guard held them, a destination was
   *  missing. Legitimate, and must be declared so it is not mistaken for loss. */
  skipped?: number;
  /** Fraction of intended writes that may go missing before this is a failure.
   *  Defaults to 0.5% -- large enough for genuine terminal errors, far too
   *  small to hide a throttling collapse. */
  tolerance?: number;
}

export interface ReconciliationResult {
  ok: boolean;
  unaccounted: number;
  shortfallPct: number;
  message: string;
}

/**
 * Reconcile intended-vs-written and make a shortfall impossible to miss.
 *
 * Returns the verdict AND sets process.exitCode on failure, so a job that
 * silently dropped its work turns the workflow red instead of green.
 */
export function reconcileWrites(input: WriteReconciliation): ReconciliationResult {
  const intended = Math.max(0, Math.trunc(input.intended));
  const written = Math.max(0, Math.trunc(input.written));
  const failed = Math.max(0, Math.trunc(input.failed ?? 0));
  const skipped = Math.max(0, Math.trunc(input.skipped ?? 0));
  const tolerance = input.tolerance ?? 0.005;

  // Everything intended must be accounted for as written, deliberately
  // skipped, or explicitly failed. What is left over is work that vanished
  // without anyone naming it -- which is exactly the 9,081,247 case.
  const unaccounted = Math.max(0, intended - written - skipped - failed);
  const shortfallPct = intended > 0 ? unaccounted / intended : 0;
  const ok = unaccounted === 0 || shortfallPct <= tolerance;

  const pct = (n: number) => (n * 100).toFixed(2) + "%";
  const num = (n: number) => n.toLocaleString();

  if (ok) {
    return {
      ok: true,
      unaccounted,
      shortfallPct,
      message:
        `[${input.job}] reconciled: intended ${num(intended)} = written ${num(written)}` +
        (skipped ? ` + skipped ${num(skipped)}` : "") +
        (failed ? ` + failed ${num(failed)}` : "") +
        (unaccounted ? ` (${num(unaccounted)} unaccounted, within tolerance)` : ""),
    };
  }

  const message = [
    "",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    `!! ${input.job}: WORK VANISHED`,
    "!!",
    `!!   intended     ${num(intended).padStart(12)}`,
    `!!   written      ${num(written).padStart(12)}`,
    `!!   skipped      ${num(skipped).padStart(12)}   (declared, deliberate)`,
    `!!   failed       ${num(failed).padStart(12)}   (declared, reported)`,
    `!!   UNACCOUNTED  ${num(unaccounted).padStart(12)}   ${pct(shortfallPct)} of intended`,
    "!!",
    "!! This job did not write the work it said it would, and did not report",
    "!! the difference as a failure. Do not treat this run as complete.",
    "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "",
  ].join("\n");

  // Red, not green. The dashboard only reads this.
  if (typeof process !== "undefined") process.exitCode = 4;

  return { ok: false, unaccounted, shortfallPct, message };
}

/** Print the verdict on the right stream and return it. */
export function reportWrites(input: WriteReconciliation): ReconciliationResult {
  const r = reconcileWrites(input);
  if (r.ok) console.log(r.message);
  else console.error(r.message);
  return r;
}
