// CF-PAYMENTS-A (2026-06-02): requireEntitlement(feature) middleware.
//
// Reads req.user.plan (set by requireSession upstream) and checks the
// entitlements matrix. On failure returns 402 Payment Required with a
// shape iOS uses to surface "upgrade to <requiredTier>" paywalls.
//
// Contract:
//   200 path:    next() if req.user.plan grants the feature.
//   401 path:    if req.user is missing (caller forgot requireSession).
//   402 path:    { success: false, error: "subscription_required",
//                  requiredTier, currentTier, feature }

import type { Request, Response, NextFunction } from "express";
import {
  hasEntitlement,
  minimumTierFor,
  type GatedFeature,
} from "../config/entitlements.js";

export function requireEntitlement(feature: GatedFeature) {
  return function entitlementMiddleware(
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
    if (hasEntitlement(user.plan, feature)) {
      next();
      return;
    }
    res.status(402).json({
      success: false,
      error: "subscription_required",
      feature,
      currentTier: user.plan,
      requiredTier: minimumTierFor(feature),
    });
  };
}
