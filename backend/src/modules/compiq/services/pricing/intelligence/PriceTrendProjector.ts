/**
 * PriceTrendProjector
 *
 * Fits a weighted least-squares regression line through a chronological sequence
 * of comp prices and projects one step ahead — answering:
 *   "Given the trajectory of the last N sales, what should the next sale be?"
 *
 * Weights: most recent comp gets weight N, oldest gets weight 1 (linear recency).
 * Returns:
 *   - projectedPrice: the extrapolated "next sale" price
 *   - rSquared:       0–1 fit quality; 1 = all comps on a perfect line
 *   - slope:          $/sale positive = rising, negative = falling
 *   - confidence:     0–100 convenience score derived from rSquared + sample size
 */

export interface TrendProjection {
  projectedPrice: number;
  rSquared: number;        // 0–1
  slope: number;           // dollars per comp-step
  confidence: number;      // 0–100
}

export class PriceTrendProjector {
  /**
   * @param prices  Comp prices in chronological order (oldest → newest), already
   *                scarcity-normalised so all are on the same parallel plane.
   */
  static project(prices: number[]): TrendProjection | null {
    if (prices.length < 3) return null;

    const n = prices.length;

    // x = 0, 1, 2 … n-1 (time index); weights increase linearly so newest = n, oldest = 1
    const weights = prices.map((_, i) => i + 1);
    const totalW = weights.reduce((s, w) => s + w, 0);

    const wMeanX = weights.reduce((s, w, i) => s + w * i, 0) / totalW;
    const wMeanY = weights.reduce((s, w, i) => s + w * prices[i], 0) / totalW;

    let covXY = 0;
    let varX = 0;
    for (let i = 0; i < n; i++) {
      covXY += weights[i] * (i - wMeanX) * (prices[i] - wMeanY);
      varX  += weights[i] * (i - wMeanX) ** 2;
    }

    if (varX === 0) return null; // all prices identical, can't fit a line

    const slope     = covXY / varX;
    const intercept = wMeanY - slope * wMeanX;

    // Project to x = n (one step beyond the last comp)
    const projectedPrice = Math.round(intercept + slope * n);

    // Weighted R²
    const ssRes = prices.reduce((s, y, i) => {
      const fitted = intercept + slope * i;
      return s + weights[i] * (y - fitted) ** 2;
    }, 0);
    const ssTot = prices.reduce((s, y, i) => {
      return s + weights[i] * (y - wMeanY) ** 2;
    }, 0);
    const rSquared = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

    // Confidence: R² provides fit quality; sample size bumps it slightly
    // 3 comps at R²=1.0 → ~70; 8+ comps at R²=1.0 → 100
    const sampleBoost = Math.min(30, (n - 2) * 5);
    const confidence  = Math.round(Math.min(100, rSquared * 70 + sampleBoost));

    return { projectedPrice, rSquared, slope, confidence };
  }
}
