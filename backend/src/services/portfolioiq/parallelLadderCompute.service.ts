// CF-PARALLEL-LADDER (Drew, 2026-07-17). Pure math for the parallel
// premium ladder — the observed multiplier curve for a specific
// (player, year, cardSet) bucket. Base = 1.0×, Refractor = 2.8×,
// Gold /50 = 5.2×, etc — read straight off actual sales.
//
// Card-detail moat surface: no competitor exposes this ladder
// directly. Sits on top of the same ch_daily_sales pool that
// localCompPremiums.service.ts uses, but bucketed to a specific
// SKU family instead of a whole card_id.
//
// Rules ([[no-medians-project-next-sale]] scope-note):
//   The bucket-level `medianPrice` here is a DESCRIPTIVE stat of past
//   sales for that variant, NOT an FMV. FMV routing continues to flow
//   through localCompTrend's projected-next-sale line. This service
//   never emits an FMV — it emits a variant-relative multiplier.
//
// Pure — no IO. Test-covered.

import { median } from "./observedMultipliersCompute.service.js";
import type { LocalCompSale } from "../../types/localComp.types.js";

/** Minimum sales required in a non-Base bucket for it to appear on the ladder.
 *  Matches MIN_BUCKET_N in localCompPremiums.service.ts. */
export const MIN_BUCKET_N = 3;

/** Minimum sales required in the Base bucket for the ladder to publish at
 *  all — without a reliable Base anchor every multiplier would be noise. */
export const MIN_BASE_N = 5;

/** Canonical name for the anchor variant. Case-sensitive to match
 *  ch_daily_sales's `variant` field. */
export const BASE_VARIANT = "Base";

export interface ParallelLadderRung {
  variant: string;
  /** Median sale price for this variant (descriptive, not FMV). */
  medianPrice: number;
  /** Ratio of this variant's medianPrice to Base's medianPrice. Base = 1.0. */
  multiplier: number;
  /** Number of sales in this variant's bucket (post-price-filter). */
  n: number;
  /** Print run parsed from variant string ("Gold /50" → 50). Null when unnumbered. */
  printRun: number | null;
}

export interface ParallelLadder {
  /** Median Base sale price — anchor for the ladder. */
  baseMedianPrice: number;
  /** Rungs ASC by multiplier. Base always first at 1.0. */
  ladder: ParallelLadderRung[];
  /** Publishing confidence. Gates iOS badge coloring. */
  confidence: "high" | "medium" | "low";
}

export interface ComputeParallelLadderResult {
  /** The ladder — null when insufficient Base anchor. */
  ladder: ParallelLadder | null;
  /** Diagnostic — reason the ladder was suppressed. Null on success. */
  suppressedReason: "no_sales" | "base_thin" | null;
}

/**
 * Compute the observed parallel ladder for a set of sales.
 *
 * Assumes callers have already narrowed to a single (player, year,
 * cardSet) bucket — no player/set filtering happens in here. Buckets
 * by `variant`, computes per-variant median price, and expresses each
 * as a multiplier vs the Base median.
 *
 * Suppresses the whole ladder when Base has fewer than MIN_BASE_N
 * valid sales — reporting "PSA 10 = 87× Base" with 2 Base sales would
 * be worse than nothing.
 */
export function computeParallelLadder(
  sales: ReadonlyArray<LocalCompSale>,
): ComputeParallelLadderResult {
  if (sales.length === 0) {
    return { ladder: null, suppressedReason: "no_sales" };
  }

  // Bucket prices by variant. Filter non-positive prices — matches
  // localCompPremiums.service filtering.
  const pricesByVariant = new Map<string, number[]>();
  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    const variant = s.variant || "Base";
    if (!pricesByVariant.has(variant)) pricesByVariant.set(variant, []);
    pricesByVariant.get(variant)!.push(s.price);
  }

  const basePrices = pricesByVariant.get(BASE_VARIANT) ?? [];
  if (basePrices.length < MIN_BASE_N) {
    return { ladder: null, suppressedReason: "base_thin" };
  }

  const baseMedian = median(basePrices);
  if (!(baseMedian > 0)) {
    return { ladder: null, suppressedReason: "base_thin" };
  }

  const rungs: ParallelLadderRung[] = [];
  for (const [variant, prices] of pricesByVariant.entries()) {
    if (variant === BASE_VARIANT) continue;
    if (prices.length < MIN_BUCKET_N) continue;
    const med = median(prices);
    if (!(med > 0)) continue;
    rungs.push({
      variant,
      medianPrice: round(med, 2),
      multiplier: round(med / baseMedian, 3),
      n: prices.length,
      printRun: parsePrintRunFromVariant(variant),
    });
  }

  // Sort by multiplier ASC — cheapest → priciest reads like a real ladder.
  rungs.sort((a, b) => a.multiplier - b.multiplier);

  // Base always first at 1.0.
  const ladder: ParallelLadderRung[] = [
    {
      variant: BASE_VARIANT,
      medianPrice: round(baseMedian, 2),
      multiplier: 1,
      n: basePrices.length,
      printRun: null,
    },
    ...rungs,
  ];

  const confidence = classifyConfidence(basePrices.length, rungs.length);

  return {
    ladder: {
      baseMedianPrice: round(baseMedian, 2),
      ladder,
      confidence,
    },
    suppressedReason: null,
  };
}

/**
 * Confidence tiers:
 *   high   — Base n ≥ 30 AND ≥ 5 non-Base variants
 *   medium — Base n ≥ 15 AND ≥ 3 non-Base variants
 *   low    — anything else that meets the publish gate
 *
 * The publish gate itself (Base ≥ 5, per-variant ≥ 3) is enforced
 * upstream; this function is only reached once we've cleared it, so
 * "low" is the floor, not a suppression signal.
 */
export function classifyConfidence(
  baseN: number,
  nonBaseVariantCount: number,
): "high" | "medium" | "low" {
  if (baseN >= 30 && nonBaseVariantCount >= 5) return "high";
  if (baseN >= 15 && nonBaseVariantCount >= 3) return "medium";
  return "low";
}

/**
 * Parse a print run from a variant string.
 *
 * Matches:
 *   "Gold /50"              → 50
 *   "Speckle Refractor /299" → 299
 *   "Blue /150 Refractor"   → 150
 *   "Superfractor 1/1"      → 1
 *   "Refractor"             → null
 *   "Base"                  → null
 *
 * Uses `/N` and `#/N` anchors (N is 1-5 digits). Word-boundary end
 * so "/1500" isn't parsed as "/150 with trailing 0". "1/1" (raw one-
 * of-one label) matches via a separate small-N regex — real print
 * runs are always ≤ 99999.
 *
 * Deliberately conservative — surfacing a wrong printRun on the
 * card-detail page is worse UX than surfacing null.
 */
export function parsePrintRunFromVariant(variant: string): number | null {
  if (!variant) return null;
  const slashMatch = variant.match(/(?:\/|#\/)\s*(\d{1,5})\b/);
  if (slashMatch) {
    const n = parseInt(slashMatch[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 99_999) return n;
  }
  const oneOfOne = variant.match(/\b(\d{1,3})\/\1\b/);
  if (oneOfOne) {
    const n = parseInt(oneOfOne[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 999) return n;
  }
  return null;
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}
