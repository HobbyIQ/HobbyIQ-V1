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
// Grades covered: Raw, PSA 10, PSA 9, BGS 10 (Pristine), BGS 9.5, BGS 9,
// SGC 10, SGC 9, CGC 10, CGC 9 — the canonical set that covers essentially
// every real trading-card grade users care about. The list is deliberately
// bounded (10 grades × 12h cache = 10 CH calls per unique card per 12h)
// so per-card fetch cost stays predictable.

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
  // BGS 10 is the "Pristine 10" — a rarer tier above PSA 10 in most markets.
  // BGS 9.5 is the workhorse gem-mint BGS grade.
  { label: "BGS 10", grader: "BGS", psaEquivalent: 10 },
  { label: "BGS 9.5", grader: "BGS", psaEquivalent: 9.5 },
  { label: "BGS 9", grader: "BGS", psaEquivalent: 9 },
  { label: "SGC 10", grader: "SGC", psaEquivalent: 10 },
  { label: "SGC 9", grader: "SGC", psaEquivalent: 9 },
  { label: "CGC 10", grader: "CGC", psaEquivalent: 10 },
  { label: "CGC 9", grader: "CGC", psaEquivalent: 9 },
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
  /** CF-GRADE-VALUE-FALLBACK (2026-07-04): the ONE number iOS should
   *  render in the pill for this grade. Falls back through:
   *    1. Observed weighted median (when sampleCount > 0)
   *    2. Estimated: Raw observed × grade multiplier (when observed for
   *       this grade is null but Raw has data)
   *    3. null (when neither observed nor Raw is available)
   *  Consumers should pair this with `valueSource` to render an
   *  "estimated" badge when it isn't observed. */
  value: number | null;
  /** Where `value` came from. `observed` = real weighted median from
   *  actual sales; `estimated` = projected from Raw × grade multiplier;
   *  `unavailable` = no data path yielded a number. */
  valueSource: "observed" | "estimated" | "unavailable";
  /** When valueSource === "estimated", the multiplier applied to the
   *  Raw observed median. Null otherwise. Surfaced so iOS can render
   *  "est. $600 (Raw × 4.0)" if desired. */
  estimatedMultiplier: number | null;
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

  // Initial pass: observed-only. value + valueSource + estimatedMultiplier
  // are filled by fillEstimatedFallback below once every grade has been
  // aggregated (that's when we know if Raw has data to project from).
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
    value: weighted, // finalized in fillEstimatedFallback
    valueSource: weighted !== null ? "observed" : "unavailable",
    estimatedMultiplier: null,
  };
}

/**
 * CF-GRADE-VALUE-FALLBACK (2026-07-04) — HobbyIQ's grade-multiplier
 * table for projecting observed Raw → estimated graded value when
 * observed data at a grade is empty.
 *
 * These are ROUGH averages calibrated from Bowman-family autograph
 * families — Drew's calibration sweep (calibrate_deep.json 2026-07-04)
 * observed most autographs land in these ballparks. Users see the
 * estimate labeled "est." in iOS so precision expectations are
 * calibrated to "ballpark" not "authoritative."
 *
 * When the corpus grows enough that we can compute release-specific
 * multipliers reliably, swap this for computeReleaseGradeCurve()
 * (gradedPriceProjection.ts:2797). Same swap-point discipline.
 */
const RAW_TO_GRADE_FALLBACK_MULTIPLIER: Record<string, number> = {
  "Raw": 1,
  // 10-tier
  "PSA 10": 8,
  "BGS 10": 20, // Pristine — rare, big premium over PSA 10 in most markets
  "BGS 9.5": 5,
  "SGC 10": 5,
  "CGC 10": 5,
  // 9-tier — all four graders similar; PSA 9 is the reference
  "PSA 9": 3,
  "BGS 9": 3,
  "SGC 9": 3,
  "CGC 9": 3,
};

