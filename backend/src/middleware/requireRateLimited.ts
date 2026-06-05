// CF-PAYMENTS-B1 (2026-06-02): requireRateLimited(cap) middleware.
//
// Contract per the HALT spec:
//   "unlimited" -> next() with NO count read (zero-cost for paid tiers).
//   Otherwise read the current count from req.user.usage (already loaded
//   by requireSession; no second Cosmos read).
//     count >= limit  -> 402 { success:false, error:"rate_limit_exceeded",
//                              cap, limit, current, currentTier, requiredTier }
//     count <  limit  -> attach res.on("finish") increment hook then next()
//
// Increment-on-success-only: the hook fires AFTER the response is sent,
// and only increments if statusCode < 400. Handler-thrown errors that
// surface as 5xx via express's error middleware do NOT count against the
// user. Cardsight `200 success:false` outcomes DO count — semantically
// the API call succeeded; whether the card was identified is a separate
// branch the user paid an attempt for.

import type { Request, Response, NextFunction } from "express";
import {
  effectivePlanFor,
  getCap,
  minimumTierForCap,
  type GatedCap,
} from "../config/entitlements.js";
import {
  getUsageCount,
  incrementUsage,
} from "../services/usage/usageCounter.service.js";

// The rate-limit caps are a subset of GatedCap — the time-windowed ones.
export type RateLimitedCap = Extract<GatedCap, "priceChecksPerDay" | "scansPerMonth">;

export function requireRateLimited(cap: RateLimitedCap) {
  return function rateLimitedMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const user = req.user;
    if (!user) {
      res.status(401).json({
        success: false,
        error: "Missing or invalid x-session-id header",
      });
      return;
    }

    // CF-OWNER-OVERRIDE (2026-06-05): gate on EFFECTIVE plan, not raw plan.
    // Comped owners hit the same "unlimited" short-circuit as actual paid
    // tiers — no counter is incremented, no quota is burned.
    const effective = effectivePlanFor(user);
    const limit = getCap(effective, cap);
    if (limit === "unlimited") {
      // Paid tiers short-circuit before any read. No counter is incremented;
      // we only track usage for plans that actually have a finite cap.
      next();
      return;
    }

    const current = getUsageCount(user, cap);
    if (current >= limit) {
      res.status(402).json({
        success: false,
        error: "rate_limit_exceeded",
        cap,
        limit,
        current,
        currentTier: effective,
        requiredTier: minimumTierForCap(cap, current),
      });
      return;
    }

    // Attach the post-response increment hook BEFORE handing off to the
    // handler. "finish" fires once after the body has been fully flushed.
    // Status check filters out 4xx/5xx so failed handlers don't burn the
    // user's daily/monthly quota.
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      // Fire-and-forget: middleware already returned by the time this
      // runs. Errors here can't be surfaced to the client. We log so they
      // don't disappear silently — but we do NOT throw, since unhandled
      // promise rejections would crash the node process.
      incrementUsage(user, cap).catch((err: unknown) => {
        console.error(`[requireRateLimited:${cap}] post-response increment failed:`, err);
      });
    });

    next();
  };
}
