export function formatCardOutcomeViewModel(payload: any, result: any) {
  const summary = result.summary || {};
  const scenarios = (result.scenarios || []).map((s: any) => ({
    ...s,
    projectedValueLowDisplay: `$${s.projectedValueLow}`,
    projectedValueHighDisplay: `$${s.projectedValueHigh}`,
    probabilityDisplay: `${Math.round((s.probability ?? 0) * 100)}%`,
    timelineDisplay: `${s.timelineDays} days`,
    reasoning: (s.reasoning || []).map((r: string) => r.replace('Event:', 'If').replace('impact:', 'impact score'))
  }));
  return {
    success: true,
    summary: {
      currentValue: summary.currentValue ?? payload.currentEstimatedValue ?? 0,
      bestCase: summary.bestCase ?? 0,
      worstCase: summary.worstCase ?? 0,
      mostLikely: summary.mostLikely ?? 0
    },
    marketImpact: result.marketImpact ?? null,
    scenarios
  };
}
