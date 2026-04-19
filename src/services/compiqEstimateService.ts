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
  return {
    quickSale: stats.weighted25th,
    fairMarketValue: stats.weightedMedian,
    premiumAsk: stats.weighted75th,
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
