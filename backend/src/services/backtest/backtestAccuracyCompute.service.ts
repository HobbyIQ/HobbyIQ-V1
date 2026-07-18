// CF-BACKTEST-ACCURACY (Drew, 2026-07-17). Pure math for the engine
// prediction-accuracy backtest. Given per-cardId histories of
// (date, predictedPrice) snapshots + actual sales that landed in the
// same window, compute how close the predictions were to reality.
//
// Metrics:
//   • medianAbsPctError: median of |actual − predicted| / predicted
//   • hitRateWithin10Pct: fraction of predictions where |err| ≤ 10%
//   • hitRateWithin20Pct: fraction where |err| ≤ 20%
//   • overShootShare: fraction where predicted > actual (we're too bullish)
//   • underShootShare: fraction where predicted < actual (we're too bearish)
//
// Trust-worthiness of the report depends on the count. Below 20
// matched pairs, we mark verdict="insufficient_sample" and don't
// publish the metrics.

export interface PredictionActualPair {
  cardId: string;
  snapshotDate: string;    // YYYY-MM-DD
  predictedPrice: number;
  actualSalePrice: number;
  actualSaleDate: string;
  daysBetween: number;      // saleDate − snapshotDate
}

export interface BacktestAccuracyResult {
  windowDays: number;
  matchedPairs: number;
  medianAbsPctError: number | null;
  hitRateWithin10Pct: number | null;
  hitRateWithin20Pct: number | null;
  overShootShare: number | null;
  underShootShare: number | null;
  verdict: "trustworthy" | "developing" | "insufficient_sample";
}

const MIN_PAIRS_FOR_METRICS = 20;
const TRUSTWORTHY_HIT_RATE_20 = 0.70;

export function computeBacktestAccuracy(
  pairs: PredictionActualPair[],
  windowDays: number,
): BacktestAccuracyResult {
  const clean = pairs.filter(
    (p) =>
      Number.isFinite(p.predictedPrice)
      && p.predictedPrice > 0
      && Number.isFinite(p.actualSalePrice)
      && p.actualSalePrice > 0,
  );

  if (clean.length < MIN_PAIRS_FOR_METRICS) {
    return {
      windowDays,
      matchedPairs: clean.length,
      medianAbsPctError: null,
      hitRateWithin10Pct: null,
      hitRateWithin20Pct: null,
      overShootShare: null,
      underShootShare: null,
      verdict: "insufficient_sample",
    };
  }

  const errors = clean.map((p) => (p.actualSalePrice - p.predictedPrice) / p.predictedPrice);
  const absErrors = errors.map((e) => Math.abs(e));

  const medianAbsPctError = median(absErrors);
  const hitRate10 = fractionSatisfying(absErrors, (e) => e <= 0.10);
  const hitRate20 = fractionSatisfying(absErrors, (e) => e <= 0.20);
  const over = fractionSatisfying(errors, (e) => e < 0);   // actual < predicted → predicted too high
  const under = fractionSatisfying(errors, (e) => e > 0);  // actual > predicted → predicted too low

  const verdict: BacktestAccuracyResult["verdict"] =
    hitRate20 >= TRUSTWORTHY_HIT_RATE_20 ? "trustworthy" : "developing";

  return {
    windowDays,
    matchedPairs: clean.length,
    medianAbsPctError: round4(medianAbsPctError),
    hitRateWithin10Pct: round4(hitRate10),
    hitRateWithin20Pct: round4(hitRate20),
    overShootShare: round4(over),
    underShootShare: round4(under),
    verdict,
  };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

function fractionSatisfying(nums: number[], pred: (n: number) => boolean): number {
  if (nums.length === 0) return 0;
  let hits = 0;
  for (const n of nums) if (pred(n)) hits++;
  return hits / nums.length;
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

export const _MIN_PAIRS_FOR_METRICS = MIN_PAIRS_FOR_METRICS;
export const _TRUSTWORTHY_HIT_RATE_20 = TRUSTWORTHY_HIT_RATE_20;
