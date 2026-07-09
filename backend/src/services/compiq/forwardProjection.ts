// CF-NEXT-SALE-PREDICTION-LAYER (design d531939, Option B locked).
//
// Bounded TrendIQ-derived projection factor that multiplies fairMarketValue
// to produce predictedPrice. Scaling factor 0.6 dampens TrendIQ's
// [0.70, 1.50] range to ~[0.82, 1.30], capped at [0.80, 1.30] by the outer
// clamp. Worst-case divergence from FMV is ±18% (`(1.50-1.0) × 0.6 = 0.30`,
// then clamped). Coverage "insufficient" → factor 1.0 → predictedPrice
// equals fairMarketValue (graceful degradation; never claims prediction
// beyond signal support).
//
// CF-REGIME-RECONCILE (2026-07-08, Drew):
//   The regime classifier (see regimeClassifier.ts) reads the same comp pool
//   and independently classifies market direction. Empirically these two
//   signals disagree — e.g. Ohtani 2021 Topps Chrome carries regime
//   "sharply_breaking_out" (14d mean > 15% above older mean) while trendIQ
//   composite reads 1.014 ("flat") because the median-of-window math dead-
//   zones on high sample counts. The user then sees a UP arrow next to a
//   flat number — same data, contradictory reads.
//
//   Fix: when regime is decisive AND confidence ≥ medium, apply a
//   directional floor/ceiling to the projection factor. TrendIQ still
//   controls the magnitude within the regime-bounded range; regime only
//   ensures the sign matches the classifier's read. Regimes that DON'T
//   assert direction (stable, volatile, insufficient_data) are pass-through.
//
//   Bounds are conservative — a "sharply_breaking_out" regime only floors
//   the factor at +5% (not the +15% the classifier saw), leaving headroom
//   for trendIQ to swing higher if it agrees. This limits reconciliation
//   blast radius until we have backtest data to calibrate more aggressively.

import type { Regime, RegimeConfidence } from "./regimeClassifier.js";
import type { TrendIQResult } from "./trendIQ.types.js";

export const TRENDIQ_SCALING = 0.6;
export const FORWARD_PROJECTION_MIN = 0.80;
export const FORWARD_PROJECTION_MAX = 1.30;

function clamp(lo: number, hi: number, value: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Directional floors/ceilings the regime classifier can impose on the
 * TrendIQ-derived factor. `[minFactor, maxFactor]`. A regime not listed
 * here is treated as pass-through — trendIQ's read stands unmodified.
 */
const REGIME_FACTOR_BOUNDS: Partial<Record<Regime, [number, number]>> = {
  sharply_breaking_out: [1.05, FORWARD_PROJECTION_MAX], // floor +5%
  gradually_rising:     [1.01, FORWARD_PROJECTION_MAX], // floor +1%
  declining:            [FORWARD_PROJECTION_MIN, 0.99], // ceiling -1%
  sharply_crashing:     [FORWARD_PROJECTION_MIN, 0.95], // ceiling -5%
};

export interface ForwardProjectionFactorReconciledResult {
  factor: number;
  trendIQFactor: number;
  reconciled: boolean;
  reconcileReason: string | null;
}

/**
 * TrendIQ-only projection factor. Backward-compatible number-returning
 * signature preserved for callers (gradedPriceProjection.ts) that don't
 * need regime reconciliation. New code should prefer
 * `computeForwardProjectionFactorReconciled`.
 */
export function computeForwardProjectionFactor(trendIQ: TrendIQResult): number {
  if (trendIQ.coverage === "insufficient") return 1.0;
  const scaled = 1 + (trendIQ.composite - 1) * TRENDIQ_SCALING;
  return clamp(FORWARD_PROJECTION_MIN, FORWARD_PROJECTION_MAX, scaled);
}

/**
 * CF-REGIME-RECONCILE (2026-07-08): TrendIQ factor reconciled against the
 * regime classifier's directional read. Returns the raw trendIQ factor plus
 * the reconciled one so telemetry can capture the delta. When regime is
 * missing, low-confidence, or non-directional (stable/volatile/insufficient),
 * `factor` equals `trendIQFactor` and `reconciled` is false — identical
 * behavior to the plain trendIQ-only call.
 */
export function computeForwardProjectionFactorReconciled(
  trendIQ: TrendIQResult,
  regime?: Regime | null,
  regimeConfidence?: RegimeConfidence | null,
): ForwardProjectionFactorReconciledResult {
  const trendIQFactor = computeForwardProjectionFactor(trendIQ);

  if (!regime || regimeConfidence === "low") {
    return { factor: trendIQFactor, trendIQFactor, reconciled: false, reconcileReason: null };
  }

  const bounds = REGIME_FACTOR_BOUNDS[regime];
  if (!bounds) {
    return { factor: trendIQFactor, trendIQFactor, reconciled: false, reconcileReason: null };
  }

  const [minFactor, maxFactor] = bounds;
  const reconciledFactor = clamp(minFactor, maxFactor, trendIQFactor);
  const wasReconciled = Math.abs(reconciledFactor - trendIQFactor) > 0.001;

  return {
    factor: reconciledFactor,
    trendIQFactor,
    reconciled: wasReconciled,
    reconcileReason: wasReconciled
      ? `regime_${regime}_${reconciledFactor > trendIQFactor ? "floor" : "ceiling"}`
      : null,
  };
}

export interface PredictedPriceAttribution {
  mechanism: "trendiq-projection" | "unavailable";
  forwardProjectionFactor?: number;
  trendIQComposite?: number;
  trendIQDirection?: TrendIQResult["direction"];
  trendIQCoverage?: TrendIQResult["coverage"];
  /** CF-REGIME-RECONCILE: set when regime bounded the factor away from
   *  trendIQ's raw read. Missing when reconciliation didn't fire. */
  regimeReconciled?: boolean;
  regimeReconcileReason?: string | null;
  regime?: Regime | null;
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
  regime?: Regime | null,
  regimeConfidence?: RegimeConfidence | null,
): PredictedPriceResult {
  const factorResult = computeForwardProjectionFactorReconciled(trendIQ, regime, regimeConfidence);
  const factor = factorResult.factor;

  if (typeof fairMarketValue !== "number" || !Number.isFinite(fairMarketValue)) {
    return {
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: { mechanism: "unavailable" },
      forwardProjectionFactor: factor,
    };
  }

  const predictedPrice = round2(fairMarketValue * factor);
  const attribution: PredictedPriceAttribution = {
    mechanism: "trendiq-projection",
    forwardProjectionFactor: factor,
    trendIQComposite: trendIQ.composite,
    trendIQDirection: trendIQ.direction,
    trendIQCoverage: trendIQ.coverage,
  };
  // Only include reconcile fields when a regime was actually supplied so
  // legacy callers see the pre-CF-REGIME-RECONCILE attribution shape.
  if (regime !== undefined && regime !== null) {
    attribution.regime = regime;
    attribution.regimeReconciled = factorResult.reconciled;
    attribution.regimeReconcileReason = factorResult.reconcileReason;
  }
  return {
    predictedPrice,
    predictedPriceRange: {
      low: round2(predictedPrice * 0.92),
      high: round2(predictedPrice * 1.08),
    },
    predictedPriceAttribution: attribution,
    forwardProjectionFactor: factor,
  };
}
