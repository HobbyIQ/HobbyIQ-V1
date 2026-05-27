// CF-NEXT-SALE-PREDICTION-LAYER (design d531939, Option B locked).
//
// Bounded TrendIQ-derived projection factor that multiplies fairMarketValue
// to produce predictedPrice. Scaling factor 0.6 dampens TrendIQ's
// [0.70, 1.50] range to ~[0.82, 1.30], capped at [0.80, 1.30] by the outer
// clamp. Worst-case divergence from FMV is ±18% (`(1.50-1.0) × 0.6 = 0.30`,
// then clamped). Coverage "insufficient" → factor 1.0 → predictedPrice
// equals fairMarketValue (graceful degradation; never claims prediction
// beyond signal support).

import type { TrendIQResult } from "./trendIQ.types.js";

export const TRENDIQ_SCALING = 0.6;
export const FORWARD_PROJECTION_MIN = 0.80;
export const FORWARD_PROJECTION_MAX = 1.30;

function clamp(lo: number, hi: number, value: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function computeForwardProjectionFactor(trendIQ: TrendIQResult): number {
  if (trendIQ.coverage === "insufficient") return 1.0;
  const scaled = 1 + (trendIQ.composite - 1) * TRENDIQ_SCALING;
  return clamp(FORWARD_PROJECTION_MIN, FORWARD_PROJECTION_MAX, scaled);
}

export interface PredictedPriceAttribution {
  mechanism: "trendiq-projection" | "unavailable";
  forwardProjectionFactor?: number;
  trendIQComposite?: number;
  trendIQDirection?: TrendIQResult["direction"];
  trendIQCoverage?: TrendIQResult["coverage"];
}

export interface PredictedPriceResult {
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceAttribution: PredictedPriceAttribution;
  forwardProjectionFactor: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computePredictedPrice(
  fairMarketValue: number | null | undefined,
  trendIQ: TrendIQResult,
): PredictedPriceResult {
  const factor = computeForwardProjectionFactor(trendIQ);

  if (typeof fairMarketValue !== "number" || !Number.isFinite(fairMarketValue)) {
    return {
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: { mechanism: "unavailable" },
      forwardProjectionFactor: factor,
    };
  }

  const predictedPrice = round2(fairMarketValue * factor);
  return {
    predictedPrice,
    predictedPriceRange: {
      low: round2(predictedPrice * 0.92),
      high: round2(predictedPrice * 1.08),
    },
    predictedPriceAttribution: {
      mechanism: "trendiq-projection",
      forwardProjectionFactor: factor,
      trendIQComposite: trendIQ.composite,
      trendIQDirection: trendIQ.direction,
      trendIQCoverage: trendIQ.coverage,
    },
    forwardProjectionFactor: factor,
  };
}
