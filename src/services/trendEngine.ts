import { Comp } from '../models/compiq';
import { getDateGapDays } from './multiplierEngine';

export function detectTrend(comps: Comp[]) {
  if (comps.length < 3) return 'flat';
  const sorted = comps.slice().sort((a, b) => new Date(a.saleDate).getTime() - new Date(b.saleDate).getTime());
  const last3 = sorted.slice(-3).map(c => c.price);
  const last5 = sorted.slice(-5).map(c => c.price);
  const older = sorted.slice(0, -5).map(c => c.price);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const last3Avg = avg(last3);
  const last5Avg = avg(last5);
  const olderAvg = avg(older);
  if (last3Avg > last5Avg * 1.1 && last5Avg > olderAvg * 1.1) return 'strong_up';
  if (last3Avg > last5Avg * 1.03 && last5Avg > olderAvg * 1.03) return 'mild_up';
  if (last3Avg < last5Avg * 0.9 && last5Avg < olderAvg * 0.9) return 'strong_down';
  if (last3Avg < last5Avg * 0.97 && last5Avg < olderAvg * 0.97) return 'mild_down';
  return 'flat';
}
