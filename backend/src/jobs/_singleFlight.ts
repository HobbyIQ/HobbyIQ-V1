// CF-JOB-SINGLE-FLIGHT (2026-08-20) — one worker per scheduled cycle.
//
// THE BUG THIS FIXES. Every start*Job() in server.ts arms a setInterval (and
// usually a first-run setTimeout) INSIDE the API process. App Service runs
// numberOfWorkers=2, so every one of those timers exists twice and every
// scheduled cycle runs twice, concurrently, on the same data.
//
// Measured in hobbyiq-insights, 3h window, log lines grouped by tag:
//
//     [price.alert.evaluator]      19 lines   dcount(cloud_RoleInstance) = 2
//     [portfolio.reprice.job]       7 lines   dcount(cloud_RoleInstance) = 2
//     [advanced.alert.evaluator]    7 lines   dcount(cloud_RoleInstance) = 2
//     [buyeriq.deal.scanner]        6 lines   dcount(cloud_RoleInstance) = 2
//     [ebay.order.poll.job]         6 lines   dcount(cloud_RoleInstance) = 2
//     [ebay.finances.enrichment]    5 lines   dcount(cloud_RoleInstance) = 2
//
// Consequences range from wasteful to user-visible: price.alert.evaluator
// evaluating every alert twice is how a user gets two push notifications for
// one event, and portfolio.reprice reprices every holding twice.
//
// This was found via the CardHedge delta poll, whose vendor calls made the
// duplication visible in request telemetry. That job has since been deleted;
// the pattern it exposed had nothing to do with CardHedge.
//
// HOW THE LOCK BEHAVES. Redis SET NX EX. The TTL is sized under the job's own
// interval and capped (see leaseTtlSeconds): long enough to lock out the
// sibling worker whose timer fires milliseconds later, short enough to always
// expire before the next cycle, so a worker that dies mid-cycle costs at most
// ONE skipped run rather than wedging the job forever.
//
// FAILURE MODES ARE DELIBERATE, IN BOTH DIRECTIONS:
//   - No REDIS_HOST: cacheAcquireLock falls back to a per-process memory map,
//     so every worker acquires and behaviour is exactly what it is today.
//     Duplicated, never stopped.
//   - Redis throws: proceed. A Redis blip must not silently halt every
//     scheduled job on every worker at once. Duplicate work is recoverable;
//     a fleet of jobs that quietly stopped is not.
//
// TWO KEYS, TWO JOBS (2026-09-07). Mutual exclusion and cadence used to be the
// same Redis key, and that conflation is what wedged the jobs. They are now
// separate:
//
//   lock:job:<key>   the LEASE. Short (capped at 15 min), crash-recoverable.
//                    Answers "is a sibling worker mid-cycle right now?".
//   cadence:job:<key> the DUE MARKER. Written for the full interval AFTER a
//                    cycle completes. Answers "has this interval's cycle
//                    already happened?".
//
// This is what lets a caller tick every 5 minutes on a process that only lives
// 10 while still running exactly one cycle per hour: the fast tick keeps the
// job reachable across restarts, and the cadence marker — which outlives every
// process — is what stops it running twelve times.
//
// A caller that ticks AT its interval is unaffected: the marker has expired by
// the time the next tick arrives.
//
// The lease is NOT released when the cycle finishes — releasing it immediately
// would let the sibling worker take it and run the same cycle anyway. It
// expires on its TTL.
//
// TTL IS CAPPED, AND WHY (2026-09-07). The header above claims a dead worker
// "costs at most ONE skipped run rather than wedging the job forever". That was
// only true for the 30-60min jobs it was measured on. `intervalMs/1000 - 60`
// means the DAILY jobs (dailyiq, subscriptionsSafetyNet, matchedCohort) took a
// 23-HOUR lease, and buyeriq.deal.scanner a 59-minute one.
//
// That is a wedge, because App Service does not keep the process alive that
// long. Measured on HobbyIQ3 (2026-09-07, hobbyiq-insights): both workers
// re-armed every scheduler SEVEN times in 45 minutes — restart gaps of 19.4,
// 8.5 and 13.6 minutes. A 60-minute setInterval on a process that lives ~10
// minutes NEVER FIRES; the only cycle that ever runs is the first-delay
// timeout. When that first run took a 59-minute lease and the worker was
// recycled two minutes later, every subsequent boot for the rest of the hour
// logged "cycle skipped — another worker holds the lock" against a lock whose
// owner no longer existed. Seven boots, three scans.
//
// So the lease is capped at LOCK_TTL_CAP_SECONDS: long enough to exclude the
// sibling worker (whose timer fires milliseconds later) and to cover a slow
// cycle, short enough that a crashed owner's lock is reclaimable on the next
// boot instead of at the next interval. The floor stays 60s and the lease is
// still never longer than the interval itself.

