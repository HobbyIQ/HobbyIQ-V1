import { Comp, EstimateInput, DebugOutput, Trend, Liquidity } from '../models/compiq';

export function buildExplanation(params: {
  comps: Comp[];
  stats: any;
  trend: Trend;
  liquidity: Liquidity;
  multiplierResult: any;
  premiumExpansion: any;
  confidenceScore: number;
  input: EstimateInput;
}): string[] {
  const notes: string[] = [];
  if (params.comps.length >= 4 && params.stats.recencyScore >= 0.7) {
    notes.push(`Used ${params.comps.length} comps within 7–30 days`);
  }
  if (params.multiplierResult.parallelInferenceActive) {
    notes.push('Parallel inference used due to stale comps');
  }
  if (params.multiplierResult.baseParallelRatio && params.multiplierResult.bestDateGapDays !== null) {
    notes.push(`Multiplier based on comps ${Math.round(params.multiplierResult.bestDateGapDays)} days apart`);
  }
  if (params.premiumExpansion.applied) {
    notes.push('Premium expanded due to low supply and strong demand');
  }
  if (params.liquidity === 'illiquid') {
    notes.push('Market is illiquid, confidence reduced');
  }
  if (params.comps.length < 2) {
    notes.push('Low data: fallback mode');
  }
  return notes;
}
