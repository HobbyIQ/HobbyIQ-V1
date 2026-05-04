// PriceDistributionEngine

export class PriceDistributionEngine {
  static quickSale(fmv: number): number {
    return Math.round(fmv * 0.85);
  }
  static premium(fmv: number, marketStrength: 'fast' | 'normal' | 'slow'): number {
    const multiplier = marketStrength === 'fast' ? 1.25 : marketStrength === 'normal' ? 1.15 : 1.10;
    return Math.round(fmv * multiplier);
  }
}
