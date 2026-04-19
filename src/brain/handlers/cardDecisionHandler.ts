
import { getComps } from '../../services/compiq/getComps';
import { normalizeComps } from '../../services/compiq/normalizeCompData';
import { selectComps } from '../../services/compiq/compSelectionEngine';
import { recencyWeight } from '../../services/compiq/recencyWeightEngine';
import { compQualityScore } from '../../services/compiq/compQualityScorer';
import { filterOutliers } from '../../services/compiq/outlierEngine';
import { weightedFMV } from '../../services/compiq/weightedFMVEngine';
import { getFreshnessScore } from '../../services/compiq/freshnessEngine';
import { getAccelerationScore } from '../../engines/accelerationEngine';
import { getListingFloorAnalysis } from '../../engines/listingFloorEngine';
import { getAbsorptionAnalysis } from '../../engines/absorptionEngine';
import { getClusterAnalysis } from '../../engines/clusterEngine';
import { getFMVBands } from '../../services/compiq/fmvBandsEngine';
import { trendAnalysis } from '../../services/compiq/trendAnalysisEngine';
import { volatilityEngine } from '../../services/compiq/volatilityEngine';
import { velocityEngine } from '../../services/compiq/velocityEngine';
import { parallelInterpolation } from '../../services/compiq/parallelInterpolationEngine';
import { confidenceEngine } from '../../services/compiq/confidenceEngine';
import { resolveParallel } from '../../services/compiq/parallelResolver';
import { getSupplyTrends } from '../../services/supply/supplyTrendEngine';
import { getLiquidityScore, getAbsorptionRate } from '../../services/supply/liquidityEngine';
import { getPlayerSignal } from '../../services/playeriq/playerSignalEngine';
import { getNewsSignal } from '../../services/news/eventImpactEngine';
import { makeDecision } from '../../services/decision/decisionEngine';
import { getPerformanceImpact } from '../../services/marketImpact/performanceImpactEngine';
import { getRankingImpact } from '../../services/marketImpact/rankingImpactEngine';
import { getAwardsImpact } from '../../services/marketImpact/awardsImpactEngine';
import { getHobbyBuzzImpact } from '../../services/marketImpact/hobbyBuzzEngine';
import { aggregateMarketImpact } from '../../services/marketImpact/marketImpactAggregator';
import { logPrediction } from '../../services/learning/predictionLogger';
import { formatCardDecisionViewModel } from '../formatters/cardDecisionViewModel';

