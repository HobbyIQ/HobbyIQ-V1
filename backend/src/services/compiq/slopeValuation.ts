// CF-SLOPE-VALUATION (Drew, 2026-07-13, PR #419): shared helper for the
// linear-regression Market Value / Predicted Price math.
//
// Extracted from cardsightUuidPriceRouter.ts so the main CH pricing
// engine (compiqEstimate.service) can consume the same math and iOS
// sees identical semantics on the wire regardless of whether the SKU
// was resolved via CH's bubble.io catalog or Cardsight's UUID API.
//
// Contract:
//   Input:  raw sales records with (date, price)
//   Output: Market Value + Predicted + slope-derived direction, OR null
//           when the pool is too thin for a regression to fit
//
// When null is returned, the caller should fall back to its existing
// median-based value (never surface null on the wire — iOS' Card Detail
// degrades gracefully but "$—" is a bad UX; the median is a fine anchor
// for thin markets).

const MS_PER_DAY = 86_400_000;
const STATIC_DEADBAND_PCT = 3;

export interface Regression {
  slope: number;              // dollars per millisecond
  interceptAtFirstT: number;  // dollars at t = firstT (fitted OLS intercept)
  firstT: number;             // Unix ms of the earliest sale in the pool
  n: number;
}

export interface SlopeValuation {
  /** Regression fit at the LAST observed sale's date. */
  marketValue: number;
  /** Regression fit at now + 30 days. */
  predictedPrice: number;
  /** Range around the predicted value; widens on low sample counts. */
  predictedPriceRange: { low: number; high: number };
  /** "up" / "down" / "static" with a ±3% per month deadband. */
  direction: "up" | "down" | "static";
  /** Reported slope as a per-month percentage of Market Value. */
  slopePerMonthPct: number;
  /** Number of records the regression consumed. */
  n: number;
  /** Raw slope in $/ms (for downstream math / audit). */
  regressionSlope: number;
}

/**
 * Fit an ordinary-least-squares regression to (date, price) points.
 * Returns null when there are fewer than 2 records or all records share
 * the same date (no slope defined).
 *
 * Time is normalized to (tMs - firstT) internally so the fitted intercept
 * corresponds to the earliest sale's date, not the Unix epoch (avoids
 * astronomical values).
 */
export function fitLinearRegression(
  records: ReadonlyArray<{ tMs: number; price: number }>,
): Regression | null {
  if (records.length < 2) return null;
  const firstT = records[0].tMs;
  const distinctTimes = new Set(records.map((r) => r.tMs)).size;
  if (distinctTimes < 2) return null;

  const n = records.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const r of records) {
    const x = r.tMs - firstT;
    const y = r.price;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const interceptAtFirstT = (sumY - slope * sumX) / n;
  return { slope, interceptAtFirstT, firstT, n };
}

/** Evaluate the fitted regression at any timestamp (Unix ms). */
export function valueAt(reg: Regression, tMs: number): number {
  return reg.interceptAtFirstT + reg.slope * (tMs - reg.firstT);
}

/**
 * Convenience: compute Market Value + Predicted + direction from a pool
 * of raw sale records. Records are sorted chronologically; the regression
 * is evaluated at the last observed date (for Market Value) and 30 days
 * from now (for Predicted).
 *
 * `nowMs` is injectable for deterministic tests; production callers can
 * omit it and Date.now() is used.
 */
export function computeSlopeValuation(
  rawRecords: ReadonlyArray<{ date: string | null; price: number }>,
  nowMs?: number,
): SlopeValuation | null {
  const points = rawRecords
    .filter((r) => typeof r.date === "string" && r.date.length > 0 && r.price > 0)
    .map((r) => ({ tMs: Date.parse(r.date!), price: r.price }))
    .filter((p) => Number.isFinite(p.tMs));
  if (points.length < 2) return null;
  points.sort((a, b) => a.tMs - b.tMs);

  const reg = fitLinearRegression(points);
  if (!reg) return null;

  const lastT = points[points.length - 1].tMs;
  const nowT = nowMs ?? Date.now();
  const futureT = nowT + 30 * MS_PER_DAY;

  const marketAtLast = valueAt(reg, lastT);
  const predictedAt30d = valueAt(reg, futureT);

  const monthlyDelta = reg.slope * 30 * MS_PER_DAY;
  const slopePerMonthPct = marketAtLast > 0
    ? (monthlyDelta / marketAtLast) * 100
    : 0;

  const direction: "up" | "down" | "static" =
    Math.abs(slopePerMonthPct) < STATIC_DEADBAND_PCT
      ? "static"
      : slopePerMonthPct > 0
        ? "up"
        : "down";

  const spreadPct =
    reg.n >= 20 ? 0.10 :
    reg.n >= 10 ? 0.15 :
    reg.n >= 5 ? 0.22 :
    0.30;

  return {
    marketValue: Math.max(0, Math.round(marketAtLast * 100) / 100),
    predictedPrice: Math.max(0, Math.round(predictedAt30d * 100) / 100),
    predictedPriceRange: {
      low: Math.max(0, Math.round(predictedAt30d * (1 - spreadPct))),
      high: Math.round(predictedAt30d * (1 + spreadPct)),
    },
    direction,
    slopePerMonthPct: Math.round(slopePerMonthPct * 10) / 10,
    n: reg.n,
    regressionSlope: reg.slope,
  };
}
