// trendService.js - Market trend logic
function calculateTrend(comps) {
  if (!comps.length) return { trendDirection: 'flat', trendStrength: 0 };
  const sorted = comps.slice().sort((a, b) => new Date(a.soldDate) - new Date(b.soldDate));
  const n = Math.min(6, sorted.length);
  const recent = sorted.slice(-n);
  const early = sorted.slice(0, n);
  const avgRecent = recent.reduce((sum, c) => sum + c.salePrice, 0) / recent.length;
  const avgEarly = early.reduce((sum, c) => sum + c.salePrice, 0) / early.length;
  const pctChange = (avgRecent - avgEarly) / avgEarly;
  let trendDirection = 'flat';
  if (pctChange > 0.08) trendDirection = 'up';
  else if (pctChange < -0.08) trendDirection = 'down';
  return { trendDirection, trendStrength: Math.abs(pctChange) };
}
module.exports = { calculateTrend };
