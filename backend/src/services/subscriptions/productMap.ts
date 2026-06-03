// CF-PAYMENTS-APPLE-1 (2026-06-03): productId → plan mapping.
//
// Source of truth for the Apple App Store Connect product IDs locked
// 2026-06-03. Drew confirmed monthly-only at launch with period-encoding
// product IDs (`.monthly` suffix) reserving clean naming for future
// quarterly/annual variants.

import type { Plan } from "../../config/entitlements.js";

export const PRODUCT_ID_TO_PLAN: Readonly<Record<string, Plan>> = Object.freeze({
  "com.hobbyiq.collector.monthly":  "collector",
  "com.hobbyiq.investor.monthly":   "investor",
  "com.hobbyiq.proseller.monthly":  "pro_seller",
});

/**
 * Map an Apple productId to the corresponding HobbyIQ plan. Returns null
 * if the productId is unknown — the route handler treats this as
 * 422 unprocessable_entity (do NOT silently downgrade to free; an unknown
 * productId on a verified JWS is a real ops signal — Drew may have added a
 * new product but forgotten the mapping update).
 */
export function productIdToPlan(productId: string | undefined | null): Plan | null {
  if (!productId) return null;
  return PRODUCT_ID_TO_PLAN[productId] ?? null;
}