export async function cardDecisionHandler(payload: any) {
  // 1. Get comps
  const comps = await getComps(payload);
  const normalizedComps = normalizeComps(comps);
  // 2. Comp selection
  const { selected, liquidityTier, usedInterpolation } = selectComps(normalizedComps);
  // 3. Outlier removal
  const filteredComps = filterOutliers(selected);
  // 4. Recency & quality weights
  const now = Date.now();
  const compsWithWeights = filteredComps.map(c => {
    const daysSinceSale = Math.max(0, (now - new Date(c.date).getTime()) / (1000 * 60 * 60 * 24));
    const recency = recencyWeight(daysSinceSale);
    const quality = compQualityScore(c);
    return { ...c, recencyWeight: recency, qualityScore: quality, finalWeight: recency * quality };
  });
  // 5. Weighted FMV
  let { weightedFMV: fmv, priceRangeLow, priceRangeHigh } = weightedFMV(compsWithWeights);
  // 6. Trend analysis
  const { trendDirection, trendStrength } = trendAnalysis(compsWithWeights);
  // 7. Volatility
  const { volatilityScore, classification: volatility } = volatilityEngine(compsWithWeights);
  // 8. Velocity
  const { velocityScore, classification: velocity } = velocityEngine(compsWithWeights);
  // 9. Parallel interpolation if needed
  let interpolationUsed = usedInterpolation;
  let interpolationWeight = 0;
  let directWeight = 1;
  if (compsWithWeights.length < 5) {
    // Use parallel interpolation
    const parallelInfo = resolveParallel(payload);
    // Mock: parallelCatalog should be injected or imported
    const parallelCatalog = {};
    const interp = parallelInterpolation(compsWithWeights, parallelCatalog, payload.parallel);
    if (interp.used && interp.estimatedValue > 0) {
      fmv = interp.estimatedValue;
      interpolationUsed = true;
      interpolationWeight = 0.5;
      directWeight = 0.5;
    }
  }
  // 10. Supply adjustment
  const supply = getSupplyTrends(payload);
  let supplyAdj = 1;
  // Use supplyTrend2W as the trend indicator
  if (supply && typeof supply.supplyTrend2W === 'number') {
    if (supply.supplyTrend2W < -15) supplyAdj = 1.1;
    else if (supply.supplyTrend2W > 15) supplyAdj = 0.9;
  }

  // 11. Listing floor analysis (mocked listings)
  const listings = payload.listings || [];
  const lastSale = compsWithWeights.length ? compsWithWeights[compsWithWeights.length - 1].price : fmv;
  const listingFloorResult = getListingFloorAnalysis(listings, lastSale);

  // 12. Absorption analysis (mocked sold/new listings)
  const sold7d = payload.sold7d ?? compsWithWeights.length;
  const newListings7d = payload.newListings7d ?? listings.length;
  const absorptionResult = getAbsorptionAnalysis(listings, sold7d, newListings7d);

  // 13. Freshness
  const freshnessResult = getFreshnessScore(compsWithWeights);

  // 14. Acceleration
  const accelerationResult = getAccelerationScore(compsWithWeights);

  // 15. Cluster analysis
  const clusterResult = getClusterAnalysis(compsWithWeights.map(c => c.price));

  // 16. FMV Bands
  const fmvBands = getFMVBands({
    comps: compsWithWeights,
    blendedFMV: fmv,
    listingFloor: typeof listingFloorResult.listingFloor === 'number' && listingFloorResult.listingFloor !== null
      ? listingFloorResult.listingFloor
      : fmv // fallback to fmv if null
  });

  // 17. Blended FMV (final adjustment)
  let blendedFMV = fmv;
  let pricingMethod = 'direct';
  let dataQualityNotes = [];
  // Freshness adjustment
  let freshnessAdjustment = freshnessResult.freshnessScore > 0.8 ? 1.05 : freshnessResult.freshnessScore < 0.4 ? 0.95 : 1.0;
  // Acceleration adjustment
  let accelerationAdjustment = accelerationResult.accelerationScore > 0.2 ? 1.05 : accelerationResult.accelerationScore < -0.2 ? 0.95 : 1.0;
  // Supply adjustment
  let supplyAdjustment = absorptionResult.supplyPressure === 'tightening' ? 1.05 : absorptionResult.supplyPressure === 'expanding' ? 0.95 : 1.0;
  // Listing floor adjustment
  let listingFloorAdjustment = (listingFloorResult.marketResetSignal ? 1.1 : 1.0);
  // Clamp all adjustments
  freshnessAdjustment = Math.max(0.9, Math.min(1.2, freshnessAdjustment));
  accelerationAdjustment = Math.max(0.9, Math.min(1.2, accelerationAdjustment));
  supplyAdjustment = Math.max(0.9, Math.min(1.2, supplyAdjustment));
  listingFloorAdjustment = Math.max(0.9, Math.min(1.2, listingFloorAdjustment));
  // Compose
  blendedFMV = Math.round(fmv * freshnessAdjustment * accelerationAdjustment * supplyAdjustment * listingFloorAdjustment);
  pricingMethod = interpolationUsed ? 'interpolated' : 'direct';
  dataQualityNotes.push(...freshnessResult.notes, ...accelerationResult.notes, ...absorptionResult.notes, ...listingFloorResult.notes);

  // 18. Price bands
  const quickSellFloor = fmvBands.quickSellFloor;
  const fairMarketValue = fmvBands.fairMarketValue;
  const strongRetailValue = fmvBands.strongRetailValue;

  // 19. Confidence (upgraded)
  const compCountScore = Math.min(1, compsWithWeights.length / 12);
  const recencyScore = compsWithWeights.length ? compsWithWeights.reduce((sum, c) => sum + c.recencyWeight, 0) / compsWithWeights.length : 0;
  const varianceScore = volatilityScore ? 1 - Math.min(1, volatilityScore / (fmv || 1)) : 1;
  const absorptionScore = absorptionResult.liquidityScore ?? 0;
  const listingAlignmentScore = listingFloorResult.listingFloor && Math.abs(listingFloorResult.listingFloor - blendedFMV) < 0.1 * blendedFMV ? 1 : 0.7;
  const interpolationConfidence = interpolationUsed ? 0.7 : 1;
  const confidence = Math.round(((compCountScore * 0.2) + (freshnessResult.freshnessScore * 0.2) + (varianceScore * 0.15) + (absorptionScore * 0.15) + (listingAlignmentScore * 0.15) + (interpolationConfidence * 0.15)) * 100);

  // 20. Compose CompIQ output
  const compiqOutput = {
    finalFMV: blendedFMV,
    priceRangeLow: priceRangeLow,
    priceRangeHigh: priceRangeHigh,
    quickSellFloor,
    strongRetailValue,
    weightedMedian: clusterResult.weightedMedian,
    clusterCenter: clusterResult.clusterCenter,
    compCount: compsWithWeights.length,
    recentDirectCompCount: compsWithWeights.length,
    freshnessScore: freshnessResult.freshnessScore,
    accelerationScore: accelerationResult.accelerationScore,
    absorptionRate: absorptionResult.absorptionRate,
    supplyPressure: absorptionResult.supplyPressure,
    listingFloor: listingFloorResult.listingFloor,
    listingGap: listingFloorResult.listingGap,
    directWeight,
    interpolationWeight,
    pricingMethod,
    confidence,
    dataQualityNotes,
    marketContext: {
      freshness: freshnessResult.freshnessTier,
      acceleration: accelerationResult.accelerationDirection,
      supplyPressure: absorptionResult.supplyPressure,
      listingSignal: listingFloorResult.marketResetSignal ? 'upward reset' : (listingFloorResult.listingFloor != null ? 'normal' : 'unknown')
    }
  };

  // 21. Logging
  logPrediction({
    finalFMV: blendedFMV,
    quickSellFloor,
    strongRetailValue,
    freshnessScore: freshnessResult.freshnessScore,
    accelerationScore: accelerationResult.accelerationScore,
    absorptionRate: absorptionResult.absorptionRate,
    listingFloor: listingFloorResult.listingFloor,
    pricingMethod,
    confidence,
    timestamp: new Date().toISOString(),
  });
  // 12. Parallel info
  const parallelInfo = resolveParallel(payload);
  // 13. Player & News
  const liquidityScore = getLiquidityScore(payload);
  const absorptionRate = getAbsorptionRate(payload);
  const playerSignal = getPlayerSignal(payload);
  const newsSignal = getNewsSignal(payload);

  // 13b. Market Impact Layer (mocked inputs for now)
  const perfImpact = getPerformanceImpact(payload.stats || null);
  const rankingImpact = getRankingImpact(payload.rankingData || null);
  const awardsImpact = getAwardsImpact(payload.awardsData || null);
  const hobbyBuzzImpact = getHobbyBuzzImpact(payload.hobbyBuzzData || null);
  const marketImpact = aggregateMarketImpact([
    perfImpact,
    rankingImpact,
    awardsImpact,
    hobbyBuzzImpact
  ]);
  // 14. Decision (pass CompIQ output)
  const decision = makeDecision({
    payload,
    weighted: {
      estimatedValue: blendedFMV,
      priceRangeLow,
      priceRangeHigh,
      quickSellFloor,
      strongRetailValue,
      weightedMedian: clusterResult.weightedMedian,
      clusterCenter: clusterResult.clusterCenter
    },
    trends: { trendDirection, trendStrength },
    supply,
    liquidityScore: absorptionResult.liquidityScore,
    absorptionRate: absorptionResult.absorptionRate,
    playerSignal,
    newsSignal,
    confidence,
    parallelInfo,
    comps: compsWithWeights,
    volatility,
    velocity,
    liquidityTier,
    usedInterpolation: interpolationUsed,
    marketImpact,
    marketContext: compiqOutput.marketContext,
    dataQualityNotes: compiqOutput.dataQualityNotes
  });
  // 16. Format for frontend
  return formatCardDecisionViewModel({ ...decision, compiq: compiqOutput });
}
