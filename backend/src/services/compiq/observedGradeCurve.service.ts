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
// CF-MATCHED-COHORT-TRAJECTORY (2026-07-05): swap the noisy raw
// sales-stats-by-player signal for the mix-bias-free matched-cohort
// medianRatio when available. Per project memory
// (project_matched_cohort_supersedes_raw): "matched-cohort medianRatio
// is the SUPERIOR player-momentum signal vs raw sales-stats-by-player
// avgSale; downstream must prefer matched-cohort when available (Eric
// Hartman 2026-07-01: raw -8% wrong, matched +36% correct)."
//
// getPlayerTrendSnapshot handles both: it prefers matched-cohort from
// the pre-computed cache, falls back to raw sales-stats-by-player when
// matched-cohort isn't available. We consume the resulting snapshot
// and pick whichever signal it exposes.
import { getPlayerTrendSnapshot } from "../playerTrend/index.js";
// CF-MATCHED-COHORT-ON-DEMAND (2026-07-05): on-demand computation +
// write-back when the pre-populated cache misses. The overnight job
// only covers Bowman-universe + portfolio-holdings players, so a
// long-tail player like Adamczewski (thin cohort, not on any
// portfolio) never gets matched-cohort → downstream falls back to
// raw signal → mix bias returns. This closes that gap by computing
// on-demand and caching the result so the next 24h hits the cache.
import { fetchCardHedgeMatchedCohort } from "../playerTrend/cardHedgeMatchedCohortProvider.js";
import {
  readMatchedCohortFromCache,
  writeMatchedCohortToCache,
} from "../playerTrend/matchedCohortCache.js";
// CF-PARALLEL-TIER-TREND (2026-07-05): third-tier trajectory fallback
// for cards where matched-cohort is genuinely unavailable (long-tail
// prospects, thin CH history). Computes tier-level momentum across all
// cards in the same (year, set, parallel) cohort. Structurally
// mix-bias-free because the tier definition IS the compositional guard.
import {
  getParallelTierTrend,
  type ParallelTierKey,
} from "../playerTrend/parallelTierTrend.service.js";
export type { ParallelTierKey } from "../playerTrend/parallelTierTrend.service.js";
// CF-RELEASE-DECAY-PRIOR (2026-07-05, Drew): product-lifecycle prior
// for cards <8 weeks post-release. Bends the rate toward baseline
// decay so a launch-week hype spike doesn't get projected forward as
// continued upside. Blends to matched-cohort by week 8.
import {
  getReleaseDecayForCard,
  getReleaseDecayForCardAsync,
} from "./releaseDecayPrior.service.js";
// CF-ACTION-RECOMMENDATION (2026-07-05, Drew): the product surface.
// Consumes trajectory outputs + confidence + release-age context and
// emits a SELL_NOW / HOLD / LIST verdict per grade entry. iOS reads
// this to render the actionable badge next to each grade pill.
import {
  computeAction,
  type ActionRecommendation,
} from "./actionRecommendation.service.js";
// CF-SIBLING-WIDER-TRIGGER (2026-07-07, Drew): shared print-run
// inference so the sibling-fallback trigger can gate on
// "is this a rare parallel?" without duplicating the parallel-name
// mapping.
import { inferPrintRun as inferPrintRunForParallel } from "./parallelPremiumFloors.js";

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
  // CF-EIGHT-TIER-GRADES (2026-07-06, Drew): PSA 8 (and BGS/SGC/CGC 8)
  // are meaningful grades on autographs — many autos land as 8s due to
  // centering / auto-quality issues. Users need pricing at this tier
  // for cards they own. Multiplier ≈ 1.75× Raw for autos (55-65% of
  // PSA 9). Adds 4 CH fetches per card × 12h cache — bounded.
  { label: "PSA 8", grader: "PSA", psaEquivalent: 8 },
  // BGS 10 is the "Pristine 10" — a rarer tier above PSA 10 in most markets.
  // BGS 9.5 is the workhorse gem-mint BGS grade.
  { label: "BGS 10", grader: "BGS", psaEquivalent: 10 },
  { label: "BGS 9.5", grader: "BGS", psaEquivalent: 9.5 },
  { label: "BGS 9", grader: "BGS", psaEquivalent: 9 },
  { label: "BGS 8", grader: "BGS", psaEquivalent: 8 },
  { label: "SGC 10", grader: "SGC", psaEquivalent: 10 },
  { label: "SGC 9", grader: "SGC", psaEquivalent: 9 },
  { label: "SGC 8", grader: "SGC", psaEquivalent: 8 },
  { label: "CGC 10", grader: "CGC", psaEquivalent: 10 },
  { label: "CGC 9", grader: "CGC", psaEquivalent: 9 },
  { label: "CGC 8", grader: "CGC", psaEquivalent: 8 },
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
   *  Raw observed median. Null when the estimate came from a reference
   *  price rather than a Raw × multiplier calculation. */
  estimatedMultiplier: number | null;
  /** CF-BETTER-ESTIMATED-GRADE-MATH (2026-07-05): when valueSource
   *  === "estimated", identifies WHICH fallback source produced the
   *  number. Enables (a) iOS to render more informative "est." labels
   *  and (b) the corpus to measure which estimation method is most
   *  accurate over time.
   *    "reference-price"  — third-party model estimate at this grade
   *                          (preferred; usually a real observation of
   *                           broader eBay data than our filter sees)
   *    "raw-multiplier"   — Raw observed × hand-tuned tier constant
   *                          (last-resort fallback when reference
   *                           price is also unavailable)
   *  Null for observed / unavailable entries. */
  estimatedFrom: "reference-price" | "raw-multiplier" | "sibling-card" | null;
  /** CF-ONE-TRAJECTORY (2026-07-04): fields that put Last Sale, Market
   *  Value, and Predicted on ONE trend line — the SAME per-week rate
   *  derives all three. Prevents the "$100 Market Value but $205
   *  Predicted" incoherence users saw before this change.
   *
   *   value              — Last observed sale (past anchor)
   *   trendAdjustedValue — Market Value TODAY  (value × trend to t=now)
   *   predictedPriceAt30d — Predicted at t=+30d (trend continued 30 more days)
   *
   *  All bounded to a max ±10% per week and a max look-back of 6 weeks
   *  from the last sale, so a hot player's momentum can't runaway-multiply
   *  an old comp.
   */
  daysSinceNewestSale: number | null;
  /** CF-RECENCY-LIFT (2026-07-05): price of the single newest closed sale
   *  (by date). Distinct from `weightedMedianPrice` which smooths across
   *  the pool. When the newest sale is meaningfully above the smoothed
   *  median AND still fresh, trajectory anchors on a blend of the two so
   *  Predicted catches upswings faster instead of lagging behind the
   *  freshest datapoint. Null when no dated sales exist for this grade. */
  newestSalePrice: number | null;
  /** Market Value TODAY. Value observed at the last sale × trend since.
   *  Null when the sale is fresh (<14d) or no momentum signal is
   *  available — iOS should render `value` as-is in those cases. */
  trendAdjustedValue: number | null;
  /** Percentage change from `value` (past) to `trendAdjustedValue`
   *  (today). Positive = trending up. Nullable when trendAdjustedValue
   *  is null. */
  trendAdjustmentPct: number | null;
  /** Predicted price 30 days FROM TODAY (t = +30d beyond Market Value).
   *  Computed from the SAME rate as trendAdjustedValue — extends the
   *  trend line 30 more days forward. Null when we couldn't compute a
   *  trajectory (no momentum signal). */
  predictedPriceAt30d: number | null;
  /** Percentage change from `trendAdjustedValue` (today) to
   *  `predictedPriceAt30d` (30d out). Positive = expected to rise. */
  predictedPricePct: number | null;
  /** Confidence range on the Predicted number: ±15% band around
   *  predictedPriceAt30d. Null when predictedPriceAt30d is null. */
  predictedPriceRangeLow: number | null;
  predictedPriceRangeHigh: number | null;
  /** CF-7D-HORIZON (2026-07-06): the actual horizon this projection
   *  covers, in days. Shortened from 30 → 7 so the projected numbers
   *  read as digestible short-term signals rather than compounded
   *  long-term forecasts. iOS reads this to render the correct label
   *  ("Predicted (7d)"). Legacy field `predictedPriceAt30d` still
   *  carries the projected price for wire backward-compat. */
  predictedHorizonDays: number;
  /** CF-ACTION-RECOMMENDATION (2026-07-05): the seller-facing verdict
   *  for this grade. Always emitted (INSUFFICIENT_DATA when the
   *  trajectory pipeline couldn't derive a directional signal). iOS
   *  reads this to render the actionable badge and price hint next to
   *  each grade pill. Null when valueSource === "unavailable" (no
   *  point recommending on a nonexistent value). */
  recommendation: ActionRecommendation | null;
  /** CF-SALES-HISTORY-CHART (2026-07-05): raw sales pool for this grade.
   *  Each entry is one closed sale — { price, date, saleType }. iOS
   *  renders these as a scatter (price vs date) so users can see the
   *  data behind the weighted median. Ordered newest → oldest. Empty
   *  array when the pool is empty; iOS renders nothing in that case. */
  salesHistory: Array<{
    price: number;
    date: string | null;
    saleType: string | null;
  }>;
  /** CF-REFERENCE-PRICE-CROSS-CHECK (2026-07-05): third-party model
   *  estimate for this grade (from CH's all-prices-by-card). Null when
   *  the caller didn't provide a reference price map OR this grade has
   *  no reference. */
  referencePrice: number | null;
  /** Percentage divergence between OUR `value` and the third-party
   *  `referencePrice`. Positive = our number is higher than reference.
   *  Null when either input is missing. */
  referenceDivergencePct: number | null;
  /** True when |referenceDivergencePct| > 25% — big mismatch worth
   *  flagging to the seller. */
  referenceAnomaly: boolean;
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
  /** CF-CORPUS-TRAJECTORY-FIELDS (2026-07-05): the momentum rate that
   *  drove all per-grade trajectory calculations. Surfaced on the curve
   *  itself (not just individual entries) so callers can persist it to
   *  the corpus for calibration analysis. Null when trajectory skipped. */
  ratePerWeek: number | null;
  signalSource:
    | "matched-cohort-cached"
    | "matched-cohort-on-demand"
    | "parallel-tier"
    | "release-decay-blend"
    | "release-decay-only"
    | "raw-weekly"
    | null;
  /** CF-SIBLING-LINEAGE-SURFACE (2026-07-07, Drew): when the sibling
   *  fallback drove any entry's `value`, this block surfaces the
   *  lineage so iOS can render a "Est via Base Auto × 15× Orange floor"
   *  provenance badge, and so ops can eyeball the price derivation
   *  without KQL round-tripping. Null when no sibling fallback fired
   *  (either the target had real comps, fallback was disabled, or
   *  fallback bailed out at any step). */
  siblingFallback: {
    /** Sibling card ID we anchored on. */
    siblingCardId: string;
    /** Sibling's variant label (usually "Base"; "Base" for cross-class
     *  fallback since the sibling IS a Base card in that case). */
    siblingParallel: string;
    /** Sibling's weighted median at Raw BEFORE trend-projection. */
    siblingBaseMedianRaw: number;
    /** Sibling's median projected forward to today via the target's
     *  trajectory rate (matched-cohort / parallel-tier / release-decay).
     *  Same as siblingBaseMedianRaw when no trajectory rate was
     *  available. */
    siblingBaseProjectedToday: number;
    /** Weeks between the sibling's newest closed sale and today. */
    siblingWeeksSinceNewestSale: number | null;
    /** Effective parallel-premium multiplier applied at the target's
     *  print-run tier. This is `max(empiricalPremium, printRunFloor)`
     *  when the parallel matches a hobby-consensus floor. */
    parallelPremium: number;
    /** The empirical (median-of-medians) premium from the calibration
     *  table BEFORE floor lift. Same as parallelPremium when no floor
     *  applied. Useful for KQL: `parallelPremium != empiricalPremium`
     *  = floor overrode the empirical value. */
    empiricalPremium: number;
    /** True when the print-run floor lifted the empirical value. */
    floorApplied: boolean;
    /** Inferred print run for the target parallel (25 for Orange, 50
     *  for Gold, etc.). Null when the parallel doesn't match any
     *  known hobby-consensus tier. */
    inferredPrintRun: number | null;
    /** Set from the parallel-premiums table row that matched (may be
     *  the same-set exact hit OR the Bowman Chrome Prospects proxy). */
    premiumMatchedSet: string;
    /** True when we fell through to the Bowman Chrome Prospects proxy
     *  because no same-set entry existed. */
    premiumUsedProxy: boolean;
    /** CF-SIBLING-BASE-CARD-FALLBACK (PR #305): true when the target
     *  is an auto but we anchored on a Base card (non-auto) because no
     *  Base Auto SKU existed for the player in this set. In that case
     *  `crossClassAutoPremium` was applied at the pre-parallel anchor. */
    siblingIsCrossClass: boolean;
    /** Bridge multiplier from Base card → Base Auto anchor (10× hobby-
     *  consensus). Null when siblingIsCrossClass is false. */
    crossClassAutoPremium: number | null;
  } | null;
}

