/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM (2026-07-01):
 * Pure computation of matched-cohort momentum from per-card weekly
 * sales data.
 *
 * The interesting statistical work happens here. Downstream providers
 * (CH today, eBay-direct tomorrow) fetch + normalize into
 * CardWeeklySalesSeries, then pass the collection to this function.
 * The compute is vendor-agnostic.
 */

import type {
  CardWeeklySalesSeries,
  MatchedCohortResult,
  MatchedCohortMember,
} from "./matchedCohort.types.js";

/** Default: how many weeks BEFORE the latest to use as the "prior" comparison window. */
const DEFAULT_PRIOR_WINDOW_WEEKS = 4;

/**
 * Compute matched-cohort momentum for a player.
 *
 * @param perCardSeries — one series per card the player has. Weeks
 *   should already be sorted ascending by weekStart within each series.
 *   Cards with zero weeks or no sales are tolerated.
 * @param priorWindowWeeks — how many weeks of pre-latest data to use
 *   for the prior comparison. Default 4.
 *
 * Algorithm:
 *   1. Determine the latest week that appears in ANY card's series.
 *      That's our "latest complete week" anchor. (Callers pass in
 *      only complete weeks — partials filtered at the provider layer.)
 *   2. For each card:
 *        a. Find the bucket matching that week. Skip card if absent.
 *        b. Take the next-latest-N buckets as the prior window.
 *        c. If prior window has zero sales across all buckets, drop.
 *        d. Compute priorMedianPrice = median of prior-window
 *           medianPrice values (weighted by saleCount).
 *        e. ratio = latestWeekMedianPrice / priorMedianPrice.
 *        f. Add to cohort.
 *   3. Aggregate: medianRatio = median of per-card ratios.
 *
 * The choice of median (not mean) at both the intra-card and aggregate
 * layer makes the signal robust to outlier sales AND outlier cards.
 * A single one-off $50k Superfractor sale in the latest week can't
 * dominate the aggregate.
 */
export function computeMatchedCohortMomentum(
  perCardSeries: ReadonlyArray<CardWeeklySalesSeries>,
  priorWindowWeeks: number = DEFAULT_PRIOR_WINDOW_WEEKS,
): MatchedCohortResult {
  const empty: MatchedCohortResult = {
    latestWeekStart: "",
    latestWeekEnd: "",
    priorWindowWeeksCount: priorWindowWeeks,
    cohort: [],
    medianRatio: null,
    meanRatio: null,
    latestWeekActiveCards: 0,
    totalCardsEvaluated: perCardSeries.length,
    droppedNewOrLongTail: 0,
  };
  if (perCardSeries.length === 0) return empty;

  // ── 1. Determine latest week ────────────────────────────────────
  let latestWeekStart = "";
  let latestWeekEnd = "";
  for (const series of perCardSeries) {
    for (const b of series.buckets) {
      if (b.weekStart > latestWeekStart) {
        latestWeekStart = b.weekStart;
        latestWeekEnd = b.weekEnd;
      }
    }
  }
  if (!latestWeekStart) return empty;

  // ── 2. Build cohort ─────────────────────────────────────────────
  const cohort: MatchedCohortMember[] = [];
  let latestWeekActiveCards = 0;
  let droppedNewOrLongTail = 0;

  for (const series of perCardSeries) {
    // Sort ascending by weekStart in case caller didn't pre-sort.
    const sorted = [...series.buckets].sort((a, b) =>
      a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0,
    );

    const latestIdx = sorted.findIndex((b) => b.weekStart === latestWeekStart);
    if (latestIdx < 0) continue; // this card didn't sell in the latest week
    const latestBucket = sorted[latestIdx];
    if (latestBucket.saleCount === 0) continue;

    latestWeekActiveCards += 1;

    // Prior window: up to N buckets before the latest.
    const priorBuckets = sorted.slice(Math.max(0, latestIdx - priorWindowWeeks), latestIdx);
    const priorWithSales = priorBuckets.filter((b) => b.saleCount > 0);
    if (priorWithSales.length === 0) {
      droppedNewOrLongTail += 1;
      continue;
    }

    const priorMedianPrice = weightedMedian(
      priorWithSales.map((b) => ({ value: b.medianPrice, weight: b.saleCount })),
    );
    if (priorMedianPrice === null || priorMedianPrice <= 0) {
      droppedNewOrLongTail += 1;
      continue;
    }

    const priorWindowSaleCount = priorWithSales.reduce((s, b) => s + b.saleCount, 0);
    const ratio = latestBucket.medianPrice / priorMedianPrice;
    cohort.push({
      cardId: series.cardId,
      latestWeekMedianPrice: round(latestBucket.medianPrice),
      latestWeekSaleCount: latestBucket.saleCount,
      priorWindowMedianPrice: round(priorMedianPrice),
      priorWindowSaleCount,
      ratio: round3(ratio),
    });
  }

  // ── 3. Aggregate ────────────────────────────────────────────────
  const ratios = cohort.map((m) => m.ratio);
  const medianRatio = ratios.length > 0 ? round3(median(ratios)) : null;
  const meanRatio =
    ratios.length > 0 ? round3(ratios.reduce((s, r) => s + r, 0) / ratios.length) : null;

  return {
    latestWeekStart,
    latestWeekEnd,
    priorWindowWeeksCount: priorWindowWeeks,
    cohort,
    medianRatio,
    meanRatio,
    latestWeekActiveCards,
    totalCardsEvaluated: perCardSeries.length,
    droppedNewOrLongTail,
  };
}

// ── math helpers ─────────────────────────────────────────────────────

/** Standard median of a numeric array. Assumes sorted-or-unsorted; sorts internally. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

/**
 * Weighted median: for each entry, treat weight as multiplicity when
 * finding the median. Used for the prior-window rollup — a week with
 * 20 sales should count 20× as much toward the "typical prior price"
 * as a week with 1 sale.
 *
 * Returns null on empty input or zero total weight.
 */
function weightedMedian(entries: ReadonlyArray<{ value: number; weight: number }>): number | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((s, e) => s + e.weight, 0);
  if (totalWeight <= 0) return null;
  const target = totalWeight / 2;
  let running = 0;
  for (const e of sorted) {
    running += e.weight;
    if (running >= target) return e.value;
  }
  return sorted[sorted.length - 1].value;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
