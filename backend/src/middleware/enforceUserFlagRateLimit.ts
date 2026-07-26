// CF-USER-FLAG-RATE-LIMIT (Drew, 2026-07-26, prod-readiness audit P0.2).
// Per-user daily cap on comp-flagging endpoints. Both /comps/flag-wrong
// (legacy) and /flag-comp (new) let a single user drop FMV rows from
// the pool — without this middleware a bad-faith user can spam-flag
// every comp on a hot rookie in minutes and poison FMV globally.
//
// Design:
// - In-memory Map keyed by userId → { count, resetAt }. Fine for the
//   single App Service instance; on restart the counter resets which
//   is intentionally forgiving (bounded by process uptime).
// - Cap defaults to 20 flags per 24h. Configurable via
//   USER_FLAG_RATE_LIMIT_PER_DAY env var.
// - When exceeded: 429 with a "cooldown" body iOS can render as a
//   friendly "you've flagged a lot today — try again in Nh" toast.
//
// NOTE: this is defense-in-depth alongside the threshold-based
// auto-filter (default 3 distinct users required before "user-flagged"
// applies). The rate limit prevents one script from being 20 different
// users worth of threshold.

import type { Request, Response, NextFunction } from "express";

interface Counter {
  count: number;
  resetAt: number;   // epoch ms
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const counters = new Map<string, Counter>();

function cap(): number {
  const raw = process.env.USER_FLAG_RATE_LIMIT_PER_DAY;
  const n = raw ? parseInt(raw, 10) : 20;
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Increment + check. Returns true when the caller is still under cap. */
function tryIncrement(userId: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = counters.get(userId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    counters.set(userId, entry);
  }
  const max = cap();
  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: max - entry.count, resetAt: entry.resetAt };
}

export function enforceUserFlagRateLimit(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.userId;
  if (!userId) {
    // Route should already have run requireSession — belt and suspenders.
    res.status(401).json({ success: false, error: "session required for flag operations" });
    return;
  }
  const { allowed, remaining, resetAt } = tryIncrement(userId);
  if (!allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      success: false,
      error: "Daily flag limit reached. Try again tomorrow.",
      retryAfterSeconds: retryAfterSec,
      limit: cap(),
    });
    return;
  }
  // Advisory header so iOS can render "X flags left today" if desired.
  res.setHeader("X-Flag-Remaining-Today", String(remaining));
  next();
}

/** Test helper — reset the in-memory counters. Not exported to normal callers. */
export function _resetForTests(): void {
  counters.clear();
}