/**
 * Second-pass fill: for grades where observed sampleCount === 0, project
 * an estimated value from the Raw observed median × the grade multiplier.
 * When Raw itself has no observed data, valueSource stays "unavailable".
 * Confidence stays at the observed-computed value (near-zero when no
 * observed data) — iOS uses valueSource to render the "estimated" badge,
 * not the confidence number.
 */
function fillEstimatedFallback(entries: ObservedGradeEntry[]): void {
  const raw = entries.find((e) => e.grade === "Raw");
  const rawObserved =
    raw && raw.valueSource === "observed" && raw.weightedMedianPrice !== null
      ? raw.weightedMedianPrice
      : null;
  if (rawObserved === null) return;

  for (const entry of entries) {
    if (entry.grade === "Raw") continue;
    if (entry.valueSource === "observed") continue;
    const multiplier = RAW_TO_GRADE_FALLBACK_MULTIPLIER[entry.grade];
    if (typeof multiplier !== "number" || multiplier <= 0) continue;
    entry.value = Math.round(rawObserved * multiplier * 100) / 100;
    entry.valueSource = "estimated";
    entry.estimatedMultiplier = multiplier;
  }
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
  // Second pass — fills value/valueSource on non-observed grades by
  // projecting from Raw × multiplier. Mutates entries in place.
  fillEstimatedFallback(entries);
  return {
    cardId,
    entries,
    totalSampleCount: entries.reduce((sum, e) => sum + e.sampleCount, 0),
    computedAt: new Date().toISOString(),
  };
}

/**
 * CF-OBSERVED-GRADE-CURVES-BULK (2026-07-04): batch-build the observed
 * grade curve for many cards at once. Used by portfolio reprice, watchlist
 * refresh, and any caller with a set of cards to price.
 *
 * Behavior:
 *   1. Deduplicates cardIds — same id used by 5 holdings = 1 fetch.
 *   2. Bounded concurrency (8 cards in flight) — each card runs 10
 *      parallel grade fetches internally, so peak in-flight CH HTTPs
 *      is ~80. Keeps CH rate limit + local memory well under budget.
 *   3. Leverages the existing 12h getCardSales cache — repeated bulk
 *      calls on the same set are near-instant.
 *   4. Per-card failures degrade to empty curves (never fails the whole
 *      batch). Errors are logged for observability.
 *
 * Returns a Map<cardId, ObservedGradeCurve>. Callers can iterate,
 * transform, or emit a bulk API response as needed.
 */
const BULK_CONCURRENCY = 8;

export async function buildObservedGradeCurvesBulk(
  cardIds: readonly string[],
): Promise<Map<string, ObservedGradeCurve>> {
  const uniqueIds = Array.from(new Set(
    cardIds.filter((id) => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim()),
  ));
  const results = new Map<string, ObservedGradeCurve>();

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < uniqueIds.length) {
      const idx = cursor++;
      const id = uniqueIds[idx];
      try {
        const curve = await buildObservedGradeCurve(id);
        results.set(id, curve);
      } catch (err) {
        console.warn(
          `[observedGradeCurve.bulk] card_id=${id} failed (non-fatal): ${
            (err as Error)?.message ?? err
          }`,
        );
        results.set(id, {
          cardId: id,
          entries: CANONICAL_GRADES.map((cfg) => ({
            grade: cfg.label,
            grader: cfg.grader,
            sampleCount: 0,
            weightedMedianPrice: null,
            plainMedianPrice: null,
            priceRangeLow: null,
            priceRangeHigh: null,
            newestSaleDate: null,
            oldestSaleDate: null,
            confidenceScore: 0,
            value: null,
            valueSource: "unavailable",
            estimatedMultiplier: null,
          })),
          totalSampleCount: 0,
          computedAt: new Date().toISOString(),
        });
      }
    }
  }

  const runners = Array.from(
    { length: Math.min(BULK_CONCURRENCY, uniqueIds.length) },
    () => worker(),
  );
  await Promise.all(runners);

  return results;
}
