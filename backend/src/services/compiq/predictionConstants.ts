// CF-PREDICTION-CREDIBILITY-DESIGN — neutral constants module.
//
// Houses methodology-pinned constants + pure derivation helpers shared by
// BOTH the write path (predictionCorpus.service.ts) and the future read
// path (CF-PREDICTION-ACCURACY-DASHBOARD). Neutral module so the read
// path doesn't import from the write path for a methodology constant.
//
// Source of truth: docs/phase0/prediction_credibility_methodology_2026-05-30.md §4.3.

/**
 * Direction band — single source of truth per methodology §4.3.
 *
 * `DIRECTION_BAND_PCT = 5` is the initial defensible starting value, NOT a
 * finding. The §4.3 re-tune commitment requires this to be re-tuned against
 * the actual measured N-day move distribution once the corpus has volume.
 * Recalibration is one line here — every consumer (corpus row derivation
 * in predictionCorpus.service.ts, accuracy metric in future
 * CF-PREDICTION-ACCURACY-DASHBOARD, baseline in §4.4) picks up the new
 * value.
 *
 * Strict comparisons (`>` and `<`); equal-or-between → "stable".
 */
export const DIRECTION_BAND_PCT = 5;

/**
 * Derive direction per methodology §4.3 with DIRECTION_BAND_PCT band.
 *
 * Strict `>` and `<` comparisons; ties at threshold fall into "stable".
 * Null-safe — returns "stable" for any input that can't be meaningfully
 * compared (null, NaN, non-positive FMV).
 *
 * Used by:
 *   - predictionCorpus.service.ts at write time to populate the row's
 *     `predictionDirection` field
 *   - (future) CF-PREDICTION-ACCURACY-DASHBOARD to derive `actual_direction`
 *     from outcome_price vs prediction's fairMarketValue at evaluation time
 *
 * Both consumers MUST use this helper — never inline the comparison.
 * Otherwise an inline re-implementation could drift from the canonical
 * tie-resolution semantics.
 */
export function derivePredictionDirection(
  predictedOrOutcomePrice: number | null,
  fairMarketValue: number | null,
): "rising" | "falling" | "stable" {
  if (
    predictedOrOutcomePrice == null ||
    fairMarketValue == null ||
    !Number.isFinite(predictedOrOutcomePrice) ||
    !Number.isFinite(fairMarketValue) ||
    fairMarketValue <= 0
  ) {
    return "stable";
  }
  const upper = fairMarketValue * (1 + DIRECTION_BAND_PCT / 100);
  const lower = fairMarketValue * (1 - DIRECTION_BAND_PCT / 100);
  if (predictedOrOutcomePrice > upper) return "rising";
  if (predictedOrOutcomePrice < lower) return "falling";
  return "stable";
}
