// ConfidenceEngine

export class ConfidenceEngine {
  static bundle(compCount: number, compStrength: number, liquidity: number, volatility: number) {
    const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

    // compStrength is 0-100 (trust score). compCount boosts up to ~25pts via log scale.
    // 1 comp → ~0, 5 comps → ~16, 10 comps → ~23, 20+ comps → ~25
    const compCountBoost = Math.min(25, Math.log2(compCount + 1) * 8);
    // Normalize compStrength from trust-score range (typically 70-100) to 0-75
    const normalizedStrength = Math.max(0, ((compStrength - 50) / 50) * 75);
    const pricingConfidence = clamp(normalizedStrength + compCountBoost);

    // Liquidity confidence: direct from liquidity score (0-100)
    const liquidityConfidence = clamp(liquidity);

    // Timing confidence: lower volatility = higher confidence. Add small boost for high liquidity.
    const liquidityBoost = Math.min(10, liquidity / 10);
    const timingConfidence = clamp(100 - volatility + liquidityBoost);

    return { pricingConfidence, liquidityConfidence, timingConfidence };
  }
}