/**
 * The SINGLE swap point when we transition from CH to eBay Browse.
 * Everything else in this module is vendor-agnostic.
 *
 * When eBay Browse is wired: replace the body with the eBay call,
 * keep the return shape identical. Callers keep working unchanged.
 */
/**
 * CF-FILTER-IP-TTM-AUTOS (2026-07-05): reject sales whose title flags
 * them as "in-person" / "TTM" / "hand-signed" fan-obtained autographs.
 *
 * These are NOT manufacturer-authenticated. They typically trade at
 * 30-50% of a certified card's price and contaminate the median for
 * authenticated autos. Drew's directive: "we need to add the removal
 * of comps from IP and In person — these are cheaper autos that are
 * not authenticated by the card manufacturer."
 *
 * Patterns tuned to reject strongly-worded IP/TTM listings without
 * false-positiving on random "IP" substrings. Each pattern requires
 * IP/IPA/TTM to be adjacent to an "auto" / "autograph" / "signature"
 * / "signed" token, OR be the more-specific IPA/TTM acronym anchored
 * at word boundaries.
 */
const IP_TTM_TITLE_REJECT_PATTERNS: RegExp[] = [
  /\bin[-\s.]?person\b.*\b(auto|autograph|signature|signed|sig)\b/i,
  /\b(auto|autograph|signature|signed|sig)\b.*\bin[-\s.]?person\b/i,
  /\bIP\s*(auto|autograph|signature|signed|sig)\b/i,
  /\b(auto|autograph|signature|signed|sig)\s*IP\b/i,
  /\bIPA\b/i,                         // "IPA" — specific enough to stand alone
  /\bTTM\b/i,                         // "through the mail"
  /\bthrough[-\s]the[-\s]mail\b/i,
  /\bhand[-\s]?signed\b/i,
  /\bfan[-\s]?signed\b/i,
];

/**
 * Returns true when the sale title matches an IP/TTM/hand-signed
 * pattern and should be excluded from the observed median. Null or
 * empty titles are NOT rejected — we can't tell what they are, so
 * we err on inclusion (preserves pre-fix behavior for the untitled
 * subset of CH's comps).
 */
function shouldRejectSaleTitle(title: string | null): boolean {
  if (!title) return false;
  for (const re of IP_TTM_TITLE_REJECT_PATTERNS) {
    if (re.test(title)) return true;
  }
  return false;
}

