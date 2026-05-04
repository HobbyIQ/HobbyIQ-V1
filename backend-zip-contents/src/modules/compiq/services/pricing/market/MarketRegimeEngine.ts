// MarketRegimeEngine: bull/neutral/bear regime
export class MarketRegimeEngine {
  static classify(marketIndexTrend?: number): { regime: 'bull' | 'neutral' | 'bear'; multiplier: number } {
    // TODO: Use more signals
    if (marketIndexTrend && marketIndexTrend > 10) return { regime: 'bull', multiplier: 1.08 };
    if (marketIndexTrend && marketIndexTrend < -10) return { regime: 'bear', multiplier: 0.92 };
    return { regime: 'neutral', multiplier: 1.0 };
  }
}
