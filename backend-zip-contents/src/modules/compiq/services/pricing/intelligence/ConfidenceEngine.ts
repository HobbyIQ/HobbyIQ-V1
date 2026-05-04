// ConfidenceEngine

export class ConfidenceEngine {
  static bundle(compCount: number, compStrength: number, liquidity: number, volatility: number) {
    // Clamp all
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    return {
      pricingConfidence: clamp(Math.round((compStrength + compCount * 10) / 2)),
      liquidityConfidence: clamp(Math.round(liquidity)),
      timingConfidence: clamp(Math.round(100 - volatility))
    };
  }
}
