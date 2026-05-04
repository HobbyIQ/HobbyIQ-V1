// FeeNetValueEngine

export class FeeNetValueEngine {
  static netValue(gross: number, feePct = 0.13, shipping = 5): number {
    // Clamp gross
    if (!gross || gross < 0) return 0;
    return Math.round(gross * (1 - feePct) - shipping);
  }
}
