/**
 * CF-ONE-GRADE-CURVE (D4 "one valuation path", PR 4 — 2026-08-29).
 *
 * THE writer of a grade-curve entry's numbers from the unified engine, and
 * the field-population contract iOS depends on.
 *
 * Why one writer. The entry shape iOS decodes (`CardPanelGradeEntry`,
 * HobbyIQ/CompIQCardGrades.swift) was being written by four producers with
 * four different aggregations — observedGradeCurve's overlay (unified, fixed
 * 180d, slug union), the /card-panel route's second overlay (unified again,
 * adaptive window, identity slug), treeGradeCurve's enricher (its own 7d-first
 * cascade) and the grade-rescue overlay (plain medians) — and the LAST one to
 * run won. iOS then resolved a headline through a fifth chain of its own:
 *
 *     resolvedMarketValue = trendAdjustedValue ?? value
 *                           ?? weightedMedianPrice ?? plainMedianPrice
 *
 * so WHICH of those four fields a producer chose to fill moved the headline
 * with no wire-shape change and no failing test. This module makes the
 * choice once, in one place, and pins it (tests/gradeCurveEntryFieldPopulation).
 *
 * ── The contract: a tier the unified engine priced (valueSource "observed") ──
 *
 *   field                 exact-pool-projection / -leading-edge / -weighted-median
 *   ─────────────────────────────────────────────────────────────────────────
 *   trendAdjustedValue    marketValue — the rung's number. NEVER null on a
 *                         unified tier, so iOS's chain stops here and never
 *                         reaches a median.
 *   value                 = trendAdjustedValue. The same number in the
 *                         fallback slot: every reader (`trendAdjustedValue ??
 *                         value`) sees ONE value, and a median can no longer
 *                         hide in the slot the headline falls through to.
 *   trendAdjustmentPct    lift from the pool's weighted median to the market
 *                         value (the trend's contribution); 0 on the
 *                         weighted-median rung, which claims no trend.
 *   weightedMedianPrice   the pool's recency-weighted median — DIAGNOSTIC.
 *   plainMedianPrice      the pool's plain median — DIAGNOSTIC.
 *                         Both stay populated because iOS's LAST SALE cell
 *                         (`observedSaleValue`) and the corpus read them as
 *                         observed-pool numbers; neither is ever the headline
 *                         while trendAdjustedValue is populated, which it
 *                         always is here.
 *   priceRangeLow/High    p10 / p90 of the pool; null below 4 samples.
 *   sampleCount           the pool's size (after dedupe).
 *   newestSaleDate,       from the pool.
 *   daysSinceNewestSale
 *   predictedPriceAt30d   predictedPrice — the same fit read at +7d (wire name
 *                         kept for back-compat; horizon below says 7).
 *   predictedPricePct     trendPctPerWeek — the trend scalar iOS renders as
 *                         the Change row; null when the rung has no trend
 *                         (weighted-median) rather than a stale number.
 *   predictedPriceRange   ±8% around predictedPriceAt30d (the observed band).
 *   predictedHorizonDays  7.
 *   confidenceScore       caller-supplied on the service's own scale.
 *   valueSource           "observed".
 *   rungLabel             the unified tier's label (fmvRung.ts vocabulary).
 *   estimatedMultiplier,  null — nothing was estimated.
 *   estimatedFrom
 *
 *   Untouched (owned by the service's own pass, not part of the number):
 *   grade, grader, oldestSaleDate, newestSalePrice, recommendation,
 *   salesHistory, referencePrice*, siblingFallback.
 *
 * ── The other two valueSources, for the record ──
 *
 *   "estimated"   (rungLabel "grade-curve-estimate"): `value` is the estimate
 *                 (anchor × empirical ratio, or a sibling projection);
 *                 trendAdjustedValue is null on the ratio paths, so iOS
 *                 resolves to `value` — the estimate, never a pool median,
 *                 because an estimated tier HAS no pool.
 *   "unavailable" (rungLabel null): every number is null; iOS resolves nil.
 *
 * No medians as FMV: the only rung whose number IS a median is
 * exact-pool-weighted-median, and it says so in its label.
 */
import type { UnifiedGradeEntry } from "./unifiedPricing.service.js";
import type { ObservedGradeEntry } from "./observedGradeCurve.service.js";

/** The horizon unified's predictedPrice projects to (forwardDays: 7). */
export const UNIFIED_PREDICTED_HORIZON_DAYS = 7;
/** The observed-tier band the curve has always drawn around a prediction. */
export const UNIFIED_PREDICTED_RANGE_PCT = 0.08;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A tier with nothing in it — every number null, valueSource unavailable.
 *  The shape iOS decodes, with every key present. */
