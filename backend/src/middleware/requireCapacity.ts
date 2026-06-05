// CF-PAYMENTS-A (2026-06-02): requireCapacity(cap, countFn) middleware.
//
// For WRITE-COUNTED caps (holdingsCap, priceAlerts) — counts the user's
// current resources via the injected countFn, compares against
// ENTITLEMENTS[plan].caps[cap], and rejects with 402 if creating a new
// resource would exceed the limit.
//
// Time-windowed caps (priceChecksPerDay, scansPerMonth) are NOT handled by
// this middleware in Phase A — they need a usage-counter store (proposed
// in the HALT, deferred to Phase B).
//
// Contract:
//   200 path:    next() if cap is "unlimited" OR currentCount < limit.
//   401 path:    if req.user missing.
//   402 path:    { success: false, error: "capacity_exceeded",
//                  cap, limit, current, currentTier, requiredTier }

import type { Request, Response, NextFunction } from "express";
import {
  effectivePlanFor,
  getCap,
  minimumTierForCap,
  type GatedCap,
} from "../config/entitlements.js";

export type CountFn = (userId: string) => Promise<number>;

export function requireCapacity(cap: GatedCap, countFn: CountFn) {
  return async function capacityMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = req.user;
    if (!user) {
      res.status(401).json({
        success: false,
        error: "Missing or invalid x-session-id header",
      });
      return;
    }

    // CF-OWNER-OVERRIDE (2026-06-05): gate on EFFECTIVE plan, not raw plan.
    const effective = effectivePlanFor(user);
    const limit = getCap(effective, cap);
    if (limit === "unlimited") {
      next();
      return;
    }

    let current: number;
    try {
      current = await countFn(user.userId);
    } catch (err: unknown) {
      // If we can't count, fail closed — better than letting the user
      // exceed the limit silently. Surface as 500.
      console.error(`[requireCapacity:${cap}] count failed:`, err);
      res.status(500).json({
        success: false,
        error: "capacity_check_failed",
        cap,
      });
      return;
    }

    if (current < limit) {
      next();
      return;
    }

    res.status(402).json({
      success: false,
      error: "capacity_exceeded",
      cap,
      limit,
      current,
      currentTier: effective,
      requiredTier: minimumTierForCap(cap, current),
    });
  };
}
