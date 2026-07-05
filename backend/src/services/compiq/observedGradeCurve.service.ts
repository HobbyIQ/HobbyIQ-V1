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
  estimatedFrom: "reference-price" | "raw-multiplier" | null;
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
    | "raw-weekly"
    | null;
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
): Promise<Array<{ price: number; date: string | null }>> {
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
  // CF-RECENCY-LIFT (2026-07-05): find the price of the single newest
  // sale (by date). Sort a lightweight { price, date } view of sales,
  // then take the tail. Kept separate from `weighted` because the two
  // answer different questions — weighted median is the pool's smoothed
  // center; newestSalePrice is the freshest datapoint.
  const salesWithDates = sales.filter(
    (s): s is { price: number; date: string } =>
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

/** Weekly rate cap — a single crazy CH bucket can't dominate a projection. */
const RATE_CAP_PER_WEEK = 0.10;
/** Maximum weeks look-back — trends beyond 6 weeks aren't reliable enough
 *  to linearly extrapolate. A 6-month-old comp on a hot player gets treated
 *  as-if 6 weeks old for trajectory purposes. */
const MAX_WEEKS_LOOKBACK = 6;
/** Predicted horizon — 30 days forward from today. Fixed at 30 for now;
 *  callers can override once we add a `horizon` param. */
const PREDICTED_HORIZON_DAYS = 30;
/** Confidence band on Predicted — ±15% around the point estimate
 *  when the underlying value comes from observed sales. */
const PREDICTED_RANGE_PCT = 0.15;
/** Wider band when the underlying value is ESTIMATED (reference-price
 *  or raw-multiplier). Predicting an estimate forward compounds
 *  uncertainty; a wider range signals that honesty visually. */
const ESTIMATED_PREDICTED_RANGE_PCT = 0.25;
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
interface RateDerivation {
  cappedRate: number;
  signalSource:
    | "matched-cohort-cached"
    | "matched-cohort-on-demand"
    | "parallel-tier"
    | "raw-weekly";
}

async function deriveWeeklyRate(
  playerName: string,
  parallelTierKey: ParallelTierKey | null,
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

  if (rawRate === null || signalSource === null) {
    // Observability: log the miss so ops can see coverage gaps in
    // matched-cohort AND parallel-tier and prioritize backfill.
    console.log(JSON.stringify({
      event: "trajectory_rate_no_signal",
      source: "observedGradeCurve",
      player: playerName,
      hadParallelTierKey: !!parallelTierKey,
      reason: "no matched-cohort AND no parallel-tier trend",
    }));
    return null;
  }

  const capped = Math.max(-RATE_CAP_PER_WEEK, Math.min(RATE_CAP_PER_WEEK, rawRate));

  // Observability: log which signal drove the trajectory.
  //   matched-cohort-cached   → the overnight job covered this player
  //   matched-cohort-on-demand → we computed inline (cache was cold)
  //   raw-weekly              → both matched-cohort paths failed
  console.log(JSON.stringify({
    event: "trajectory_rate_derived",
    source: "observedGradeCurve",
    player: playerName,
    signal: signalSource,
    rawRate: Math.round(rawRate * 10000) / 100,
    cappedRate: Math.round(capped * 10000) / 100,
    cohortSize,
  }));

  return { cappedRate: capped, signalSource };
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
  // Both a playerName AND a parallelTierKey can independently unlock
  // trajectory now — even a cardId with no playerName can get a rate
  // via parallel-tier alone. So only bail when BOTH are missing.
  if (!playerName && !parallelTierKey) return null;
  const derivation = await deriveWeeklyRate(playerName ?? "", parallelTierKey);
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
function fillEstimatedFallback(
  entries: ObservedGradeEntry[],
  referencePriceByGrade?: ReadonlyMap<string, number>,
): void {
  const raw = entries.find((e) => e.grade === "Raw");
  const rawObserved =
    raw && raw.valueSource === "observed" && raw.weightedMedianPrice !== null
      ? raw.weightedMedianPrice
      : null;

  for (const entry of entries) {
    if (entry.grade === "Raw") continue;
    if (entry.valueSource === "observed") continue;

    // Priority 1: reference price at this grade (third-party model).
    const refPrice = referencePriceByGrade?.get(entry.grade);
    if (typeof refPrice === "number" && Number.isFinite(refPrice) && refPrice > 0) {
      entry.value = Math.round(refPrice * 100) / 100;
      entry.valueSource = "estimated";
      entry.estimatedFrom = "reference-price";
      entry.estimatedMultiplier = null; // no multiplier used
      continue;
    }

    // Priority 2: Raw observed × hand-tuned tier multiplier.
    if (rawObserved !== null) {
      const multiplier = RAW_TO_GRADE_FALLBACK_MULTIPLIER[entry.grade];
      if (typeof multiplier === "number" && multiplier > 0) {
        entry.value = Math.round(rawObserved * multiplier * 100) / 100;
        entry.valueSource = "estimated";
        entry.estimatedFrom = "raw-multiplier";
        entry.estimatedMultiplier = multiplier;
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
  } = {},
): Promise<ObservedGradeCurve> {
  const entries = await Promise.all(
    CANONICAL_GRADES.map((cfg) => aggregateGrade(cardId, cfg)),
  );
  // Second pass — fills value/valueSource on non-observed grades,
  // preferring reference-price over Raw × multiplier when provided.
  fillEstimatedFallback(entries, opts.referencePriceByGrade);
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
  return {
    cardId,
    entries,
    totalSampleCount: entries.reduce((sum, e) => sum + e.sampleCount, 0),
    computedAt: new Date().toISOString(),
    ratePerWeek: derivation?.cappedRate ?? null,
    signalSource: derivation?.signalSource ?? null,
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
          })),
          totalSampleCount: 0,
          computedAt: new Date().toISOString(),
          ratePerWeek: null,
          signalSource: null,
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
