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
// HOW THE LOCK BEHAVES. Redis SET NX EX. TTL is one minute under the job's own
// interval: long enough to lock out the sibling worker whose timer fires
// milliseconds later, short enough to always expire before the next cycle, so
// a worker that dies mid-cycle costs at most ONE skipped run rather than
// wedging the job forever.
//
// FAILURE MODES ARE DELIBERATE, IN BOTH DIRECTIONS:
//   - No REDIS_HOST: cacheAcquireLock falls back to a per-process memory map,
//     so every worker acquires and behaviour is exactly what it is today.
//     Duplicated, never stopped.
//   - Redis throws: proceed. A Redis blip must not silently halt every
//     scheduled job on every worker at once. Duplicate work is recoverable;
//     a fleet of jobs that quietly stopped is not.
//
// The lock is NOT released when the cycle finishes — releasing it immediately
// would let the sibling worker take it and run the same cycle anyway. It
// expires on its TTL.

import { cacheAcquireLock } from "../services/shared/cache.service.js";

/**
 * Run `cycle` only if this worker wins the lock for `jobKey`.
 *
 * Never throws and never rejects: a lock failure resolves to running the
 * cycle, and the cycle's own errors are the caller's to handle exactly as
 * before (this returns the cycle's promise).
 *
 * @param jobKey      stable identifier, also used in the skip log line
 * @param intervalMs  the job's scheduling interval, used to size the TTL
 */
export async function runSingleFlight(
  jobKey: string,
  intervalMs: number,
  cycle: () => Promise<unknown>,
): Promise<void> {
  const ttlSeconds = Math.max(60, Math.floor(intervalMs / 1000) - 60);

  let acquired = true;
  try {
    acquired = await cacheAcquireLock(`lock:job:${jobKey}`, ttlSeconds);
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

  await cycle();
}
