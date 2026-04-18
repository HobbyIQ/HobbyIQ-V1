function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function calculatePricing(input) {
  const {
    medianPrice = 0,
    activeListings = 0,
    sales30d = 0,
    gemRate = 0,
    popGrowth30d = 0,
    trendMultiplier = 1
  } = input;

  const liquidityRatio = sales30d / Math.max(activeListings, 1);

  let liquidityBoost = 1;
  if (liquidityRatio > 2) liquidityBoost = 1.15;
  else if (liquidityRatio > 1) liquidityBoost = 1.08;
  else if (liquidityRatio < 0.5) liquidityBoost = 0.90;

  let supplyPenalty = 1;
  if (activeListings > 20) supplyPenalty = 0.80;
  else if (activeListings > 10) supplyPenalty = 0.90;

  let gemBoost = 1;
  if (gemRate < 20) gemBoost = 1.20;
  else if (gemRate < 40) gemBoost = 1.10;
  else if (gemRate > 70) gemBoost = 0.90;

  let growthPenalty = 1;
  if (popGrowth30d > 15) growthPenalty = 0.85;
  else if (popGrowth30d > 8) growthPenalty = 0.92;

  const estimatedFMV =
    medianPrice *
    liquidityBoost *
    supplyPenalty *
    gemBoost *
    growthPenalty *
    trendMultiplier;

  let scarcityScore =
    100 -
    activeListings * 2 -
    gemRate * 0.5 -
    popGrowth30d * 1.5 +
    liquidityRatio * 10;

  scarcityScore = clamp(Math.round(scarcityScore), 10, 100);

  let confidence = 'Low';
  if (sales30d > 10) confidence = 'High';
  else if (sales30d > 5) confidence = 'Medium';

  return {
    estimatedFMV: Math.round(estimatedFMV),
    scarcityScore,
    confidence,
    breakdown: {
      medianPrice,
      liquidityRatio,
      liquidityBoost,
      supplyPenalty,
      gemBoost,
      growthPenalty,
      trendMultiplier,
      activeListings,
      sales30d,
      gemRate,
      popGrowth30d
    }
  };
}

module.exports = { calculatePricing };
