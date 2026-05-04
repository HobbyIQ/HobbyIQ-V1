// DealScoreEngine

export class DealScoreEngine {
  static score(edge: number, liquidity: number, timing: number, risk: number): number {
    // Clamp all scores 0-100
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    // Simple weighted sum
    const score = 0.4 * clamp(edge) + 0.2 * clamp(liquidity) + 0.2 * clamp(timing) - 0.2 * clamp(risk);
    return clamp(Math.round(score));
  }
}
