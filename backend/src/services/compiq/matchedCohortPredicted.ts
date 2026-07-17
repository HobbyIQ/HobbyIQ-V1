// CF-PREDICTED-MATCHED-COHORT (Drew, 2026-07-17). Pure math for the
// matched-cohort predicted-price computation used by the compiq
// estimate wire. Extracted from compiqEstimate.service.ts so it can
// be unit-tested independently.
//
// Rationale: linear regression through 2-3 sparse comps produced wild
// swings ($243 one day, $5527 the next for the same Orange Shimmer
// Hartman card). Compiq's card-panel path solved this months ago with
// matched-cohort rate. This helper mirrors that math for the estimate
// wire so portfolio-reprice — which stamps holding.predictedPrice —
// shows the same predicted number iOS sees on the priced-card page.
//
// PREDICTED_HORIZON_DAYS = 7 (matches observedGradeCurve.service.ts:584).
// predictedMultiplier = 1 + rate * (7/7) = 1 + rate.

/** ±8% band, matches observedGradeCurve.service.ts:589 PREDICTED_RANGE_PCT. */
const RANGE_PCT = 0.08;

export interface CohortPredictedResult {
  predictedPrice: number;
  predictedPriceRange: { low: number; high: number };
  direction: "up" | "down" | "static";
}

/** Apply a player-level weekly rate to a grade-scoped market value.
 *  Returns null when rate is not finite or marketValue is not positive. */
export function computeCohortPredicted(
  marketValue: number | null | undefined,
  weeklyRate: number | null | undefined,
): CohortPredictedResult | null {
  if (
    typeof marketValue !== "number"
    || !Number.isFinite(marketValue)
    || marketValue <= 0
  ) return null;
  if (typeof weeklyRate !== "number" || !Number.isFinite(weeklyRate)) return null;

  const raw = marketValue * (1 + weeklyRate);
  const predictedPrice = Math.round(raw * 100) / 100;
  const direction: "up" | "down" | "static" =
    weeklyRate > 0 ? "up" : weeklyRate < 0 ? "down" : "static";
  return {
    predictedPrice,
    predictedPriceRange: {
      low: Math.round(raw * (1 - RANGE_PCT) * 100) / 100,
      high: Math.round(raw * (1 + RANGE_PCT) * 100) / 100,
    },
    direction,
  };
}
