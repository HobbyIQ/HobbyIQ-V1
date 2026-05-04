/**
 * Comp price anomaly scoring service.
 *
 * Enhances per-comp quality scores with a PRICE POSITION signal — detecting
 * comps whose price is statistically suspicious relative to the pool, even
 * when their title identity (player, parallel, grade) matches well.
 *
 * Common cases this catches:
 *   - A gold auto that sold for $8 in a pool where all others are $80-120
 *     (mislabeled, damaged card not mentioned in title, or wrong product)
 *   - A single comp at 4x the pool median inflating the estimate upward
 *     (collector premium, overseas buyer, or data entry error)
 *
 * Method: Tukey IQR fence + Z-score composite.
 *   - IQR fence: Q1 - k*IQR / Q3 + k*IQR (k=1.5 standard, tighter than
 *     the pricing engine's k=2.0 — quality scoring can be more aggressive)
 *   - Z-score: |price - mean| / stddev
 *   - Combined into an anomaly penalty [0.0 = normal, 1.0 = extreme]
 *   - Applied as a multiplicative adjustment to the existing compQualityScore
 *
 * The adjustment is capped so a suspicious price never zeroes out an otherwise
 * good comp — it reduces weight but doesn't hard-reject (IQR outlier removal
 * in separateOutliers() handles hard rejection at a higher threshold).
 */

export interface AnomalyContext {
  /** Pool of prices to score against. Should be the clean (non-rejected) pool. */
  prices: number[];
  /** Minimum pool size before anomaly scoring kicks in. Below this, return 0. */
  minPoolSize?: number;
}

export interface CompAnomalyResult {
  /** 0.0 = not anomalous, 1.0 = extreme outlier */
  anomalyScore: number;
  /** Multiplicative quality penalty: multiply existing quality score by this (0.4–1.0) */
  qualityPenalty: number;
  /** Human-readable reason if anomalous */
  reason: string | null;
  /** Z-score of this price in the pool */
  zScore: number;
  /** Whether it falls outside the IQR 1.5x fences */
  outsideIqrFence: boolean;
}

/**
 * Score a single comp's price against its pool for anomalousness.
 */
export function scoreCompAnomaly(price: number, ctx: AnomalyContext): CompAnomalyResult {
  const { prices, minPoolSize = 4 } = ctx;
  const N = prices.length;

  if (N < minPoolSize) {
    return { anomalyScore: 0, qualityPenalty: 1.0, reason: null, zScore: 0, outsideIqrFence: false };
  }

  // ── IQR fence ───────────────────────────────────────────────────────────
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(N * 0.25)];
  const q3 = sorted[Math.floor(N * 0.75)];
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const outsideIqrFence = price < loFence || price > hiFence;

  // ── Z-score ─────────────────────────────────────────────────────────────
  const mean = prices.reduce((s, p) => s + p, 0) / N;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / N;
  const stddev = Math.sqrt(variance);
  const zScore = stddev > 0 ? Math.abs(price - mean) / stddev : 0;

  // ── Composite anomaly score ──────────────────────────────────────────────
  // Z-score contribution: 0 at z<1.5, scales to 1.0 at z>=3.5
  const zContrib = Math.min(1.0, Math.max(0, (zScore - 1.5) / 2.0));
  // IQR contribution: binary 0/0.6
  const iqrContrib = outsideIqrFence ? 0.6 : 0;
  // Combine — cap at 1.0
  const anomalyScore = Math.min(1.0, zContrib * 0.4 + iqrContrib * 0.6);

  // ── Quality penalty ──────────────────────────────────────────────────────
  // Maps anomaly score 0→1 to penalty 1.0→0.40
  // Kept above 0.40 so a suspicious comp still contributes (just less)
  const qualityPenalty = parseFloat((1.0 - anomalyScore * 0.6).toFixed(3));

  let reason: string | null = null;
  if (anomalyScore >= 0.6) {
    const dir = price < mean ? "below" : "above";
    reason = `Price $${price.toFixed(0)} is ${dir} pool mean $${mean.toFixed(0)} (z=${zScore.toFixed(1)})${outsideIqrFence ? ", outside IQR fence" : ""}`;
  } else if (outsideIqrFence) {
    reason = `Price $${price.toFixed(0)} is outside IQR fence [$${loFence.toFixed(0)}–$${hiFence.toFixed(0)}]`;
  }

  return { anomalyScore, qualityPenalty, reason, zScore, outsideIqrFence };
}

/**
 * Score all comps in a pool and return quality penalty multipliers by index.
 * Use this to apply anomaly adjustments in bulk after identity scoring.
 */
export function scorePoolAnomalies(
  prices: number[],
  minPoolSize = 4,
): CompAnomalyResult[] {
  return prices.map((price) => scoreCompAnomaly(price, { prices, minPoolSize }));
}