export function blankGradeCurveEntry(grade: string, grader: string): ObservedGradeEntry {
  return {
    grade,
    grader,
    sampleCount: 0,
    ownSampleCount: 0,
    weightedMedianPrice: null,
    plainMedianPrice: null,
    priceRangeLow: null,
    priceRangeHigh: null,
    newestSaleDate: null,
    oldestSaleDate: null,
    confidenceScore: 0,
    value: null,
    valueSource: "unavailable",
    rungLabel: null,
    estimatedMultiplier: null,
    estimatedFrom: null,
    daysSinceNewestSale: null,
    newestSalePrice: null,
    trendAdjustedValue: null,
    trendAdjustmentPct: null,
    predictedPriceAt30d: null,
    predictedPricePct: null,
    predictedPriceRangeLow: null,
    predictedPriceRangeHigh: null,
    predictedHorizonDays: UNIFIED_PREDICTED_HORIZON_DAYS,
    recommendation: null,
    salesHistory: [],
    referencePrice: null,
    referenceDivergencePct: null,
    referenceAnomaly: false,
  };
}

/** True iff the unified tier carries a number the contract can be applied
 *  to. A tier with no median has no pool; it is not "observed". */
export function unifiedTierHasPool(um: Pick<UnifiedGradeEntry, "weightedMedian" | "sampleCount" | "marketValue">): boolean {
  return um.weightedMedian != null && um.weightedMedian > 0 && um.sampleCount > 0
    && um.marketValue != null && um.marketValue > 0;
}

/**
 * Write the unified tier's numbers onto a grade-curve entry, per the contract
 * above. Mutates and returns `entry`. The caller decides WHICH entry a unified
 * tier maps to (label matching is the caller's concern) and supplies the
 * confidence on its own scale; this function decides which FIELDS carry the
 * number, and that decision is made nowhere else.
 */
export function applyUnifiedTierToEntry(
  entry: ObservedGradeEntry,
  um: UnifiedGradeEntry,
  opts: { confidenceScore: number; nowMs?: number },
): ObservedGradeEntry {
  if (!unifiedTierHasPool(um)) return entry;
  const nowMs = opts.nowMs ?? Date.now();
  const marketValue = round2(um.marketValue as number);
  const weighted = round2(um.weightedMedian as number);
  const predicted = um.predictedPrice != null && um.predictedPrice > 0
    ? round2(um.predictedPrice)
    : marketValue;
  const newestMs = um.newestSaleDate ? Date.parse(um.newestSaleDate) : NaN;

  entry.value = marketValue;
  entry.trendAdjustedValue = marketValue;
  entry.trendAdjustmentPct = weighted > 0
    ? Math.round(((marketValue / weighted) - 1) * 10000) / 100
    : null;
  entry.weightedMedianPrice = weighted;
  entry.plainMedianPrice = um.plainMedian != null ? round2(um.plainMedian) : null;
  entry.priceRangeLow = um.p10 != null ? round2(um.p10) : null;
  entry.priceRangeHigh = um.p90 != null ? round2(um.p90) : null;
  entry.sampleCount = um.sampleCount;
  entry.newestSaleDate = um.newestSaleDate ?? null;
  entry.daysSinceNewestSale = Number.isFinite(newestMs)
    ? Math.max(0, Math.floor((nowMs - newestMs) / 86_400_000))
    : null;
  entry.confidenceScore = opts.confidenceScore;
  entry.valueSource = "observed";
  entry.rungLabel = um.rungLabel;
  entry.estimatedMultiplier = null;
  entry.estimatedFrom = null;
  entry.predictedPriceAt30d = predicted;
  entry.predictedPricePct = um.trendPctPerWeek;
  entry.predictedPriceRangeLow = round2(predicted * (1 - UNIFIED_PREDICTED_RANGE_PCT));
  entry.predictedPriceRangeHigh = round2(predicted * (1 + UNIFIED_PREDICTED_RANGE_PCT));
  entry.predictedHorizonDays = UNIFIED_PREDICTED_HORIZON_DAYS;
  return entry;
}

/** The label the curve uses for an entry: "Raw" for the raw tier, else the
 *  entry's own grade label ("PSA 10", "BGS 9.5"), which already carries the
 *  grader. Unified labels its tiers the same way, so the two match directly.
 *  (`${grader} ${grade}` produced "PSA PSA 10" and matched nothing —
 *  CF-GRADE-LABEL-BUGFIX, 2026-08-08.) */
export function gradeCurveEntryLabel(entry: { grade: string | number; grader: string }): string {
  const gradeStr = String(entry.grade).trim();
  return entry.grader === "Raw" || gradeStr.toLowerCase() === "raw" ? "Raw" : gradeStr;
}
