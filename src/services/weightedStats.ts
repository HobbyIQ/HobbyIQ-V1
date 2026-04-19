import { Comp } from '../models/compiq';

export function weightedStats(comps: Comp[]) {
  if (!comps.length) return {
    weightedMedian: null,
    weighted25th: null,
    weighted75th: null,
    recencyScore: 0
  };
  // Use recencyScore as weight
  const sorted = comps.slice().sort((a, b) => a.price - b.price);
  const weights = sorted.map(c => c.recencyScore ?? 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  function weightedQuantile(q: number) {
    let acc = 0;
    for (let i = 0; i < sorted.length; i++) {
      acc += weights[i];
      if (acc / totalWeight >= q) return sorted[i].price;
    }
    return sorted[sorted.length - 1].price;
  }
  return {
    weightedMedian: weightedQuantile(0.5),
    weighted25th: weightedQuantile(0.25),
    weighted75th: weightedQuantile(0.75),
    recencyScore: totalWeight / (comps.length || 1)
  };
}
