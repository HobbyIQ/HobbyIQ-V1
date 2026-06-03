// CF-PAYMENTS-B1 (2026-06-02): time-windowed usage counter logic.
//
// Single responsibility: window-key derivation + reset-at-read logic.
// Storage is delegated to setUserUsageCounter in authService.ts. The
// service has NO knowledge of Cosmos, no caching, no concurrency control.
//
// Window keys (UTC):
//   priceChecksPerDay -> windowKey = "YYYY-MM-DD" (calendar day, UTC)
//   scansPerMonth     -> windowKey = "YYYY-MM"    (calendar month, UTC)
//
// Reset model: at READ time, if the stored windowKey != currentWindowKey,
// the count is TREATED AS 0 (we don't write the reset until the next
// increment). This keeps reads side-effect-free; a stale row that never
// gets hit again just stays stale at rest.

import type { AuthUser } from "../authService.js";
import { setUserUsageCounter, type UsageCap } from "../authService.js";

export type RateCap = "priceChecksPerDay" | "scansPerMonth";

/**
 * Map the public-facing entitlements cap key to the user-doc storage key.
 * The public side uses descriptive names that match the entitlements
 * matrix; the storage side uses short keys to keep the Cosmos doc
 * compact.
 */
const STORAGE_KEY: Record<RateCap, UsageCap> = {
  priceChecksPerDay: "priceChecks",
  scansPerMonth:     "scans",
};

/**
 * Current UTC window key for the given cap. Pure function — no Date.now()
 * is hidden behind a state mutation, so tests can override the clock by
 * passing a fixed Date.
 *
 * The runtime clock-block (Date.now()/new Date() throw without args during
 * resumable workflow runs) is not applicable here: this is a regular
 * Express request handler, not a Workflow script.
 */
export function currentWindowKey(cap: RateCap, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  if (cap === "scansPerMonth") return `${y}-${m}`;
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Read the current count for this user + cap. Returns 0 if no row exists
 * OR if the stored windowKey is from a previous window (reset on read).
 *
 * Reads from the AuthUser carried on the request by requireSession; no
 * additional Cosmos round-trip.
 */
export function getUsageCount(
  user: AuthUser,
  cap: RateCap,
  now: Date = new Date(),
): number {
  const storageKey = STORAGE_KEY[cap];
  const entry = user.usage?.[storageKey];
  if (!entry) return 0;
  if (entry.windowKey !== currentWindowKey(cap, now)) return 0;
  return entry.count;
}

/**
 * Increment the user's counter for this cap by 1. Handles the window
 * reset: if the stored windowKey doesn't match the current window, the
 * write reinitializes to {windowKey: current, count: 1}. Otherwise
 * increments the existing count.
 *
 * Caller (requireRateLimited) invokes this from res.on("finish") AFTER a
 * 2xx response so only successful gated calls count.
 */
export async function incrementUsage(
  user: AuthUser,
  cap: RateCap,
  now: Date = new Date(),
): Promise<void> {
  const storageKey = STORAGE_KEY[cap];
  const windowKey = currentWindowKey(cap, now);
  const existing = user.usage?.[storageKey];
  const nextCount = existing?.windowKey === windowKey ? existing.count + 1 : 1;
  await setUserUsageCounter(user.userId, storageKey, { windowKey, count: nextCount });
}
