export function weightedPricing(comps: any[]) {
  // Mock: weight recent comps more
  if (!comps.length) return { estimatedValue: 0, priceRangeLow: 0, priceRangeHigh: 0 };
  const sorted = comps.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const weights = sorted.map((c, i) => 1 / (i + 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const estimatedValue = sorted.reduce((sum, c, i) => sum + c.price * weights[i], 0) / totalWeight;
  const prices = sorted.map(c => c.price);
  return {
    estimatedValue: Math.round(estimatedValue),
    priceRangeLow: Math.min(...prices),
    priceRangeHigh: Math.max(...prices),
  };
}
