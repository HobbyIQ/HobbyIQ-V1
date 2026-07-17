// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Observed grader + parallel
// premium curves from the sales in a lookup result. Bucket by grader
// (or by variant) and report multiplier vs baseline.
//
// Baselines:
//   Grader curve → Raw = 1.0
//   Parallel curve → Base = 1.0
//
// Pure — no IO. Test-covered.

import type { LocalCompSale, LocalCompPremium } from "../../types/localComp.types.js";

const MIN_BUCKET_N = 3; // don't publish a premium multiplier off <3 sales

export function computeGraderPremiums(sales: LocalCompSale[]): Record<string, LocalCompPremium> {
  const buckets = bucketBy(sales, (s) => s.grader);
  return computePremiumsVsBaseline(buckets, "Raw");
}

export function computeParallelPremiums(sales: LocalCompSale[]): Record<string, LocalCompPremium> {
  const buckets = bucketBy(sales, (s) => s.variant);
  return computePremiumsVsBaseline(buckets, "Base");
}

function bucketBy(sales: LocalCompSale[], key: (s: LocalCompSale) => string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const s of sales) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue;
    const k = key(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(s.price);
  }
  return m;
}

function computePremiumsVsBaseline(
  buckets: Map<string, number[]>,
  baselineKey: string,
): Record<string, LocalCompPremium> {
  const baselinePrices = buckets.get(baselineKey);
  const baselineMean = baselinePrices && baselinePrices.length >= MIN_BUCKET_N
    ? mean(baselinePrices)
    : null;

  const out: Record<string, LocalCompPremium> = {};
  for (const [k, prices] of buckets.entries()) {
    if (prices.length < MIN_BUCKET_N) continue;
    const m = mean(prices);
    out[k] = {
      n: prices.length,
      meanPrice: round(m, 2),
      multiplierVsBaseline: baselineMean !== null && baselineMean > 0
        ? round(m / baselineMean, 3)
        : k === baselineKey ? 1 : 0,
    };
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

/** Exposed for pinning tests. */
export const _MIN_BUCKET_N = MIN_BUCKET_N;
