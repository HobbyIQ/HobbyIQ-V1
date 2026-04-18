// marketIntelligenceService.js - Market intelligence logic
function buildMarketSummary({compsUsed, normalizedCard, allComps}) {
  // Trend
  let trendDirection = 'flat', trendStrength = 0;
  if (compsUsed && compsUsed.length > 1) {
    const sorted = compsUsed.slice().sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));
    const n = Math.min(6, sorted.length);
    const recent = sorted.slice(-n);
    const early = sorted.slice(0, n);
    const avgRecent = recent.reduce((sum, c) => sum + c.salePrice, 0) / recent.length;
    const avgEarly = early.reduce((sum, c) => sum + c.salePrice, 0) / early.length;
    const pctChange = (avgRecent - avgEarly) / avgEarly;
    if (pctChange > 0.08) trendDirection = 'up';
    else if (pctChange < -0.08) trendDirection = 'down';
    trendStrength = Math.abs(pctChange);
  }
  // Liquidity
  let estimatedLiquidity = 'medium';
  if (compsUsed.length >= 5) estimatedLiquidity = 'high';
  else if (compsUsed.length <= 1) estimatedLiquidity = 'low';
  // Supply summary (mock)
  const supplySummary = {
    availableCount: null,
    direction2Week: null,
    direction4Week: null,
    direction3Month: null
  };
  // Market ladder (mock)
  const marketLadder = [];
  // Parallel value intelligence (mock)
  // ...
  return { trendDirection, trendStrength, estimatedLiquidity, supplySummary, marketLadder };
}

function buildPlayerInsight({normalizedCard, compsUsed, trendDirection, confidence}) {
  // Simple buy/hold/sell logic
  let buyZone = '', holdZone = '', sellZone = '';
  let recommendedTiers = [];
  let reasons = [];
  if (confidence.label === 'High' && trendDirection === 'up') {
    buyZone = normalizedCard.parallelBucket;
    recommendedTiers.push(normalizedCard.parallelBucket);
    reasons.push('Strong trend and high confidence');
  } else if (trendDirection === 'down') {
    sellZone = normalizedCard.parallelBucket;
    reasons.push('Market is falling');
  } else {
    holdZone = normalizedCard.parallelBucket;
    reasons.push('Market is stable or evidence is weak');
  }
  return { buyZone, holdZone, sellZone, recommendedTiers, reasons };
}

module.exports = { buildMarketSummary, buildPlayerInsight };