import { cacheAcquireLock, cacheGet, cacheSet } from "../services/shared/cache.service.js";

/**
 * Longest a single-flight LEASE may live, in seconds (15 min).
 *
 * A crashed owner's lease must be reclaimable within roughly one App Service
 * recycle, not at the next interval. Exported for the pins.
 */
export const LOCK_TTL_CAP_SECONDS = 15 * 60;

/**
 * How often a scheduler should re-check whether its cycle is owed, given the
 * job's real interval.
 *
 * WHY THIS EXISTS. setInterval(intervalMs) only fires if the process survives
 * intervalMs. On HobbyIQ3 it does not: measured 2026-09-07, both workers
 * re-armed every scheduler seven times in 45 minutes. So every interval timer
 * of an hour or more had NEVER fired in production — the only cycles that ran
 * were first-delay timeouts, at whatever cadence App Service happened to
 * recycle.
 *
 * Ticking on this shorter period keeps the job reachable across restarts; the
 * cadence marker inside runSingleFlight is what still holds it to one cycle
 * per interval. Jobs whose interval is already short tick at their interval.
 */
export function schedulerTickMs(intervalMs: number): number {
  return Math.min(intervalMs, TICK_CEILING_MS);
}

/** Longest a scheduler may go between re-checks (5 min). */
export const TICK_CEILING_MS = 5 * 60 * 1000;

/**
 * The LEASE a job of this interval takes: at least 60s, never longer than the
 * interval, and never longer than LOCK_TTL_CAP_SECONDS. Exported for the pins.
 */
export function leaseTtlSeconds(intervalMs: number): number {
  const interval = Math.floor(intervalMs / 1000);
  const underInterval = Math.min(interval, Math.max(60, interval - 60));
  return Math.max(60, Math.min(LOCK_TTL_CAP_SECONDS, underInterval));
}

/**
 * Run `cycle` only if this worker wins the lease for `jobKey` AND this
 * interval's cycle is not already done.
 *
 * Never throws and never rejects on the coordination path: a lease failure
 * resolves to running the cycle, and the cycle's own errors are the caller's
 * to handle exactly as before (this returns the cycle's promise).
 *
 * @param jobKey      stable identifier, also used in the skip log line
 * @param intervalMs  the job's scheduling interval: sizes the lease and the
 *                    cadence marker. Pass the real interval even when ticking
 *                    faster than it.
 */
export async function runSingleFlight(
  jobKey: string,
  intervalMs: number,
  cycle: () => Promise<unknown>,
): Promise<void> {
  const cadenceKey = `cadence:job:${jobKey}`;
  const cadenceSeconds = Math.max(60, Math.floor(intervalMs / 1000));

  // Has this interval's cycle already run? Cheap read first, so a fast tick
  // costs one GET rather than churning the lease.
  try {
    if (await cacheGet(cadenceKey)) return;
  } catch {
    // Unreadable cadence marker must not stop the job; fall through and let
    // the lease decide.
  }

  let acquired = true;
  try {
    acquired = await cacheAcquireLock(`lock:job:${jobKey}`, leaseTtlSeconds(intervalMs));
  } catch {
    // Belt and braces — cacheAcquireLock already swallows Redis errors and
    // returns true. If anything else goes wrong, still run rather than
    // silently skip.
    acquired = true;
  }

  if (!acquired) {
    console.log(`[${jobKey}] cycle skipped — another worker holds the lock`);
    return;
  }

  try {
    await cycle();
  } finally {
    // Mark the interval done even if the cycle threw: a cycle that fails every
    // time must not become a hot loop on a fast tick. The caller still sees
    // the rejection.
    try {
      await cacheSet(cadenceKey, String(Date.now()), cadenceSeconds);
    } catch { /* soft — worst case the cycle is retried next tick */ }
  }
}
