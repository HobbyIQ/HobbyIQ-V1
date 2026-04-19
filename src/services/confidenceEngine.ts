import { Comp, Liquidity } from '../models/compiq';

export function computeConfidence(comps: Comp[], multiplierResult: any, liquidity: Liquidity) {
  // comp count, recency, multiplier strength, date closeness, liquidity
  let score = 0;
  if (comps.length >= 5) score += 30;
  else if (comps.length >= 2) score += 20;
  else score += 5;
  if (multiplierResult.adjustedParallelRatio) score += 20;
  if (multiplierResult.bestDateGapDays !== null) {
    score += Math.max(0, 30 - multiplierResult.bestDateGapDays);
  }
  switch (liquidity) {
    case 'high': score += 20; break;
    case 'medium': score += 10; break;
    case 'low': score += 5; break;
    case 'illiquid': score += 0; break;
  }
  return Math.max(0, Math.min(100, score));
}
