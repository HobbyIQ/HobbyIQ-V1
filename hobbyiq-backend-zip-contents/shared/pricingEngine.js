// pricingEngine.js - Main pricing engine for HobbyIQ
const { buildMarketSummary, buildPlayerInsight } = require('../services/marketIntelligenceService');
const { getCachedResult, setCachedResult } = require('../repositories/cacheRepository');

function priceCard(query, compData, opts = {}) {
  // Caching (optional)
  const cacheKey = JSON.stringify(query);
  if (opts.useCache) {
    const cached = getCachedResult(cacheKey);
    if (cached) return { ...cached, meta: { ...cached.meta, usedMockData: !!opts.mock, timestamp: new Date().toISOString() } };
  }
  // 1. Normalize card
  const normalizedCard = normalizeCardTitle(query.title || query.listingTitle || '');
  if (!normalizedCard) {
    return {
      query,
      normalizedCard: null,
      pricing: null,
      market: null,
      confidence: { score: 0, label: 'Low', reasons: ['Normalization failed'] },
      evidence: null,
      insight: null,
      explanation: { summary: 'Could not normalize card title', bullets: [] },
      meta: { supportedInPhase1: true, usedMockData: !!opts.mock, timestamp: new Date().toISOString() }
    };
  }
  // 2. Filter comps for this card
  let directComps = compData.filter(c => c.normalizedCardKey === normalizedCard.normalizedKey);
  let adjacentComps = [];
  if (directComps.length < 2 && normalizedCard.parallelBucket) {
    // Use adjacent tiers
    const parallelObj = getParallelByName(normalizedCard.parallelBucket);
    if (parallelObj && parallelObj.adjacency) {
      parallelObj.adjacency.forEach(adj => {
        adjacentComps = adjacentComps.concat(compData.filter(c => c.parallelBucket === adj && c.playerName === normalizedCard.playerName));
      });
    }
  }
  // 3. Outlier filtering
  directComps = filterOutliers(directComps);
  adjacentComps = filterOutliers(adjacentComps);
  // 4. Score comps
  directComps.forEach(c => c.compScore = scoreComp(c, normalizedCard));
  adjacentComps.forEach(c => c.compScore = scoreComp(c, normalizedCard));
  // 5. Trend
  const trend = calculateTrend([...directComps, ...adjacentComps]);
  // 6. Multiplier logic
  let basePrice = null;
  let multiplier = 1;
  let multiplierSource = 'direct';
  let valuationMethod = 'direct';
  let compsUsed = [];
  if (directComps.length >= 2) {
    // Use median of direct comps
    const sorted = directComps.map(c => c.salePrice).sort((a, b) => a - b);
    basePrice = sorted[Math.floor(sorted.length / 2)];
    compsUsed = directComps;
  } else if (adjacentComps.length >= 2) {
    // Use adjacent comps and multiplier
    const sorted = adjacentComps.map(c => c.salePrice).sort((a, b) => a - b);
    basePrice = sorted[Math.floor(sorted.length / 2)];
    const est = estimateMultiplier(adjacentComps[0].parallelBucket, normalizedCard.parallelBucket, compData);
    multiplier = est.estimatedMultiplier;
    multiplierSource = est.multiplierSource;
    valuationMethod = 'adjacent';
    compsUsed = adjacentComps;
  } else {
    // Fallback
    basePrice = 0;
    multiplier = 1;
    multiplierSource = 'default';
    valuationMethod = 'fallback';
    compsUsed = [];
  }
  const fairMarketValue = Math.round(basePrice * multiplier * 100) / 100;
  // 7. Pricing lanes
  const buyTarget = Math.round(fairMarketValue * 0.92 * 100) / 100;
  const premiumAsk = Math.round(fairMarketValue * 1.08 * 100) / 100;
  const compRangeLow = compsUsed.length ? Math.min(...compsUsed.map(c => c.salePrice)) : 0;
  const compRangeHigh = compsUsed.length ? Math.max(...compsUsed.map(c => c.salePrice)) : 0;
  // 8. Confidence
  const confidence = calculateConfidence({
    directCompCount: directComps.length,
    adjacentCompCount: adjacentComps.length,
    compScores: compsUsed.map(c => c.compScore),
    trendStrength: trend.trendStrength,
    normalizationCertainty: 1
  });
  // 9. Market intelligence
  const market = buildMarketSummary({ compsUsed, normalizedCard, allComps: compData });
  // 10. Evidence
  const evidence = {
    directCompCount: directComps.length,
    adjacentCompCount: adjacentComps.length,
    compsUsed,
    multiplierSource,
    valuationMethod
  };
  // 11. Insight
  const insight = buildPlayerInsight({ normalizedCard, compsUsed, trendDirection: market.trendDirection, confidence });
  // 12. Explanation
  const explanation = {
    summary: `Based on ${compsUsed.length} ${valuationMethod} sales.`,
    bullets: [
      directComps.length ? 'Used direct sales.' : 'Used adjacent or fallback logic.',
      `Market trend: ${market.trendDirection}.`,
      `Confidence: ${confidence.label}.`
    ]
  };
  // 13. Meta
  const meta = {
    supportedInPhase1: true,
    usedMockData: !!opts.mock,
    timestamp: new Date().toISOString()
  };
  const result = {
    query,
    normalizedCard,
    pricing: { buyTarget, fairMarketValue, premiumAsk, compRangeLow, compRangeHigh },
    market,
    confidence,
    evidence,
    insight,
    explanation,
    meta
  };
  if (opts.useCache) setCachedResult(cacheKey, result);
  return result;
}

module.exports = { priceCard };
