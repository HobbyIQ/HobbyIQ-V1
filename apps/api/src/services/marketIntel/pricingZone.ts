// PricingZoneService: Computes price bands for cards
import type { MarketPriceBands, CompCalculationContext } from "../../types/marketIntel";

export function computePriceBands(context: CompCalculationContext): MarketPriceBands {
  // Example heuristics, tune as needed
  const { weightedMedian, liquidityScore } = context;
  const fmv = weightedMedian;
  const quickExitPrice = fmv * (liquidityScore > 0.7 ? 0.93 : 0.88);
  const buyZoneLow = fmv * 0.85;
  const buyZoneHigh = fmv * 0.97;
  const holdZoneLow = fmv * 0.97;
  const holdZoneHigh = fmv * 1.07;
  const sellZoneLow = fmv * 1.07;
  const sellZoneHigh = fmv * 1.18;
  const stretchAsk = fmv * 1.25;
  return {
    quickExitPrice,
    fairMarketValue: fmv,
    buyZoneLow,
    buyZoneHigh,
    holdZoneLow,
    holdZoneHigh,
    sellZoneLow,
    sellZoneHigh,
    stretchAsk
  };
}