async function fetchRawSalesForGrade(
  cardId: string,
  grade: string,
): Promise<Array<{ price: number; date: string | null; saleType: string | null }>> {
  const sales = await getCardSales(cardId, grade, 50);
  const rejected: string[] = [];
  const kept = sales.filter((s) => {
    if (shouldRejectSaleTitle(s.title)) {
      rejected.push(s.title ?? "");
      return false;
    }
    return true;
  });
  if (rejected.length > 0) {
    // Observability — count of drops per (cardId, grade). Useful for
    // measuring how often CH's aggregation is picking up IP contamination.
    console.log(JSON.stringify({
      event: "ip_ttm_sales_filtered",
      source: "observedGradeCurve",
      cardId,
      grade,
      keptCount: kept.length,
      rejectedCount: rejected.length,
      // First 3 sample titles for spot-checking (truncated).
      sampleRejected: rejected.slice(0, 3).map((t) => t.slice(0, 100)),
    }));
  }
  return kept
    .map((s) => ({
      price: typeof s.price === "number" ? s.price : parseFloat(String(s.price)),
      date: s.date ?? null,
      // CF-BIN-VS-AUCTION-WEIGHT (2026-07-05): thread sale_type through
      // so computeWeightedMedian can boost BIN samples' weight.
      saleType: s.sale_type ?? null,
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

// CF-CONFIDENCE-RECALIBRATION (2026-07-05, Drew): tighter curve for
// thin samples. Pre-CF, 3 sales landed at 0.50 (renders as 3 out of 5
// filled dots on iOS) — same as 4 sales, and same visual weight as
// something with 5-9 sales. That overstates certainty on cards with
// tiny comp pools. New curve pushes each sample-count into its own
// dot bucket (5-dot iOS display) so users can distinguish "3 sales
// worth of confidence" from "10 sales worth of confidence."
//
// iOS 5-dot mapping (threshold-based):
//    ≤ 0.20 → 1 dot   ("very thin — treat as directional signal")
//    ≤ 0.40 → 2 dots  ("thin — pool needs more data")
//    ≤ 0.60 → 3 dots  ("moderate — actionable but expect variance")
//    ≤ 0.80 → 4 dots  ("solid — pool is representative")
//    ≤ 1.00 → 5 dots  ("dense — high confidence")
function computeConfidence(sampleCount: number, newestDate: string | null): number {
  let base: number;
  if (sampleCount === 0) return 0;
  if (sampleCount === 1) base = 0.15;
  else if (sampleCount === 2) base = 0.25;
  else if (sampleCount === 3) base = 0.35;
  else if (sampleCount === 4) base = 0.45;
  else if (sampleCount <= 9) base = 0.65;
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
    sales.map((s) => ({ price: s.price, date: s.date, saleType: s.saleType })),
  );
  const plain = computePlainMedian(prices);
  const low = computePercentile(prices, 0.10);
  const high = computePercentile(prices, 0.90);
  const newest = dates.length ? dates[dates.length - 1] : null;
  const oldest = dates.length ? dates[0] : null;
  // CF-RECENCY-LIFT (2026-07-05): find the price of the single newest
  // sale (by date). Sort a lightweight { price, date } view of sales,
  // then take the tail. Kept separate from `weighted` because the two
  // answer different questions — weighted median is the pool's smoothed
  // center; newestSalePrice is the freshest datapoint.
  const salesWithDates = sales.filter(
    (s): s is { price: number; date: string; saleType: string | null } =>
      typeof s.date === "string" && s.date.length > 0,
  );
  salesWithDates.sort((a, b) => a.date.localeCompare(b.date));
  const newestSalePrice =
    salesWithDates.length > 0 ? salesWithDates[salesWithDates.length - 1].price : null;

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
    estimatedFrom: null,
    daysSinceNewestSale:
      newest !== null
        ? Math.floor((Date.now() - Date.parse(newest)) / (24 * 3600 * 1000))
        : null,
    newestSalePrice,
    trendAdjustedValue: null,       // filled by applyTrajectory below
    trendAdjustmentPct: null,
    predictedPriceAt30d: null,
    predictedPricePct: null,
    predictedPriceRangeLow: null,
    predictedPriceRangeHigh: null,
    predictedHorizonDays: PREDICTED_HORIZON_DAYS,
    recommendation: null,           // filled by applyTrajectory below
    // CF-SALES-HISTORY-CHART (2026-07-05): raw pool for iOS scatter render.
    salesHistory: sales
      .slice()
      .sort((a, b) => {
        const at = a.date ? Date.parse(a.date) : 0;
        const bt = b.date ? Date.parse(b.date) : 0;
        return bt - at;
      })
      .map((s) => ({ price: s.price, date: s.date, saleType: s.saleType })),
    // CF-REFERENCE-PRICE-CROSS-CHECK (2026-07-05): filled below.
    referencePrice: null,
    referenceDivergencePct: null,
    referenceAnomaly: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-ONE-TRAJECTORY (2026-07-04): trajectory math for Market Value + Predicted
//
// The problem this closes: earlier iterations had two DIFFERENT momentum
// signals — one for trend-adjusted "today" (bucket ratio) and another for
// engine's predictedPrice (trendIQ composite). Users saw incoherent
// panels: Market Value $100, Predicted $205 — a 105% jump with no
// intermediate step.
//
// Fix: derive ONE rate parameter from CH weekly avg-sale buckets, then
// compute BOTH Market Value AND Predicted from the same rate. Last Sale
// → Market Value (today) → Predicted (30d) sit on a single line.
//
// Model: linear extrapolation with hard caps.
//   rate = (latest_week_avg / prior_4wk_mean) - 1     -- weekly change
//        capped to [-0.10, +0.10]                     -- ±10% weekly
//   weeksSinceSale = clamp(daysSinceNewest / 7, 0, 6) -- max 6-wk look-back
//
//   Market Value = observed × (1 + rate × weeksSinceSale)
//   Predicted    = Market Value × (1 + rate × 30/7)
//
// Combined caps prevent runaway: even at max rate (+10%/wk) over max 6 weeks,
// Market Value tops at 1.6× observed; Predicted at 1.6 × 1.43 = 2.28× observed.
// ─────────────────────────────────────────────────────────────────────────────

// CF-USE-ACTUALS-NO-CAP (2026-07-05, Drew): the ±10%/wk rate clamp was
// removed. It was suppressing genuine hot moves — a top prospect
// legitimately trading up +20%/wk got compressed to +10%/wk, so
// Predicted came in below live bids. See deriveWeeklyRate() for the
// full rationale + extreme-rate warning telemetry.
/** Maximum weeks look-back — trends beyond 6 weeks aren't reliable enough
 *  to linearly extrapolate. A 6-month-old comp on a hot player gets treated
 *  as-if 6 weeks old for trajectory purposes. */
const MAX_WEEKS_LOOKBACK = 6;
/** Predicted horizon — 7 days forward from today. Shortened 2026-07-06
 *  from 30 → 7 (Drew: "the numbers are too big"). Over 30 days the
 *  compounded rate produced projections that were psychologically
 *  intimidating to sellers — a +10%/wk rate showed as +43% projected,
 *  which looked like model overreach even when statistically sound.
 *  A 7-day horizon shows the SAME +10%/wk rate as a much more
 *  digestible +10% projection. Same underlying math, more usable
 *  surface.
 *
 *  The wire field is still named `predictedPriceAt30d` for backward
 *  compatibility — iOS reads that key. A new `predictedHorizonDays`
 *  field carries the actual horizon so iOS can render the correct
 *  label ("Predicted (7d)" instead of "Predicted (30d)"). */
const PREDICTED_HORIZON_DAYS = 7;
/** Confidence band on Predicted — ±8% around the point estimate for
 *  observed values. Scaled down from ±15% (pre-2026-07-06) because a
 *  7-day horizon has ~4× less compounded uncertainty than a 30-day
 *  horizon. Bands too wide undermine the point-estimate's usefulness. */
const PREDICTED_RANGE_PCT = 0.08;
/** Wider band when the underlying value is ESTIMATED (reference-price
 *  or raw-multiplier). Predicting an estimate forward compounds
 *  uncertainty; a wider range signals that honesty visually. Scaled
 *  from ±25% → ±15% for the 7-day horizon. */
const ESTIMATED_PREDICTED_RANGE_PCT = 0.15;
/** Minimum days since sale before we apply trajectory — a fresh comp
 *  doesn't need adjustment (would just add noise from partial weeks). */
const FRESH_COMP_THRESHOLD_DAYS = 14;
/** CF-PARALLEL-TIER-FRESHNESS (2026-07-05, Drew): parallel-tier signal
 *  is only trustworthy when the tier has genuinely recent activity.
 *  If the latest same-tier sale is older than this threshold, the
 *  tier is stale and we discard the signal (fall through to null
 *  rather than extrapolating from cold data). Drew's rule 2026-07-05:
 *  "if like parallels sell very recently that's fine, but if it is
 *  over 4 weeks ago, they become stale". */
const PARALLEL_TIER_MAX_STALENESS_DAYS = 28;

// ─── CF-RECENCY-LIFT (2026-07-05) — same-card recent comp anchor ─────────────
// The problem: `weightedMedianPrice` smooths across the sale pool. If the
// single newest closed sale is meaningfully ABOVE the smoothed median, the
// smoothing lags the true recent direction — Predicted comes in below
// active-listing bids because our anchor is stuck in the smoothed past.
//
// Solution: when the newest closed sale is above the smoothed median by
// more than MIN_LIFT_GAP AND is still within LIFT_MAX_STALENESS_DAYS, lift
// the trajectory anchor toward the newest datapoint. Age-weighted so a
// 3-day-old sale lifts more than a 20-day-old one.
//
// This is a SAME-CARD signal (Drew's "direct comp trends") — it captures
// recent direction of the card itself, not the player or tier. Complements
// matched-cohort (Drew's "player market direction via cardId-matched"),
// which stays the primary rate source.
/** Minimum gap between newest sale and weighted median before lift fires.
 *  Below 15% we treat the difference as pool noise, not a signal. */
const RECENCY_LIFT_MIN_GAP = 0.15;
/** Newest-sale age (days) beyond which lift stops firing. Age-linear decay
 *  from 0d (full lift weight) to LIFT_MAX_STALENESS_DAYS (zero weight). */
const RECENCY_LIFT_MAX_STALENESS_DAYS = 21;
/** Damping factor: the anchor meets the newest at this fraction of the
 *  age-weighted gap. 0.6 = "move 60% of the age-weighted distance from
 *  smoothed median toward newest sale". Prevents over-anchoring on a
 *  single potentially-outlier datapoint. */
const RECENCY_LIFT_DAMPEN = 0.6;

/**
 * CF-RECENCY-LIFT (2026-07-05, Drew): compute the trajectory anchor that
 * should feed Market Value + Predicted, given the smoothed median and the
 * single newest closed sale. Returns the SAME value as `observedValue`
 * when no lift is warranted — so callers can use the result unconditionally.
 */
interface RecencyLiftResult {
  anchor: number;
  lifted: boolean;
  liftPct: number;
}
function computeRecencyLiftedAnchor(
  observedValue: number,
  newestSalePrice: number | null,
  daysSinceNewestSale: number | null,
): RecencyLiftResult {
  if (
    !newestSalePrice ||
    newestSalePrice <= 0 ||
    observedValue <= 0 ||
    daysSinceNewestSale === null ||
    daysSinceNewestSale < 0 ||
    daysSinceNewestSale >= RECENCY_LIFT_MAX_STALENESS_DAYS
  ) {
    return { anchor: observedValue, lifted: false, liftPct: 0 };
  }
  const gap = newestSalePrice / observedValue - 1;
  if (gap < RECENCY_LIFT_MIN_GAP) {
    return { anchor: observedValue, lifted: false, liftPct: 0 };
  }
  const recencyWeight = Math.max(
    0,
    1 - daysSinceNewestSale / RECENCY_LIFT_MAX_STALENESS_DAYS,
  );
  const alpha = RECENCY_LIFT_DAMPEN * recencyWeight;
  const anchor = observedValue * (1 - alpha) + newestSalePrice * alpha;
  const rounded = Math.round(anchor * 100) / 100;
  const liftPct = Math.round(((rounded / observedValue) - 1) * 10000) / 100;
  return { anchor: rounded, lifted: true, liftPct };
}

/**
 * Derive a bounded per-week rate from the player trend snapshot.
 *
 * Signal preference (per project memory
 * "project_matched_cohort_supersedes_raw"):
 *   1. matchedCohort.medianRatio (cached) — mix-bias-free per-card
 *      ratio, the SUPERIOR signal. Compares each card that sold in
 *      both the latest week AND the prior 4-week window, then medians
 *      the per-card ratios. A player like Adamczewski whose mix swings
 *      wildly (base auto at $50, Superfractor at $1500) gets clean
 *      signal here — the Superfractor selling in one week doesn't
 *      distort the trajectory.
 *   2. matchedCohort computed on-demand + cached — same math, run
 *      inline for players the overnight job missed.
 *   3. null — skip trajectory; observed value is honest.
 *
 * NOTE (2026-07-05, CF-KILL-RAW-WEEKLY): the raw-weekly fallback
 * (momentum.momentumRatio) was REMOVED as a trajectory source.
 * Raw weekly avg-sale is fatally mix-biased for prospects — the same
 * class of bug that produced Adamczewski $40 (fixed 2026-07-04 by
 * matched-cohort swap) came back on Roldy Brito Blue X-Fractor: the
 * cap fired at -10%/week, stamping a false -43%/30d Predicted on a
 * thin-sample card. When matched-cohort is unavailable we now emit
 * NO trajectory — Market Value falls back to `value`, Predicted stays
 * null, and iOS hides the projection. Honest over speculative.
 *
 * The "raw-weekly" signalSource literal is preserved in the union
 * type for corpus-doc backward compatibility (historical persisted
 * entries), but is no longer emitted.
 *
 * Bounded to ±10%/week regardless of source.
 */
export interface RateDerivation {
  cappedRate: number;
  signalSource:
    | "matched-cohort-cached"
    | "matched-cohort-on-demand"
    | "parallel-tier"
    | "release-decay-blend"
    | "release-decay-only"
    | "raw-weekly";
}

/**
 * CF-MANUAL-IDENTITY-PRICING (2026-07-07, Drew): exported so the
 * synthetic-identity route (POST /price-manual-identity) can drive the
 * SAME trajectory-rate derivation as the CH-cardId path. Signature is
 * intentionally identical to the internal callsite; new callers should
 * pass releaseDecayPrecomputed = null unless they've already looked it
 * up (releaseCardKey lookup is idempotent per year+set within 24h).
 */
export async function deriveWeeklyRate(
  playerName: string,
  parallelTierKey: ParallelTierKey | null,
  /** CF-RELEASE-DECAY-PRIOR (2026-07-05, Drew): year + set for the
   *  target card so we can check whether it's inside the 8-week
   *  post-release window and apply a decay-rate prior. Both derivable
   *  from parallelTierKey when present, or supplied independently. */
  releaseCardKey: { year: number | string; set: string } | null,
  /** CF-RELEASE-AUTO-DETECT (2026-07-05): pre-computed release-decay
   *  context passed down from applyTrajectory so we don't do the same
   *  (possibly async, additions-summary-backed) lookup twice. */
  releaseDecayPrecomputed: ReturnType<typeof getReleaseDecayForCard>,
): Promise<RateDerivation | null> {
  let snapshot;
  try {
    snapshot = await getPlayerTrendSnapshot(playerName, 5);
  } catch {
    snapshot = null;
  }

  let rawRate: number | null = null;
  let signalSource: RateDerivation["signalSource"] | null = null;
  let cohortSize: number | null = null;

  // Prefer matched-cohort medianRatio when the pre-computed cache has it.
  if (
    snapshot?.matchedCohort &&
    Number.isFinite(snapshot.matchedCohort.medianRatio) &&
    snapshot.matchedCohort.cohortSize >= 2
  ) {
    rawRate = snapshot.matchedCohort.medianRatio - 1;
    signalSource = "matched-cohort-cached";
    cohortSize = snapshot.matchedCohort.cohortSize;
  } else if (snapshot) {
    // Cache miss — compute matched-cohort on-demand. Cost is ~30 CH
    // calls (one prices-by-card per card); result cached 24h so the
    // next request skips the compute. Silently fails on any error —
    // trajectory falls through to parallel-tier or null.
    const onDemand = await tryMatchedCohortOnDemand(playerName);
    if (
      onDemand &&
      Number.isFinite(onDemand.medianRatio ?? NaN) &&
      onDemand.cohort.length >= 2
    ) {
      rawRate = (onDemand.medianRatio as number) - 1;
      signalSource = "matched-cohort-on-demand";
      cohortSize = onDemand.cohort.length;
    }
    // Intentionally no `else if raw-weekly` — Brito Blue X-Fractor bug.
  }
  // CF-PARALLEL-TIER-TREND (2026-07-05): third fallback for long-tail
  // players whose CH matched-cohort can't be built. Uses the SAME
  // matched-cohort math but at the TIER level — compares Blue X-Fractor
  // /150 autos to other Blue X-Fractor /150 autos. Drew's directive:
  // "why wouldn't we look at the overall card market and match like
  // cards to find the trends?" Structural mix-bias-freeness because
  // the tier definition IS the compositional guard.
  //
  // Freshness gate (Drew, 2026-07-05): only trust the tier signal when
  // its latest sale is within PARALLEL_TIER_MAX_STALENESS_DAYS. A tier
  // whose most recent activity is 6 weeks old is extrapolating from
  // cold data — better to emit no signal than a stale one.
  if (rawRate === null && parallelTierKey) {
    const tierTrend = await getParallelTierTrend(parallelTierKey).catch(() => null);
    if (
      tierTrend &&
      Number.isFinite(tierTrend.medianRatio ?? NaN) &&
      tierTrend.cohort.length >= 2
    ) {
      // latestWeekEnd is an ISO date; parse safely (fallback to 0 → stale)
      const latestMs = Date.parse(tierTrend.latestWeekEnd ?? "");
      const nowMs = Date.now();
      const staleDays = Number.isFinite(latestMs)
        ? (nowMs - latestMs) / (24 * 3600 * 1000)
        : Infinity;
      if (staleDays <= PARALLEL_TIER_MAX_STALENESS_DAYS) {
        rawRate = (tierTrend.medianRatio as number) - 1;
        signalSource = "parallel-tier";
        cohortSize = tierTrend.cohort.length;
      } else {
        console.log(JSON.stringify({
          event: "parallel_tier_trend_stale",
          source: "observedGradeCurve",
          player: playerName,
          latestWeekEnd: tierTrend.latestWeekEnd,
          staleDays: Math.round(staleDays),
          threshold: PARALLEL_TIER_MAX_STALENESS_DAYS,
        }));
      }
    }
  }

  // CF-RELEASE-DECAY-PRIOR (2026-07-05, Drew): for cards <8 weeks
  // post-release, blend a decay prior into the rate. The prior encodes
  // "new releases drop from launch premium to baseline over ~8 weeks."
  // Applied AFTER matched-cohort / parallel-tier so the blend uses
  // whichever trend signal was available (or falls back to pure decay
  // when neither exists — this is a real coverage improvement for
  // brand-new-release long-tail players).
  const releaseDecay = releaseDecayPrecomputed;
  if (releaseDecay) {
    if (rawRate !== null && signalSource !== null) {
      // Blend: finalRate = decay × blend + trend × (1 - blend)
      const blended =
        releaseDecay.decayRatePerWeek * releaseDecay.blend +
        rawRate * (1 - releaseDecay.blend);
      console.log(JSON.stringify({
        event: "release_decay_applied",
        source: "observedGradeCurve",
        player: playerName,
        matchedKey: releaseDecay.matchedKey,
        weeksSinceRelease: releaseDecay.weeksSinceRelease,
        decayRatePerWeek: releaseDecay.decayRatePerWeek,
        blend: releaseDecay.blend,
        preBlendTrendRate: Math.round(rawRate * 10000) / 100,
        preBlendTrendSignal: signalSource,
        blendedRate: Math.round(blended * 10000) / 100,
      }));
      rawRate = blended;
      signalSource = "release-decay-blend";
    } else {
      // No matched-cohort AND no parallel-tier — use pure decay signal.
      // This is coverage we didn't have before: a brand-new-release
      // long-tail player (no matched-cohort, tier not yet fresh enough)
      // now gets a defensible baseline-decay Predicted instead of null.
      console.log(JSON.stringify({
        event: "release_decay_applied",
        source: "observedGradeCurve",
        player: playerName,
        matchedKey: releaseDecay.matchedKey,
        weeksSinceRelease: releaseDecay.weeksSinceRelease,
        decayRatePerWeek: releaseDecay.decayRatePerWeek,
        blend: 1.0,
        preBlendTrendRate: null,
        preBlendTrendSignal: null,
        blendedRate: Math.round(releaseDecay.decayRatePerWeek * 10000) / 100,
      }));
      rawRate = releaseDecay.decayRatePerWeek;
      signalSource = "release-decay-only";
    }
  }

  if (rawRate === null || signalSource === null) {
    // Observability: log the miss so ops can see coverage gaps in
    // matched-cohort AND parallel-tier AND release-decay and prioritize
    // backfill (release-date table entries, matched-cohort coverage).
    console.log(JSON.stringify({
      event: "trajectory_rate_no_signal",
      source: "observedGradeCurve",
      player: playerName,
      hadParallelTierKey: !!parallelTierKey,
      hadReleaseCardKey: !!releaseCardKey,
      reason: "no matched-cohort AND no parallel-tier AND no release-decay",
    }));
    return null;
  }

  // CF-USE-ACTUALS-NO-CAP (2026-07-05, Drew): "let's make it actuals and
  // not clip it." Previously we clamped the rate to ±RATE_CAP_PER_WEEK
  // to guard against a single crazy CH bucket blowing up projections.
  // The clamp was suppressing genuine hot moves — a top prospect
  // legitimately trading up +20%/wk got compressed to +10%/wk, so
  // Predicted came in below live bids. Trust the matched-cohort signal
  // as-is (medianRatio is robust — median of per-card ratios across a
  // cohort of ≥2, so a single outlier can't dominate).
  //
  // Guardrails still in place downstream:
  //   • MAX_WEEKS_LOOKBACK caps how many weeks we extrapolate over
  //   • The rate itself is bounded by market realism (medianRatio ≤ 2
  //     empirically implies rate ≤ 1.0 = 100%/wk, which IS possible
  //     for a prospect on a hype spike)
  //
  // Extreme-rate warning telemetry — logs but does NOT clip. Ops can
  // KQL for `rate_extreme` to spot pathological CH signals and decide
  // whether a soft floor/ceiling is needed later.
  if (Math.abs(rawRate) > 0.25) {
    console.warn(JSON.stringify({
      event: "trajectory_rate_extreme",
      source: "observedGradeCurve",
      player: playerName,
      signal: signalSource,
      rateWeekly: Math.round(rawRate * 10000) / 100,
      cohortSize,
      note: "not clipped — CF-USE-ACTUALS-NO-CAP 2026-07-05",
    }));
  }

  // Observability: log which signal drove the trajectory.
  //   matched-cohort-cached   → the overnight job covered this player
  //   matched-cohort-on-demand → we computed inline (cache was cold)
  //   parallel-tier            → tier-level fallback (fresh only)
  console.log(JSON.stringify({
    event: "trajectory_rate_derived",
    source: "observedGradeCurve",
    player: playerName,
    signal: signalSource,
    rateWeekly: Math.round(rawRate * 10000) / 100,
    cohortSize,
  }));

  return { cappedRate: rawRate, signalSource };
}

/**
 * On-demand matched-cohort compute + write-back to cache. Fires only
 * when the pre-populated cache misses. Silent no-throw — returns null
 * on any error, caller falls through to raw signal.
 *
 * The write-back means the next 24h of requests for this player hit
 * the cache. Amortized cost per player per day: one ~30-call fanout,
 * spread across whichever user first opens a card for that player.
 */
async function tryMatchedCohortOnDemand(playerName: string): Promise<
  { medianRatio: number | null; cohort: { cardId: string }[] } | null
> {
  try {
    // Guard: if the SAME request already computed matched-cohort earlier
    // in this process, use it. cardHedgePlayerTrendProvider does the same
    // cache read; when it returned null we know the cache is truly empty.
    const guardCheck = await readMatchedCohortFromCache(playerName);
    if (guardCheck) return guardCheck.result;

    const result = await fetchCardHedgeMatchedCohort(playerName);
    if (!result) return null;

    // Write-back so subsequent requests skip the compute.
    void writeMatchedCohortToCache(playerName, result, "cardhedge").catch(() => {});
    return result;
  } catch (err) {
    console.warn(
      `[observedGradeCurve.matched-cohort-on-demand] ${playerName}: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Post-process trajectory pass. Two independent branches:
 *
 *   1. MARKET VALUE (trendAdjustedValue) — only fires when the last
 *      observed sale is > FRESH_COMP_THRESHOLD_DAYS old. A fresh sale
 *      IS the current market price; adjusting it just adds noise from
 *      partial-week momentum. Fresh entries keep value == market value
 *      (iOS falls back to `value` when trendAdjustedValue is null).
 *
 *   2. PREDICTED (predictedPriceAt30d) — ALWAYS fires when we have a
 *      rate signal, regardless of comp freshness. Drew's directive
 *      (2026-07-05): "we are predicting new market values so the next
 *      price, so yes" — the whole point is the forward projection.
 *      Anchors on the trend-adjusted market value when available, else
 *      on the observed value (fresh-comp path).
 */
async function applyTrajectory(
  entries: ObservedGradeEntry[],
  playerName: string | null,
  parallelTierKey: ParallelTierKey | null,
): Promise<RateDerivation | null> {
  // A playerName OR a parallelTierKey OR a release-decay-eligible card
  // can independently unlock trajectory now. Only bail when ALL three
  // signals are unavailable.
  const releaseCardKey =
    parallelTierKey && parallelTierKey.year && parallelTierKey.set
      ? { year: parallelTierKey.year, set: parallelTierKey.set }
      : null;
  // Look up release-decay context ONCE (idempotent) so both deriveWeeklyRate
  // (for the rate blend) AND computeAction below (for LIST-ahead-of-decay
  // verdict) share the same weeksSince. Use the async variant so long-tail
  // sets not in the hard-coded table get auto-detected via additions-summary.
  const releaseDecayContext = releaseCardKey
    ? await getReleaseDecayForCardAsync(releaseCardKey.year, releaseCardKey.set)
    : null;
  if (!playerName && !parallelTierKey && !releaseCardKey) return null;
  const derivation = await deriveWeeklyRate(
    playerName ?? "",
    parallelTierKey,
    releaseCardKey,
    releaseDecayContext,
  );
  if (derivation === null) return null;
  const rate = derivation.cappedRate;

  for (const entry of entries) {
    if (entry.value === null || entry.value <= 0) continue;
    // Skip "unavailable" — no anchor to project from.
    if (entry.valueSource === "unavailable") continue;

    // ── CF-RECENCY-LIFT (2026-07-05, Drew): compute lifted anchor first.
    //    For OBSERVED entries only — an estimated grade has no per-grade
    //    "newest sale" (its value came from Raw × multiplier or reference
    //    price), so there's nothing to lift toward. ────────────────────
    const liftResult: RecencyLiftResult =
      entry.valueSource === "observed"
        ? computeRecencyLiftedAnchor(
            entry.value,
            entry.newestSalePrice,
            entry.daysSinceNewestSale,
          )
        : { anchor: entry.value, lifted: false, liftPct: 0 };
    const anchorForTrajectory = liftResult.anchor;
    if (liftResult.lifted) {
      console.log(JSON.stringify({
        event: "predicted_anchor_lifted",
        source: "observedGradeCurve",
        grade: entry.grade,
        observedValue: entry.value,
        newestSalePrice: entry.newestSalePrice,
        daysSinceNewestSale: entry.daysSinceNewestSale,
        liftedAnchor: anchorForTrajectory,
        liftPct: liftResult.liftPct,
      }));
    }

    // ── Market Value adjustment — for OBSERVED entries with a stale
    //    sale (trend layered on top of lifted anchor). Estimated entries
    //    stay at their point estimate; layering a trend on an already-
    //    projected value would compound uncertainty. ──────────────────
    let marketValueForForwardAnchor: number = anchorForTrajectory;
    if (
      entry.valueSource === "observed" &&
      entry.daysSinceNewestSale !== null &&
      entry.daysSinceNewestSale >= FRESH_COMP_THRESHOLD_DAYS
    ) {
      const weeksSinceSale = Math.min(entry.daysSinceNewestSale / 7, MAX_WEEKS_LOOKBACK);
      const marketMultiplier = 1 + rate * weeksSinceSale;
      const trendAdjusted = Math.round(anchorForTrajectory * marketMultiplier * 100) / 100;
      entry.trendAdjustedValue = trendAdjusted;
      // trendAdjustmentPct is now measured against ORIGINAL value (pill),
      // not the lifted anchor — iOS shows Δ from the user-visible pill.
      entry.trendAdjustmentPct = Math.round(((trendAdjusted / entry.value) - 1) * 10000) / 100;
      marketValueForForwardAnchor = trendAdjusted;
    } else if (liftResult.lifted && entry.valueSource === "observed") {
      // Fresh-comp OR estimated-observed but with a lift: still emit
      // trendAdjustedValue so iOS renders the lifted number as Market
      // Value. Otherwise iOS would show the raw pill and hide the lift.
      entry.trendAdjustedValue = anchorForTrajectory;
      entry.trendAdjustmentPct = liftResult.liftPct;
    }
    // For observed-fresh-with-no-lift AND estimated: trendAdjustedValue
    // stays null; iOS renders entry.value as Market Value. Forward
    // projection below still fires when a rate exists.

    // ── Predicted branch — fires for observed AND estimated grades ──
    // Drew's rationale (2026-07-05): "if someone comes back with a 10
    // with no sales, they want us to help them with an accurate number
    // to sell for." Estimated grades still get a Predicted so the seller
    // has actionable guidance; the wider confidence band signals
    // uncertainty visually.
    const predictedMultiplier = 1 + rate * (PREDICTED_HORIZON_DAYS / 7);
    const predicted =
      Math.round(marketValueForForwardAnchor * predictedMultiplier * 100) / 100;
    const rangePct =
      entry.valueSource === "estimated"
        ? ESTIMATED_PREDICTED_RANGE_PCT
        : PREDICTED_RANGE_PCT;
    entry.predictedPriceAt30d = predicted;
    entry.predictedPricePct = Math.round((predictedMultiplier - 1) * 10000) / 100;
    entry.predictedPriceRangeLow = Math.round(predicted * (1 - rangePct) * 100) / 100;
    entry.predictedPriceRangeHigh = Math.round(predicted * (1 + rangePct) * 100) / 100;

    // ── CF-ACTION-RECOMMENDATION (2026-07-05, Drew): compute the
    //    per-grade seller verdict. Market Value = trendAdjustedValue if
    //    populated, else entry.value (the same fallback iOS uses on
    //    the wire). Confidence signal comes straight from the entry. ─
    const marketValueForRec = entry.trendAdjustedValue ?? entry.value ?? 0;
    entry.recommendation = computeAction({
      currentValue: marketValueForRec,
      predictedValue: entry.predictedPriceAt30d,
      confidenceScore: entry.confidenceScore,
      signalSource: derivation.signalSource,
      weeksSinceRelease: releaseDecayContext?.weeksSinceRelease ?? null,
    });
  }

  return derivation;
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
/**
 * CF-CLASS-AWARE-GRADE-MULTIPLIERS (2026-07-06, Drew): "we need to
 * formalize the multipliers for premium cards like this and figure
 * out a better pricing."
 *
 * Autographs and base cards have structurally different grade
 * multipliers because the price DISTRIBUTIONS are different:
 *   - Base cards start cheap ($0.50-$5 Raw) → PSA 10 is often
 *     10-20× because the top grade is genuinely scarce vs the raw
 *     supply.
 *   - Autos start higher ($20-$100 Raw for prospects) → PSA 10 is
 *     usually only 6-8× because the raw price already prices in
 *     rarity, and PSA 8 remains a meaningful market instead of
 *     collapsing to Raw.
 *
 * Callers pass `cardClass: "auto" | "base"` to
 * `fillEstimatedFallback` (defaults to "base" for backward compat).
 * The old single-column table is now a wrapper around the "base"
 * column for any legacy consumer.
 *
 * Values are hobby-consensus starting points. As we accumulate
 * corpus data via #290's calibration script, these become the
 * BACKSTOP; the empirical per-(year, set, class) numbers become the
 * primary source when available.
 */
type CardClass = "auto" | "base";
const GRADE_MULTIPLIER_MATRIX: Record<CardClass, Record<string, number>> = {
  auto: {
    "Raw": 1,
    // 10-tier: autos have tighter distributions; PSA 10 typically 6-8×
    "PSA 10": 7,
    "BGS 10": 15,   // Pristine still commands a premium but less than base
    "BGS 9.5": 4,
    "SGC 10": 4,
    "CGC 10": 4,
    // 9-tier: PSA 9 auto ≈ 2.5-3× Raw
    "PSA 9": 2.8,
    "BGS 9": 2.8,
    "SGC 9": 2.8,
    "CGC 9": 2.8,
    // 8-tier: PSA 8 auto ≈ 1.5-2× Raw (55-65% of PSA 9)
    "PSA 8": 1.75,
    "BGS 8": 1.75,
    "SGC 8": 1.75,
    "CGC 8": 1.75,
  },
  base: {
    "Raw": 1,
    // 10-tier: base cards have wider distributions; PSA 10 super scarce
    "PSA 10": 8,
    "BGS 10": 20,   // Pristine — rare, big premium over PSA 10
    "BGS 9.5": 5,
    "SGC 10": 5,
    "CGC 10": 5,
    // 9-tier: all four graders similar; PSA 9 is the reference
    "PSA 9": 3,
    "BGS 9": 3,
    "SGC 9": 3,
    "CGC 9": 3,
    // 8-tier: base card PSA 8 ≈ 1.5-2× Raw
    "PSA 8": 1.75,
    "BGS 8": 1.75,
    "SGC 8": 1.75,
    "CGC 8": 1.75,
  },
};

/** Legacy alias — code that hasn't been updated to pass cardClass
 *  reads from the "base" column. New callers should use
 *  `gradeMultiplierFor(cardClass, gradeLabel)`. */
const RAW_TO_GRADE_FALLBACK_MULTIPLIER: Record<string, number> = GRADE_MULTIPLIER_MATRIX.base;

/** Preferred lookup — reads the matrix by (cardClass, gradeLabel).
 *  Returns undefined when the grade isn't in the matrix (unknown
 *  variant grader). */
function gradeMultiplierFor(cardClass: CardClass, gradeLabel: string): number | undefined {
  return GRADE_MULTIPLIER_MATRIX[cardClass][gradeLabel];
}

/**
 * CF-BETTER-ESTIMATED-GRADE-MATH (2026-07-05):
 * Second-pass fill for grades where observed sampleCount === 0. Priority:
 *
 *   1. Reference-price at this grade (third-party model, when caller
 *      passes referencePriceByGrade). Preferred because it typically
 *      reflects a broader eBay observation than our own filter sees.
 *   2. Raw observed × hand-tuned tier multiplier. Last-resort fallback
 *      when reference-price is also missing.
 *   3. Leave valueSource "unavailable" when neither path yields a number.
 *
 * Drew's rationale (2026-07-05): "if someone comes back with a 10 with
 * no sales, they want us to help them with an accurate number to sell
 * for." A flat Raw × 8 multiplier isn't accurate enough — a card's
 * PSA 10 grade premium varies with release, print run, and market
 * demand. The reference price captures more of that variance because
 * it's derived from broader data.
 *
 * When corpus grows enough, we can also add a tier-3 layer using
 * computeReleaseGradeCurve for release-specific ratios.
 */
/** CF-REFERENCE-PRICE-CROSS-CHECK (2026-07-05): threshold for the
 *  `referenceAnomaly` flag. When our engine's value differs from the
 *  external reference by more than this fraction, iOS can badge the
 *  divergence so the seller knows to look closer. */
const REFERENCE_ANOMALY_THRESHOLD_PCT = 25;

function fillEstimatedFallback(
  entries: ObservedGradeEntry[],
  referencePriceByGrade?: ReadonlyMap<string, number>,
  /** CF-CLASS-AWARE-GRADE-MULTIPLIERS (2026-07-06, Drew): identifies
   *  whether the card is an auto or base — autos have tighter grade
   *  distributions, so PSA 10 / PSA 8 multipliers differ from base
   *  cards. Optional; defaults to "base" for backward compat. Callers
   *  with card meta on hand (routes fetching getCardMetaById) should
   *  pass the resolved class. */
  cardClass: CardClass = "base",
): void {
  const raw = entries.find((e) => e.grade === "Raw");
  const rawObserved =
    raw && raw.valueSource === "observed" && raw.weightedMedianPrice !== null
      ? raw.weightedMedianPrice
      : null;

  for (const entry of entries) {
    if (entry.grade !== "Raw" && entry.valueSource !== "observed") {
      // Priority 1: reference price at this grade (third-party model).
      const refPrice = referencePriceByGrade?.get(entry.grade);
      if (typeof refPrice === "number" && Number.isFinite(refPrice) && refPrice > 0) {
        entry.value = Math.round(refPrice * 100) / 100;
        entry.valueSource = "estimated";
        entry.estimatedFrom = "reference-price";
        entry.estimatedMultiplier = null; // no multiplier used
      } else if (rawObserved !== null) {
        // Priority 2: Raw observed × class-aware tier multiplier.
        const multiplier = gradeMultiplierFor(cardClass, entry.grade);
        if (typeof multiplier === "number" && multiplier > 0) {
          entry.value = Math.round(rawObserved * multiplier * 100) / 100;
          entry.valueSource = "estimated";
          entry.estimatedFrom = "raw-multiplier";
          entry.estimatedMultiplier = multiplier;
        }
      }
    }

    // CF-REFERENCE-PRICE-CROSS-CHECK (2026-07-05): compute divergence
    // between OUR value and the external reference for EVERY entry
    // (observed AND estimated). For observed entries this is the
    // primary signal — the reference is the sanity check on our
    // comp-pool math. For reference-price-estimated entries the
    // divergence is 0 by construction (we used the reference AS the
    // value). Emit for both so iOS can render consistently.
    const refPriceForCheck = referencePriceByGrade?.get(entry.grade);
    if (
      typeof refPriceForCheck === "number" &&
      Number.isFinite(refPriceForCheck) &&
      refPriceForCheck > 0
    ) {
      entry.referencePrice = Math.round(refPriceForCheck * 100) / 100;
      if (entry.value !== null && entry.value > 0) {
        const divergence = (entry.value / refPriceForCheck - 1) * 100;
        entry.referenceDivergencePct = Math.round(divergence * 100) / 100;
        entry.referenceAnomaly =
          Math.abs(divergence) > REFERENCE_ANOMALY_THRESHOLD_PCT;
      }
    }
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
export async function buildObservedGradeCurve(
  cardId: string,
  opts: {
    playerName?: string | null;
    /** CF-BETTER-ESTIMATED-GRADE-MATH (2026-07-05): when provided,
     *  fillEstimatedFallback prefers this over the hand-tuned Raw ×
     *  multiplier. Callers with reference-price data on hand (e.g.
     *  /card-panel already fetches getAllPricesByCard) pass the
     *  grade→price map here. Callers without it can omit — falls
     *  through to the multiplier as before. */
    referencePriceByGrade?: ReadonlyMap<string, number>;
    /** CF-PARALLEL-TIER-TREND (2026-07-05): when provided, unlocks the
     *  same-parallel-tier trajectory fallback for long-tail players
     *  whose CH matched-cohort can't be built. `(year, set, variant)`
     *  identifies the tier — e.g. `(2026, "Bowman Chrome", "Blue
     *  X-Fractor")`. Callers with card meta on hand (routes fetching
     *  getCardMetaById) should pass this; callers without it can omit
     *  and trajectory will still fire when matched-cohort works. */
    parallelTierKey?: ParallelTierKey | null;
    /** CF-SIBLING-CARD-FALLBACK (2026-07-06, Drew): opt-in for the
     *  last-resort sibling-card price fallback. When ALL grades come
     *  back valueSource: "unavailable" AND this flag is true AND
     *  playerName + parallelTierKey are present, try to seed Raw from
     *  a same-player Base Auto sibling in the same set × parallel
     *  premium. Adds ~2-3 CH calls when it fires, so ONLY enable on
     *  interactive user-facing routes (/card-panel, /price-by-id);
     *  bulk reprice paths should leave it off. */
    enableSiblingFallback?: boolean;
    /** CF-CLASS-AWARE-GRADE-MULTIPLIERS (2026-07-06, Drew): "auto" |
     *  "base". Autos have tighter grade distributions (PSA 10 ≈ 7×
     *  Raw for autos vs ≈ 8-10× for base cards); passing the right
     *  class produces materially better estimates when observed comps
     *  are absent. Defaults to "base" for backward compat. Routes with
     *  card meta should resolve from identity.subset (contains
     *  "auto"/"signature" → "auto"). */
    cardClass?: CardClass;
  } = {},
): Promise<ObservedGradeCurve> {
  const entries = await Promise.all(
    CANONICAL_GRADES.map((cfg) => aggregateGrade(cardId, cfg)),
  );
  // Second pass — fills value/valueSource on non-observed grades,
  // preferring reference-price over Raw × multiplier when provided.
  fillEstimatedFallback(entries, opts.referencePriceByGrade, opts.cardClass ?? "base");

  // Third pass — CF-ONE-TRAJECTORY: derive a bounded per-week rate from
  // player weekly buckets, then compute Market Value (today) + Predicted
  // (30d) for every observed entry so all three numbers sit on one line.
  // Returns the derivation so it can be persisted to the corpus for
  // later calibration analysis (CF-CORPUS-TRAJECTORY-FIELDS 2026-07-05).
  const derivation = await applyTrajectory(
    entries,
    opts.playerName ?? null,
    opts.parallelTierKey ?? null,
  );

  // CF-SIBLING-CARD-FALLBACK (2026-07-06, Drew) + CF-SIBLING-TREND-ANCHOR:
  // Runs AFTER applyTrajectory so we have the derived rate to project
  // the sibling's median forward. Drew: "we want this to predict
  // accurately, median is a weighted average [snapshot]" — the sibling
  // fallback now:
  //   1. Takes the target's trajectory rate (matched-cohort / parallel-
  //      tier / release-decay chain)
  //   2. Fetches the sibling's Base Auto median + newest sale date
  //   3. Projects the sibling FORWARD to today at that rate
  //   4. Multiplies by the print-run-floored parallel premium
  //   5. Returns estimated Raw TODAY + estimated Raw at 7d
  //
  // Populates the target's trendAdjustedValue + predictedPriceAt30d
  // fields directly — no second trajectory pass needed.
  // Lineage captured across the sibling-fallback branch so we can
  // surface it on the return value (CF-SIBLING-LINEAGE-SURFACE
  // 2026-07-07). Null when no sibling fallback fired.
  let siblingFallbackLineage: ObservedGradeCurve["siblingFallback"] = null;

  // CF-SIBLING-WIDER-TRIGGER (2026-07-07, Drew): sibling fallback fires
  // when the target has NO Raw comps AND the parallel is a known-rare
  // tier (has a print-run floor entry). The old trigger required
  // EVERY grade to be "unavailable" — which rarely held because if
  // reference-prices were provided, they'd fill slab entries and
  // sibling silently skipped. Result: Raw pill stayed "unavailable"
  // for rare-parallel cards where CH's model DID have slab reference
  // prices but no Raw sales pool. Widened trigger fires sibling for
  // Raw specifically; the cascade at line 1428 already respects
  // reference-price slabs (only overrides entries still unavailable).
  const rawEntry = entries.find((e) => e.grade === "Raw");
  const rawIsUnavailable = !rawEntry || rawEntry.valueSource === "unavailable";
  const isRareParallel =
    opts.parallelTierKey?.variant
      ? inferPrintRunForParallel(opts.parallelTierKey.variant) !== null
      : false;
  const allUnavailable = entries.every((e) => e.valueSource === "unavailable");
  const shouldFireSibling =
    (allUnavailable || (isRareParallel && rawIsUnavailable)) &&
    opts.enableSiblingFallback &&
    opts.playerName &&
    opts.parallelTierKey;

  if (shouldFireSibling && opts.parallelTierKey && opts.playerName) {
    try {
      const parallelTierKey = opts.parallelTierKey;
      const { attemptSiblingPriceFallback } = await import(
        "./siblingCardPriceFallback.service.js"
      );
      const fallback = await attemptSiblingPriceFallback({
        targetCardId: cardId,
        year:
          typeof parallelTierKey.year === "number"
            ? parallelTierKey.year
            : parseInt(String(parallelTierKey.year), 10),
        set: parallelTierKey.set,
        parallel: parallelTierKey.variant,
        // CF-SIBLING-NON-AUTO-COVERAGE (2026-07-06, Drew): route the
        // actual card class through so Orange /25 BASE cards, Gold /50
        // base parallels, etc. also get sibling fallback coverage.
        // Previously hardcoded true (autos-only) as MVP.
        isAuto: (opts.cardClass ?? "base") === "auto",
        playerName: opts.playerName,
        trajectoryRateWeekly: derivation?.cappedRate ?? null,
      });
      if (fallback && fallback.estimatedRawPrice !== null) {
        siblingFallbackLineage = {
          siblingCardId: fallback.siblingCardId,
          siblingParallel: fallback.siblingParallel,
          siblingBaseMedianRaw: fallback.siblingBaseMedianRaw,
          siblingBaseProjectedToday: fallback.siblingBaseProjectedToday,
          siblingWeeksSinceNewestSale: fallback.siblingWeeksSinceNewestSale,
          parallelPremium: fallback.parallelPremium,
          empiricalPremium: fallback.empiricalPremium,
          floorApplied: fallback.floorApplied,
          inferredPrintRun: fallback.inferredPrintRun,
          premiumMatchedSet: fallback.premiumMatchedSet,
          premiumUsedProxy: fallback.premiumUsedProxy,
          siblingIsCrossClass: fallback.siblingIsCrossClass,
          crossClassAutoPremium: fallback.crossClassAutoPremium,
        };
        const rawEntry = entries.find((e) => e.grade === "Raw");
        if (rawEntry) {
          rawEntry.value = fallback.estimatedRawPrice;
          rawEntry.valueSource = "estimated";
          rawEntry.estimatedFrom = "sibling-card";
          // trendAdjustedValue = the same value (already trend-projected
          // to today via sibling projection). iOS falls back to `value`
          // when trendAdjustedValue is null anyway; explicit populate for
          // clarity + downstream trajectory-aware consumers.
          rawEntry.trendAdjustedValue = fallback.estimatedRawPrice;
          if (fallback.estimatedRawPredicted7d !== null) {
            rawEntry.predictedPriceAt30d = fallback.estimatedRawPredicted7d;
            // Bands: ±15% since this is an estimate not observed
            rawEntry.predictedPriceRangeLow =
              Math.round(fallback.estimatedRawPredicted7d * 0.85 * 100) / 100;
            rawEntry.predictedPriceRangeHigh =
              Math.round(fallback.estimatedRawPredicted7d * 1.15 * 100) / 100;
            rawEntry.predictedPricePct =
              Math.round(((fallback.estimatedRawPredicted7d / fallback.estimatedRawPrice) - 1) * 10000) / 100;
          }
        }
        // Cascade sibling-derived Raw to slab grades via class-aware
        // tier multipliers. CF-SIBLING-NON-AUTO-COVERAGE (PR #305)
        // lifted the autos-only restriction, so we now use the
        // caller's opts.cardClass (auto vs base) directly.
        for (const entry of entries) {
          if (entry.grade === "Raw" || entry.valueSource !== "unavailable") continue;
          const multiplier = gradeMultiplierFor(opts.cardClass ?? "base", entry.grade);
          if (typeof multiplier === "number" && multiplier > 0) {
            entry.value = Math.round(fallback.estimatedRawPrice * multiplier * 100) / 100;
            entry.valueSource = "estimated";
            entry.estimatedFrom = "sibling-card";
            entry.estimatedMultiplier = multiplier;
            entry.trendAdjustedValue = entry.value;
            if (fallback.estimatedRawPredicted7d !== null) {
              const predictedAtGrade =
                Math.round(fallback.estimatedRawPredicted7d * multiplier * 100) / 100;
              entry.predictedPriceAt30d = predictedAtGrade;
              entry.predictedPriceRangeLow = Math.round(predictedAtGrade * 0.85 * 100) / 100;
              entry.predictedPriceRangeHigh = Math.round(predictedAtGrade * 1.15 * 100) / 100;
              entry.predictedPricePct =
                Math.round(((predictedAtGrade / entry.value) - 1) * 10000) / 100;
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        `[observedGradeCurve.siblingFallback] failed for ${cardId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  return {
    cardId,
    entries,
    totalSampleCount: entries.reduce((sum, e) => sum + e.sampleCount, 0),
    computedAt: new Date().toISOString(),
    ratePerWeek: derivation?.cappedRate ?? null,
    signalSource: derivation?.signalSource ?? null,
    siblingFallback: siblingFallbackLineage,
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
            estimatedFrom: null,
            daysSinceNewestSale: null,
            newestSalePrice: null,
            trendAdjustedValue: null,
            trendAdjustmentPct: null,
            predictedPriceAt30d: null,
            predictedPricePct: null,
            predictedPriceRangeLow: null,
            predictedPriceRangeHigh: null,
            predictedHorizonDays: PREDICTED_HORIZON_DAYS,
            recommendation: null,
            salesHistory: [],
            referencePrice: null,
            referenceDivergencePct: null,
            referenceAnomaly: false,
          })),
          totalSampleCount: 0,
          computedAt: new Date().toISOString(),
          ratePerWeek: null,
          signalSource: null,
          siblingFallback: null,
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
