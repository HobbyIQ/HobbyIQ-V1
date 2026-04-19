import { Comp } from '../models/compiq';

export function assessLiquidity(comps: Comp[], activeListings?: Comp[]) {
  if (!comps.length) return 'illiquid';
  const now = Date.now();
  const saleDates = comps.map(c => new Date(c.saleDate).getTime()).sort((a, b) => a - b);
  const intervals = saleDates.slice(1).map((d, i) => (d - saleDates[i]) / (1000 * 60 * 60 * 24));
  const avgInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 999;
  const freq = comps.length / Math.max((now - saleDates[0]) / (1000 * 60 * 60 * 24), 1);
  if (freq > 0.5 && avgInterval < 7) return 'high';
  if (freq > 0.2 && avgInterval < 14) return 'medium';
  if (freq > 0.05 && avgInterval < 30) return 'low';
  return 'illiquid';
}
