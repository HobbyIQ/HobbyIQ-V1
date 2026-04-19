import { Comp } from '../models/compiq';

export function trimOutliers(comps: Comp[]): Comp[] {
  if (comps.length < 5) return comps;
  const prices = comps.map(c => c.price).sort((a, b) => a - b);
  const q1 = prices[Math.floor(prices.length * 0.25)];
  const q3 = prices[Math.floor(prices.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return comps.filter(c => c.price >= lower && c.price <= upper);
}
