// Centralized constants for pricing engines.
//
// CF-CONSTANTS-FOUNDATION (audit PR #481, 2026-07-15): consolidated the
// raw multiplier literals scattered across compiq.routes / compiqEstimate
// / responseAssembly / observedGradeCurve. The audit flagged 15+ sites
// duplicating the same values; each duplication is a future drift risk.
//
// Rule: any FMV-derived value (quickSale, premium, suggestedList, buyZone,
// sellZone) MUST derive from one of the named consts below, never from a
// raw numeric literal. Sites with intentionally-different multipliers
// (projection tiers, scarcity tiers) get their own named const with a
// comment justifying the value.

export const DEFAULT_MARKET_FEE_PCT = 0.13;
export const DEFAULT_SHIPPING_COST = 5;
export const SCORE_CLAMP_MIN = 0;
export const SCORE_CLAMP_MAX = 100;

// Tunable multipliers and thresholds
export const REGIME_MULTIPLIER_RANGE = { min: 0.90, max: 1.10 };
export const TIMING_MULTIPLIER_RANGE = { min: 0.90, max: 1.15 };
export const RISK_MULTIPLIER_RANGE = { min: 0.80, max: 1.00 };
export const LIQUIDITY_MULTIPLIER_RANGE = { min: 0.92, max: 1.08 };
export const HOBBY_PREMIUM_MAX = 1.15;
export const POP_PRESSURE_MIN = 0.85;

// ── FMV-derived headline multipliers ─────────────────────────────────
//
// SUCCESS-PATH values (engine emits from PriceDistributionEngine when
// the pipeline can price honestly):
//   quickSaleValue = fmv × QUICK_SALE_MULTIPLIER
//   premiumValue   = fmv × PREMIUM_MULTIPLIER
//   suggestedListPrice = fmv × SUGGESTED_LIST_MULTIPLIER
//
// FALLBACK values (routes reach these when engine didn't emit — thin
// pool, variant-mismatch pre-CF-VARIANT-MEDIAN, sibling-pool synth).
// Deliberately slightly narrower than success-path (fmv is more
// uncertain in fallback paths, so quick-sale sits closer to fmv):
//   quickSaleValue = fmv × QUICK_SALE_FALLBACK_MULTIPLIER
//
// See backend/src/services/portfolioiq/responseAssembly.ts:22-23 for
// the original rationale comment (pre-refactor).
export const QUICK_SALE_MULTIPLIER = 0.85;
export const QUICK_SALE_FALLBACK_MULTIPLIER = 0.88;
export const PREMIUM_MULTIPLIER = 1.15;
export const SUGGESTED_LIST_MULTIPLIER = 1.05;

// Buy / hold / sell zone edges (fraction of the anchor). Symmetric
// around FMV: buyZone = [fmv × BUY_LOW, quickSaleValue], sellZone =
// [fmv, premiumValue].
export const BUY_ZONE_LOW_MULTIPLIER = 0.9;
export const HOLD_ZONE_HIGH_MULTIPLIER = 1.0;

// ── Projection-tier multipliers (INTENTIONALLY different) ─────────────
// These are NOT drift — each tier represents a different confidence
// stratum. Product-family projection is a broader tier than parallel-
// floor; scarcity floors are broader still. Each tier's quick-sale
// multiplier reflects the seller's likely realizable price when the
// projection anchor is looser than a direct-comp median.

// product-family-projection + parallel-floor-projection paths.
// See compiqEstimate.service.ts:4210 (family), :4384 (parallel floor).
export const PROJECTION_QUICK_SALE_MULTIPLIER = 0.9;
export const PROJECTION_PREMIUM_MULTIPLIER = 1.15;

// scarcity-prior-floor path — wider spread reflecting cross-player anchor.
// See compiqEstimate.service.ts:4481 (scarcity quick), :4567 (scarcity
// quick alt), :4568 (scarcity premium). The 4481 site uses 0.85 (same
// as QUICK_SALE_MULTIPLIER) — intentionally aligning scarcity with the
// success-path quick-sale.
export const SCARCITY_QUICK_SALE_MULTIPLIER = 0.75;

// Tier 7 setdoc baseline — thinnest anchor, widest spread.
// See compiqEstimate.service.ts:4723-4724.
export const T7_QUICK_SALE_MULTIPLIER = 0.6;
export const T7_PREMIUM_MULTIPLIER = 1.3;

// ── Comp-count thresholds ────────────────────────────────────────────
export const MIN_COMPS_FOR_LIVE_PATH = 3;
export const MIN_COMPS_FOR_REGIME_CLASSIFICATION = 5;
export const MIN_COMPS_FOR_PREDICTED_RANGE = 8;

// ── Day-window constants ─────────────────────────────────────────────
// Scattered 14, 30, 60, 90, 365 literals get names by semantic role.
// Semantically-different windows carrying the same day count are OK
// (they each need their own const anchored to their meaning).

export const DAY_WINDOW_RECENT = 14; // trend / regime / recentness
export const DAY_WINDOW_TRAJECTORY = 30; // predicted-price forward projection
export const DAY_WINDOW_FRESH = 60; // freshness gate
export const DAY_WINDOW_SEASONALITY = 90; // seasonality span
export const DAY_WINDOW_HISTORY = 365; // extended-window direct anchor

// ── Utility helpers built on the above ───────────────────────────────

/**
 * Apply a headline multiplier to an FMV, returning a rounded USD value
 * or null when the input is null / non-finite / ≤ 0.
 */
export function applyHeadlineMultiplier(
  fmv: number | null | undefined,
  multiplier: number,
): number | null {
  if (typeof fmv !== "number" || !Number.isFinite(fmv) || fmv <= 0) return null;
  return Math.round(fmv * multiplier * 100) / 100;
}
