// CF-OBSERVED-GRADE-CURVE (2026-07-04) — HobbyIQ's own per-grade observed
// sales aggregation. Strategic intent (Drew, 2026-07-04): "our entire
// goal is to learn from CH; when eBay Browse lands we can do it on our
// own." This module encapsulates the aggregation, weighting, and
// confidence math so the fetch source (currently CH /cards/comps) can be
// swapped for eBay Browse without touching downstream consumers.
//
// Portability contract:
//   • The FETCH is one function call — fetchRawSalesForGrade() below.
//     When eBay Browse is wired, that function is the ONE change.
//   • The AGGREGATION (weightedMedian, plainMedian, confidence, ranges)
//     is HobbyIQ's model. Vendor-agnostic. Stays intact through vendor
//     migration.
//   • The RETURN SHAPE is customer-neutral. No vendor names. iOS
//     consumers see "grade / observedMedian / sampleCount / confidence"
//     with no vendor branding.
//
// Grades covered: Raw, PSA 10, PSA 9, BGS 9.5, SGC 10, CGC 10 — the
// canonical set that covers >95% of real trading-card grades. The list
// is deliberately narrow (5-6 grades × 12h cache = 6 CH calls per
// unique card per 12h) so per-card fetch cost stays bounded.

import { getCardSales } from "./cardhedge.client.js";
import { computeWeightedMedian } from "./compiqEstimate.service.js";

/** Grade lookup. `label` matches the CH grade param; `grader` is the
 *  parent grading company for UI grouping; `psaEquivalent` is used to
 *  order grades on the confidence rail (higher = better condition). */
const CANONICAL_GRADES: ReadonlyArray<{
  label: string;
  grader: string;
  psaEquivalent: number;
}> = [
  { label: "Raw", grader: "Raw", psaEquivalent: 0 },
  { label: "PSA 10", grader: "PSA", psaEquivalent: 10 },
  { label: "PSA 9", grader: "PSA", psaEquivalent: 9 },
  { label: "BGS 9.5", grader: "BGS", psaEquivalent: 9.5 },
  { label: "SGC 10", grader: "SGC", psaEquivalent: 10 },
  { label: "CGC 10", grader: "CGC", psaEquivalent: 10 },
];

/** One aggregated grade row. Every number is HobbyIQ's own — computed
 *  from raw sales, not read from a vendor's model estimate. */
export interface ObservedGradeEntry {
  grade: string;
  grader: string;
  sampleCount: number;
  /** Velocity-weighted median. Uses recency-decay so a $200 sale from
   *  48h ago carries 5× the weight of a $200 sale from 30 days ago.
   *  Null when the pool is empty. */
  weightedMedianPrice: number | null;
  /** Plain (equal-weighted) median. Emitted alongside the weighted
   *  value so callers can inspect how much weight-decay changed the
   *  answer — big divergence = market moved recently. */
  plainMedianPrice: number | null;
  /** Range endpoints — 10th and 90th percentile of the raw price pool.
   *  Nullable when n < 4 (percentiles at low n are misleading). */
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  newestSaleDate: string | null;
  oldestSaleDate: string | null;
  /** 0–1 confidence in this grade's median, derived from sample count
   *  and recency. n=1 → 0.20; n=3 → 0.50; n=5 → 0.70; n=10 → 0.85;
   *  n=20+ → 1.00. If newest sale > 60d ago, multiply by 0.7. */
  confidenceScore: number;
}

export interface ObservedGradeCurve {
  cardId: string;
  /** Per-grade rows. Present for every canonical grade even when
   *  sampleCount=0, so iOS decoders have a stable schema. */
  entries: ObservedGradeEntry[];
  /** Total raw sales seen across every grade probed. Useful as a
   *  headline liquidity signal for the card overall. */
  totalSampleCount: number;
  /** ISO timestamp when this curve was computed. */
  computedAt: string;
}

/**
 * The SINGLE swap point when we transition from CH to eBay Browse.
 * Everything else in this module is vendor-agnostic.
 *
 * When eBay Browse is wired: replace the body with the eBay call,
 * keep the return shape identical. Callers keep working unchanged.
 */
async function fetchRawSalesForGrade(
  cardId: string,
  grade: string,
): Promise<Array<{ price: number; date: string | null }>> {
  const sales = await getCardSales(cardId, grade, 50);
  return sales
    .map((s) => ({
      price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
      date: s.date ?? null,
    }))
    .filter((s) => Number.isFinite(s.price) && s.price > 0);
}

function computePlainMedian(prices: number[]): number | null {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function computePercentile(prices: number[], p: number): number | null {
  if (prices.length < 4) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeConfidence(sampleCount: number, newestDate: string | null): number {
  let base: number;
  if (sampleCount === 0) return 0;
  if (sampleCount === 1) base = 0.20;
  else if (sampleCount === 2) base = 0.35;
  else if (sampleCount <= 4) base = 0.50;
  else if (sampleCount <= 9) base = 0.70;
  else if (sampleCount <= 19) base = 0.85;
  else base = 1.00;

  if (!newestDate) return base * 0.7;
  const ts = Date.parse(newestDate);
  if (!Number.isFinite(ts)) return base * 0.7;
  const daysSinceNewest = (Date.now() - ts) / (24 * 3600 * 1000);
  if (daysSinceNewest > 60) return Math.round(base * 0.7 * 100) / 100;
  return Math.round(base * 100) / 100;
}

async function aggregateGrade(
  cardId: string,
  cfg: (typeof CANONICAL_GRADES)[number],
): Promise<ObservedGradeEntry> {
  const sales = await fetchRawSalesForGrade(cardId, cfg.label);
  const prices = sales.map((s) => s.price);
  const dates = sales
    .map((s) => s.date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();

  const weighted = computeWeightedMedian(
    sales.map((s) => ({ price: s.price, date: s.date })),
  );
  const plain = computePlainMedian(prices);
  const low = computePercentile(prices, 0.10);
  const high = computePercentile(prices, 0.90);
  const newest = dates.length ? dates[dates.length - 1] : null;
  const oldest = dates.length ? dates[0] : null;

  return {
    grade: cfg.label,
    grader: cfg.grader,
    sampleCount: sales.length,
    weightedMedianPrice: weighted,
    plainMedianPrice: plain,
    priceRangeLow: low,
    priceRangeHigh: high,
    newestSaleDate: newest,
    oldestSaleDate: oldest,
    confidenceScore: computeConfidence(sales.length, newest),
  };
}

/**
 * Compute HobbyIQ's per-grade observed sales curve for a card.
 *
 * Iterates the canonical grade set in parallel (each grade is one CH
 * fetch, cached 12h). Total fanout: len(CANONICAL_GRADES) HTTPs per
 * unique card per 12h — bounded and predictable.
 *
 * Every input grade produces a row (even empty ones) so consumers can
 * render a stable UI without extra null-coalescing.
 */
export async function buildObservedGradeCurve(cardId: string): Promise<ObservedGradeCurve> {
  const entries = await Promise.all(
    CANONICAL_GRADES.map((cfg) => aggregateGrade(cardId, cfg)),
  );
  return {
    cardId,
    entries,
    totalSampleCount: entries.reduce((sum, e) => sum + e.sampleCount, 0),
    computedAt: new Date().toISOString(),
  };
}
