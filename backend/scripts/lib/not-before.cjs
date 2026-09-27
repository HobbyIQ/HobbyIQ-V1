// CF-CLEANLINESS-SETTLE-ON-REPORT-DOC (review, 2026-09-27) — shared by
// wait-for-doc.cjs and check-anomaly-scan-report.cjs, both of which guard
// the same same-day stale-doc hazard: the anomaly-scan-report id is
// date-only, so a same-day workflow_dispatch re-run can find an EARLIER
// run's doc under the same id. Both scripts accept a doc only if its own
// `computedAt` is not older than the caller's dispatch-time bound.
//
// TWO DEFECTS FIXED HERE vs. the first cut of this guard (caught in
// re-review):
//
//   1. STRING COMPARISON ON ISO TIMESTAMPS IS WRONG. DISPATCHED_AT is
//      stamped by `date -u +%Y-%m-%dT%H:%M:%SZ` (no milliseconds);
//      anomaly-force-scan.cjs stamps computedAt with
//      `new Date().toISOString()` (WITH milliseconds). Lexicographic
//      string order puts "03:00:00.500Z" BEFORE "03:00:00Z" (the literal
//      character "." sorts before "Z"), so a doc computed 500ms after the
//      bound could still fail a `computedAt >= notBefore` STRING compare.
//      It fails safe (treats a fresh doc as stale, so it keeps waiting
//      rather than accepting a stale one) but it is still the wrong
//      comparison. Fixed by parsing both sides with Date.parse and
//      comparing epoch milliseconds, with a small tolerance for runner
//      clock skew between the dispatch step's shell `date -u` and the read
//      step's Node `Date.now()` (different processes, sometimes different
//      runners).
//
//   2. AN EMPTY OR MALFORMED BOUND MUST NEVER SILENTLY DISABLE THE GUARD.
//      The first cut used `if (notBefore && ...)`, so an env var that was
//      set-but-empty, or set to something that doesn't parse as a date,
//      skipped the check entirely -- exactly the failure mode the guard
//      exists to close, just reached a different way. The workflow ALWAYS
//      sets WAIT_FOR_DOC_NOT_BEFORE / ANOMALY_NOT_BEFORE from its own
//      DISPATCHED_AT, so an unparseable value here means the WIRING is
//      broken, not that the guard is optional. `requireNotBefore` fails
//      fast (throws) in that case instead of quietly waiving the check.
"use strict";

/** Clock-skew tolerance between the shell `date -u` in the dispatch step
 *  and the Node `Date.now()` in the read/wait steps (different processes,
 *  sometimes different runners). */
const CLOCK_SKEW_TOLERANCE_MS = 5000;

/**
 * Parses a required not-before bound. Throws (never silently disables the
 * guard) when the value is missing, empty, or does not parse as a date.
 * @param {string | undefined | null} raw
 * @returns {number} epoch milliseconds
 */
function requireNotBefore(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("not-before bound is required and must not be empty (the workflow always "
      + "sets it from its own DISPATCHED_AT — an empty value means the wiring is broken, not "
      + "that this check is optional)");
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`not-before bound "${raw}" does not parse as a date`);
  }
  return ms;
}

/**
 * True when `computedAt` (a doc's own stamp) is at or after `notBeforeMs`
 * (epoch ms from requireNotBefore), allowing CLOCK_SKEW_TOLERANCE_MS of
 * slack. Compares parsed epoch milliseconds, never raw strings -- the two
 * sides have different ISO precision (no ms vs. with ms) and string order
 * does not agree with chronological order across that boundary.
 * @param {string} computedAt
 * @param {number} notBeforeMs
 * @returns {boolean}
 */
function isFreshEnough(computedAt, notBeforeMs) {
  const computedMs = Date.parse(computedAt);
  if (!Number.isFinite(computedMs)) return false;
  return computedMs >= notBeforeMs - CLOCK_SKEW_TOLERANCE_MS;
}

module.exports = { requireNotBefore, isFreshEnough, CLOCK_SKEW_TOLERANCE_MS };
