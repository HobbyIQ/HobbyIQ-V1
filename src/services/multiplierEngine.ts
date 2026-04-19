import { Comp, EstimateInput } from '../models/compiq';

export function getDateGapDays(dateA: string, dateB: string) {
  return Math.abs((new Date(dateA).getTime() - new Date(dateB).getTime()) / (1000 * 60 * 60 * 24));
}

export function getDateClosenessScore(days: number) {
  if (days <= 3) return 1.0;
  if (days <= 7) return 0.9;
  if (days <= 14) return 0.75;
  if (days <= 21) return 0.55;
  if (days <= 30) return 0.3;
  return 0.1;
}

export function pairCompsByClosestDate(target: Comp, pool: Comp[]): {comp: Comp, days: number} | null {
  let minGap = Infinity;
  let best: Comp | null = null;
  for (const comp of pool) {
    const gap = getDateGapDays(target.saleDate, comp.saleDate);
    if (gap < minGap) {
      minGap = gap;
      best = comp;
    }
  }
  return best ? { comp: best, days: minGap } : null;
}

export function computeMultiplier(comps: Comp[], input: EstimateInput, registry: string[]) {
  // Find base and target comps
  const baseParallel = 'Base';
  const targetParallel = input.parallel;
  const baseComps = comps.filter(c => c.parallel === baseParallel);
  const targetComps = comps.filter(c => c.parallel === targetParallel);
  let bestDateGapDays = null;
  let averageDateGapDays = null;
  let baseParallelRatio = null;
  let adjustedParallelRatio = null;
  let parallelInferenceActive = false;
  if (baseComps.length && targetComps.length) {
    // Pair by closest date
    const ratios: number[] = [];
    const dateGaps: number[] = [];
    for (const t of targetComps) {
      const pair = pairCompsByClosestDate(t, baseComps);
      if (pair) {
        const ratio = t.price / pair.comp.price;
        ratios.push(ratio);
        dateGaps.push(pair.days);
      }
    }
    if (ratios.length) {
      baseParallelRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      averageDateGapDays = dateGaps.reduce((a, b) => a + b, 0) / dateGaps.length;
      bestDateGapDays = Math.min(...dateGaps);
      adjustedParallelRatio = baseParallelRatio * getDateClosenessScore(bestDateGapDays);
    }
  } else {
    parallelInferenceActive = true;
  }
  return {
    baseParallelRatio,
    adjustedParallelRatio,
    averageDateGapDays,
    bestDateGapDays,
    parallelInferenceActive
  };
}

export function multiplierConfidence(params: {
  dateCloseness: number,
  exactMatch: boolean,
  samePlayer: boolean,
  gradeMatch: boolean,
  sampleSize: number,
  variance: number
}) {
  // 30% date closeness, 25% exact match, 20% same player, 10% grade, 10% sample, 5% variance
  return Math.round(
    params.dateCloseness * 30 +
    (params.exactMatch ? 25 : 0) +
    (params.samePlayer ? 20 : 0) +
    (params.gradeMatch ? 10 : 0) +
    Math.min(params.sampleSize, 10) +
    Math.max(0, 5 - params.variance)
  );
}
