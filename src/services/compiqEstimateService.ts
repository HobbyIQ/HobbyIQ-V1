import { EstimateInput, EstimateOutput } from '../models/compiq';
import { filterCompsStrict, rejectBadComps } from './compEngine';
import { scoreRecency } from './recencyEngine';
import { trimOutliers } from './outlierEngine';
import { weightedStats } from './weightedStats';
import { detectTrend } from './trendEngine';
import { assessLiquidity } from './liquidityEngine';
import { getParallelRegistry } from './parallelRegistry';
import { computeMultiplier, pairCompsByClosestDate, getDateGapDays, getDateClosenessScore, multiplierConfidence } from './multiplierEngine';
import { expandPremium } from './premiumExpansionEngine';
import { computeConfidence } from './confidenceEngine';
import { buildExplanation } from './explanationEngine';

export async function runCompiqEstimate(input: EstimateInput): Promise<EstimateOutput> {
  // 1. Filter comps strictly
  let comps = filterCompsStrict(input.comps, input);
  comps = rejectBadComps(comps);

  // 2. Score recency
  comps = scoreRecency(comps);

  // 3. Outlier removal
  comps = trimOutliers(comps);

  // 4. Weighted stats
  const stats = weightedStats(comps);

  // 5. Trend
  const trend = detectTrend(comps);

  // 5b. Monotonic ascending check — if every successive sale is higher than the last
  // (min 3 sales), the card is in a clear uptrend: skip all averaging, use most recent price.
  const chronoComps = comps.slice().sort((a: any, b: any) =>
    new Date(a.saleDate).getTime() - new Date(b.saleDate).getTime()
  );
  const recentN = chronoComps.slice(-Math.min(chronoComps.length, 5));
  const isMonotonicallyIncreasing = recentN.length >= 3 &&
    recentN.every((c: any, i: number) => i === 0 || c.price > recentN[i - 1].price);

  // 6. Liquidity
  const liquidity = assessLiquidity(comps, input.activeListings);

  // 7. Parallel registry (prior only)
  const parallelRegistry = getParallelRegistry();

  // 8. Multiplier engine
  const multiplierResult = computeMultiplier(comps, input, parallelRegistry);

  // 9. Premium expansion
  const premiumExpansion = expandPremium(input, trend, liquidity);

  // 10. Confidence
  const confidenceScore = computeConfidence(comps, multiplierResult, liquidity);

  // 11. Explanation
  const explanation = buildExplanation({
    comps,
    stats,
    trend,
    liquidity,
    multiplierResult,
    premiumExpansion,
    confidenceScore,
    input
  });

  // 12. Pricing mode selection
  let pricingMode: EstimateOutput['pricingMode'] = 'low_data';
  if (comps.length >= 5 && stats.recencyScore >= 0.7) pricingMode = 'direct_comp';
  else if (comps.length >= 2) pricingMode = 'hybrid';
  else if (multiplierResult.parallelInferenceActive) pricingMode = 'parallel_inference';

  // 13. Output
  // If sales are strictly ascending (each higher than previous), skip averaging —
  // the most recent sale IS the market price for this card right now.
  const mostRecentPrice = chronoComps.length > 0
    ? Math.round(chronoComps[chronoComps.length - 1].price)
    : stats.weightedMedian;
  const fmv = isMonotonicallyIncreasing ? mostRecentPrice : stats.weightedMedian;

  return {
    quickSale: stats.weighted25th,
    fairMarketValue: fmv,
    premiumAsk: isMonotonicallyIncreasing
      ? Math.round((mostRecentPrice ?? 0) * 1.1)  // 10% above recent for monotonic uptrend
      : stats.weighted75th,
    pricingMode,
    confidenceScore,
    liquidity,
    trend,
    compCountUsed: comps.length,
    parallelInferenceActive: multiplierResult.parallelInferenceActive,
    premiumExpansionApplied: premiumExpansion.applied,
    debug: {
      weightedMedian: stats.weightedMedian,
      weighted25th: stats.weighted25th,
      weighted75th: stats.weighted75th,
      baseParallelRatio: multiplierResult.baseParallelRatio,
      adjustedParallelRatio: multiplierResult.adjustedParallelRatio,
      averageDateGapDays: multiplierResult.averageDateGapDays,
      bestDateGapDays: multiplierResult.bestDateGapDays,
      marketPressureScore: premiumExpansion.marketPressureScore,
    },
    explanation
  };
}
