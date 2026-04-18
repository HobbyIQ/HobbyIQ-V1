export function weightedFMV(comps: any[]): { weightedFMV: number, priceRangeLow: number, priceRangeHigh: number } {
  if (!comps.length) return { weightedFMV: 0, priceRangeLow: 0, priceRangeHigh: 0 };
  const weights = comps.map(c => c.finalWeight || 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const weightedFMV = comps.reduce((sum, c, i) => sum + (c.price * weights[i]), 0) / totalWeight;
  const sorted = comps.map(c => c.price).sort((a, b) => a - b);
  const priceRangeLow = sorted[Math.floor(sorted.length * 0.25)] || sorted[0];
  const priceRangeHigh = sorted[Math.floor(sorted.length * 0.75)] || sorted[sorted.length - 1];
  return { weightedFMV: Math.round(weightedFMV), priceRangeLow, priceRangeHigh };
}
