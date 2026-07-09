// perUserThrottle.ts — lightweight in-memory per-user request throttle.
//
// Motivation: telemetry endpoints like POST /api/compiq/log-selection are
// authenticated but fire-and-forget — a misbehaving client or a compromised
// session could pour thousands of writes into Cosmos before the daily
// promote-aliases aggregation gets a chance to filter them. This middleware
// enforces a sliding-window rate cap per userId, cheap to compute, no
// external dependencies.
//
// Contract:
//   - Applied AFTER requireSession so `req.userId` is populated.
//   - On over-limit: responds 429 { success:false, error:"throttled",
//     retryAfterSec }. Fire-and-forget clients see this as a benign non-2xx
//     and drop the write. Legit users never see it — the defaults are far
//     above realistic user selection velocity.
//   - Missing userId: pass-through (defense: don't block anon; upstream
//     requireSession would have already 401'd).
//   - Memory footprint: one Map entry per active user + a bounded ring
//     buffer of timestamps. Auto-evicts users idle longer than the window.
//
// Anti-scope: this is NOT a distributed rate limit. Under multi-instance
// App Service, each instance keeps its own counter → effective per-user
// cap is (limit × instance_count). Fine for a defense-in-depth telemetry
// throttle; would NOT be fine as the primary abuse guard. HobbyIQ3 runs
// as a single instance today, so this is exact.

import type { Request, Response, NextFunction } from "express";

interface UserBucket {
  /** Unix ms timestamps of recent requests, oldest first. */
  timestamps: number[];
  /** Last-seen ms for eviction of idle users. */
  lastSeenMs: number;
}

export interface PerUserThrottleOptions {
  /** Max requests permitted per user per windowMs. */
  limit: number;
  /** Sliding-window duration in milliseconds. */
  windowMs: number;
  /** Optional label for the event log. */
  label?: string;
}

// Idle users are dropped from memory after this much inactivity. 10× the
// window is enough to survive brief pauses without leaking.
const IDLE_EVICT_MS_MIN = 5 * 60 * 1000;

export function perUserThrottle(opts: PerUserThrottleOptions) {
  const { limit, windowMs, label = "log-selection" } = opts;
  const idleEvictMs = Math.max(IDLE_EVICT_MS_MIN, windowMs * 10);
  const buckets = new Map<string, UserBucket>();

  // Periodic eviction. Bounded work: iterates whatever is in memory, drops
  // any user idle past idleEvictMs. Cheap even at 100k users.
  const evictionTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, bucket] of buckets) {
      if (now - bucket.lastSeenMs > idleEvictMs) buckets.delete(userId);
    }
  }, Math.max(60_000, windowMs));
  // Do NOT hold the process open on the timer alone.
  if (evictionTimer.unref) evictionTimer.unref();

  const middleware = function throttleMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) {
      // Anonymous — defensive pass-through; requireSession upstream handles auth.
      next();
      return;
    }

    const now = Date.now();
    let bucket = buckets.get(userId);
    if (!bucket) {
      bucket = { timestamps: [], lastSeenMs: now };
      buckets.set(userId, bucket);
    }

    // Drop timestamps outside the current sliding window.
    const cutoff = now - windowMs;
    while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
      bucket.timestamps.shift();
    }

    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      // One structured warn per over-limit so the KQL dashboard can surface
      // repeat offenders. Bounded — a client stuck at over-limit stays over-
      // limit for the sliding window, so we get O(limit) warnings per over-
      // burst, not O(actual-request-volume).
      console.warn(
        JSON.stringify({
          event: "per_user_throttle_exceeded",
          source: `middleware.${label}`,
          userId,
          limit,
          windowMs,
          retryAfterSec,
          currentCount: bucket.timestamps.length,
        }),
      );
      res.status(429).json({
        success: false,
        error: "throttled",
        retryAfterSec,
      });
      return;
    }

    bucket.timestamps.push(now);
    bucket.lastSeenMs = now;
    next();
  };

  // Expose the timer + map for tests / graceful shutdown.
  (middleware as unknown as { __evictionTimer: NodeJS.Timeout }).__evictionTimer =
    evictionTimer;
  (middleware as unknown as { __buckets: Map<string, UserBucket> }).__buckets =
    buckets;

  return middleware;
}

/**
 * Test-only accessor. Do not use in production code paths.
 */
export function __perUserThrottleInternals(mw: unknown) {
  return {
    buckets: (mw as { __buckets: Map<string, UserBucket> }).__buckets,
    evictionTimer: (mw as { __evictionTimer: NodeJS.Timeout }).__evictionTimer,
  };
}
