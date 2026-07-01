/**
 * CF-PLAYER-MOMENTUM-SUPPLY-TREND (2026-07-01):
 * Classify supply/demand behavior from the momentum + volume ratios.
 *
 * Rationale: `sales-stats-by-player` shows completed sales, not raw
 * listings. But by cross-referencing the volume ratio with the price
 * ratio we can INFER supply behavior — and supply changes are a
 * leading indicator, while price changes are lagging.
 *
 * The 4-quadrant matrix:
 *   volume ↑ + price ↑ → demand_growth  (buyers absorbing supply)
 *   volume ↓ + price ↑ → SUPPLY_DRY     (listings scarce, buyers competing — BULLISH LEADING INDICATOR)
 *   volume ↑ + price ↓ → SUPPLY_FLOOD   (hobby dumping, sellers competing — BEARISH LEADING INDICATOR)
 *   volume ↓ + price ↓ → demand_crash   (no buyers even for cheap)
 *   neither ratio meaningful → flat
 *
 * The two leading-indicator quadrants (supply_dry, supply_flood) matter
 * disproportionately for pricing projection — they precede the price
 * signal by definition. Momentum captures where we are; supply-trend
 * classification captures where we're headed.
 */

import type {
  PlayerMomentumSignal,
  SupplyTrendClassification,
} from "./playerTrend.types.js";

export type { SupplyTrendClassification } from "./playerTrend.types.js";

/**
 * Minimum absolute deviation from 1.0 to consider a ratio "meaningful".
 * Matches the momentum-projection MIN_TREND_DELTA (0.05) for consistency.
 */
const MIN_MEANINGFUL_DEVIATION = 0.05;

/**
 * Threshold multipliers applied to the leading-indicator quadrants only.
 * These nudge the projected price on top of the momentum multiplier.
 * Conservative by design: +/- 5% is a small enough kick that a false
 * classification is not catastrophic.
 */
export const SUPPLY_DRY_BOOST = 1.05;
export const SUPPLY_FLOOD_DISCOUNT = 0.95;

/**
 * Ratio-based classification. Downstream callers choose which price ratio
 * to pass in — the mix-bias-free matched-cohort medianRatio when
 * available (STRONGLY preferred), else the raw sales-stats-by-player
 * weekly average. See classifySupplyTrend(momentum) below for the
 * backward-compat wrapper.
 *
 * CF-SUPPLY-TREND-PREFER-MATCHED-COHORT (2026-07-01): the raw
 * momentumRatio input was found to misclassify same-store scenarios
 * as supply_flood when high-value cards rotated in/out of the weekly
 * mix. Eric Hartman 2026-07-01 real data: raw ratio 0.922 + volume
 * 1.421 classified as supply_flood (bearish), but matched-cohort
 * ratio 1.363 correctly classifies as demand_growth. The provider
 * now feeds matched-cohort when the cache is warm.
 */
export function classifySupplyTrendFromRatios(
  priceRatio: number | null,
  volumeRatio: number | null,
): SupplyTrendClassification {
  if (priceRatio === null || volumeRatio === null) return "flat";

  const priceDelta = priceRatio - 1;
  const volumeDelta = volumeRatio - 1;

  // Both ratios must clear the noise threshold to classify anything but flat.
  if (Math.abs(priceDelta) < MIN_MEANINGFUL_DEVIATION) return "flat";
  if (Math.abs(volumeDelta) < MIN_MEANINGFUL_DEVIATION) {
    // Price meaningful but volume flat — treat as flat too. We need BOTH
    // signals to classify supply behavior; price-only movement gets picked
    // up by the momentum path.
    return "flat";
  }

  const priceUp = priceDelta > 0;
  const volumeUp = volumeDelta > 0;

  if (volumeUp && priceUp) return "demand_growth";
  if (!volumeUp && priceUp) return "supply_dry";
  if (volumeUp && !priceUp) return "supply_flood";
  return "demand_crash";
}

/**
 * Backward-compat: thin wrapper that uses the momentum's raw ratios.
 * Prefer classifySupplyTrendFromRatios directly in new code so callers
 * can plug in matched-cohort medianRatio when it's available.
 */
export function classifySupplyTrend(
  momentum: PlayerMomentumSignal,
): SupplyTrendClassification {
  return classifySupplyTrendFromRatios(momentum.momentumRatio, momentum.volumeRatio);
}

/**
 * How much the projection should be nudged based on the classification.
 * Returns 1.0 (no nudge) for non-leading-indicator quadrants — those
 * are already captured by the momentum ratio itself.
 */
export function supplyTrendProjectionAdjuster(
  classification: SupplyTrendClassification,
): number {
  switch (classification) {
    case "supply_dry":
      return SUPPLY_DRY_BOOST;
    case "supply_flood":
      return SUPPLY_FLOOD_DISCOUNT;
    case "demand_growth":
    case "demand_crash":
    case "flat":
      return 1.0;
  }
}
