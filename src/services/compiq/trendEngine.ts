export function detectTrends(comps: any[]) {
  // Mock: compare last 2 vs previous 2
  if (comps.length < 4) return { trendDirection: 'neutral', trendStrength: 'low' };
  const last2 = comps.slice(-2).map(c => c.price);
  const prev2 = comps.slice(-4, -2).map(c => c.price);
  const lastAvg = last2.reduce((a, b) => a + b, 0) / last2.length;
  const prevAvg = prev2.reduce((a, b) => a + b, 0) / prev2.length;
  if (lastAvg > prevAvg) return { trendDirection: 'up', trendStrength: 'moderate' };
  if (lastAvg < prevAvg) return { trendDirection: 'down', trendStrength: 'moderate' };
  return { trendDirection: 'neutral', trendStrength: 'low' };
}
