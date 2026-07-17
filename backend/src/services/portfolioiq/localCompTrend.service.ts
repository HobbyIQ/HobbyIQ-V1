// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Pure trend math over a
// window of comps. No IO — takes sorted sales, returns numbers.
// Test-only public surface: computeTrend + isolate helpers so pinning
// tests exercise regression + momentum classification directly.
//
// FMV rule ([[no-medians-project-next-sale]]): the projected next
// price is emitted from the fitted line at `t = now + step`, NEVER as
// mean/median of past comps. `meanPrice` on premium buckets is
// descriptive only.

import type { LocalCompSale, LocalCompTrend } from "../../types/localComp.types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MOMENTUM_SLOPE_UP = 0.005;   // log-price / day. ~5% / 10d threshold.
const MOMENTUM_SLOPE_DOWN = -0.005;

/** Compute trend numbers for the sales inside `windowDays`. Returns
 *  null when window has fewer than 2 valid sales (no line to fit). */
export function computeTrend(sales: LocalCompSale[], windowDays: number, now: Date = new Date()): LocalCompTrend | null {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const points = sales
    .map((s) => {
      const t = Date.parse(s.saleDate);
      if (!Number.isFinite(t) || t < cutoff) return null;
      if (!Number.isFinite(s.price) || s.price <= 0) return null;
      return { t, price: s.price };
    })
    .filter((p): p is { t: number; price: number } => p !== null);

  if (points.length === 0) return null;

  if (points.length < 2) {
    // Not enough for regression, but we can still surface velocity.
    return {
      windowDays,
      slope: 0,
      momentum: "flat",
      velocityPerWeek: (points.length * 7) / windowDays,
      volatility: 0,
      projectedNextSalePrice: points[0]?.price ?? null,
      earliestPrice: points[0]?.price ?? null,
      latestPrice: points[0]?.price ?? null,
    };
  }

  // Fit log(price) = a + b*day. Least-squares.
  const days = points.map((p) => (p.t - cutoff) / MS_PER_DAY);
  const ys = points.map((p) => Math.log(p.price));
  const { slope, intercept } = linearRegression(days, ys);

  // Volatility: stddev of log residuals.
  const residuals = points.map((p, i) => ys[i] - (intercept + slope * days[i]));
  const meanResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const variance = residuals.reduce((a, b) => a + (b - meanResidual) ** 2, 0) / residuals.length;
  const volatility = Math.sqrt(variance);

  const momentum: "up" | "flat" | "down" =
    slope > MOMENTUM_SLOPE_UP ? "up" :
    slope < MOMENTUM_SLOPE_DOWN ? "down" :
    "flat";

  const velocityPerWeek = (points.length * 7) / windowDays;

  // Projected next sale = extrapolate the line 1 step past the most
  // recent sale (average inter-sale gap).
  const sortedByT = points.slice().sort((a, b) => a.t - b.t);
  const lastDay = (sortedByT[sortedByT.length - 1].t - cutoff) / MS_PER_DAY;
  const avgGapDays = sortedByT.length >= 2
    ? (lastDay - (sortedByT[0].t - cutoff) / MS_PER_DAY) / (sortedByT.length - 1)
    : 1;
  const projectedDay = lastDay + Math.max(0.1, avgGapDays);
  const projectedNextSalePrice = Math.exp(intercept + slope * projectedDay);

  const earliestPrice = sortedByT[0].price;
  const latestPrice = sortedByT[sortedByT.length - 1].price;

  return {
    windowDays,
    slope,
    momentum,
    velocityPerWeek,
    volatility,
    projectedNextSalePrice: Number.isFinite(projectedNextSalePrice) ? projectedNextSalePrice : null,
    earliestPrice,
    latestPrice,
  };
}

/** Pure least-squares regression. Exported for direct test coverage. */
export function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

/** Momentum thresholds surfaced for test evidence. */
export const _MOMENTUM_SLOPE_UP = MOMENTUM_SLOPE_UP;
export const _MOMENTUM_SLOPE_DOWN = MOMENTUM_SLOPE_DOWN;
