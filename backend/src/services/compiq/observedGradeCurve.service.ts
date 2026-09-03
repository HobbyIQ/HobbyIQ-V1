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
import { recordBoundedProjectionAlert } from "./boundedProjectionAlerts.service.js";
import { logSubRawInversionObserved } from "./marketRead.service.js";
import { readSoldCompsForGrade } from "./soldCompsGradeReader.js";
import { isOwnComp } from "./selfComp.js";
import type { FmvRungLabel } from "./fmvRung.js";
// CF-ONE-GRADE-CURVE (D4 PR 4, 2026-08-29). The ONE writer of a tier's
// numbers from the unified engine, and the field-population contract iOS
// resolves its headline through. This service decides which entry a unified
// tier maps to; gradeCurveEntry decides which fields carry the number.
import {
  applyUnifiedTierToEntry,
  blankGradeCurveEntry,
  gradeCurveEntryLabel,
  unifiedTierHasPool,
} from "./gradeCurveEntry.js";
import { computeWeightedMedian, getGraderPremium } from "./compiqEstimate.service.js";
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
import { lookupGradeRatio, lookupGradeRatioByTier, classifyFamily, lookupValueBandMultiplierWithScope } from "./gradeCalibrationConfig.js";

/** Grade lookup. `label` matches the CH grade param; `grader` is the
 *  parent grading company for UI grouping; `psaEquivalent` is used to
 *  order grades on the confidence rail (higher = better condition). */
export const CANONICAL_GRADES: ReadonlyArray<{
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
  // CF-BGS-BLACK-LABEL-SPLIT (2026-08-22). A BGS 10 Black Label (all four
  // subgrades 10) is a different card from a Pristine 10 and trades like one.
  // Measured over 4,000 BGS 10 sales in 365d: 365 of them (9.1%) say "black
  // label" in the title, median $395 against $130 for the rest — 3.0x. They
  // were being folded into BGS 10, inflating both the tile and the BGS 10
  // calibration ratio platform-wide.
  //
  // gradeQualifier exists for exactly this and is null on all 4,000 rows, so
  // the split is done by title text, which is what the Cardsight-conflation
  // note prescribes.
  { label: "BGS 10 Black Label", grader: "BGS", psaEquivalent: 10 },
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
  /** CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). How many of `sampleCount`
   *  are the viewer's OWN purchases. The ruling keeps those rows in the tier
   *  -- they are real sales -- and requires the basis be disclosed rather than
   *  the row hidden. 0 when no viewer is known, which is every anonymous read. */
  ownSampleCount: number;
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
  /** CF-RUNG-LABEL (D4 PR 1, 2026-08-29). The rung that produced `value`
   *  / `trendAdjustedValue` for this tier, in the shared vocabulary
   *  (fmvRung.ts): the unified overlay's own label when it reached this
   *  tier; "exact-pool-trajectory" for this service's own observed read;
   *  "grade-curve-estimate" for an estimated tier (see `estimatedSource`
   *  for the mechanism); null when unavailable. portfolioStore persists
   *  the chosen tile's label as the holding's `fmvRung`. */
  rungLabel?: FmvRungLabel | null;
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
  estimatedFrom: "reference-price" | "raw-multiplier" | "sibling-card" | "empirical-ratio" | "empirical-ratio-tier" | null;
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
    /** The measured parallel-premium multiplier applied. D4 PR 5: there
     *  is no floor any more — this IS the calibration measurement. */
    parallelPremium: number;
    /** Same as parallelPremium (kept for KQL written against the
     *  lineage; the two can no longer differ). */
    empiricalPremium: number;
    /** Inferred print run for the target parallel by NAME (25 for
     *  Orange, 50 for Gold, ...). A scarcity guess, not a multiplier. */
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

// CF-DIRECT-SOLD-COMPS-SOURCE (Drew, 2026-08-07). Grade curve now
// reads directly from our sold_comps pool instead of CardHedge's
// remote API. Reasons:
//   1. CH coverage lags for new-release cards (hot rookies like Eric
//      Hartman Orange Shimmer had 0 CH data → grade curve returned
//      empty tiles) while we HAD 3 real sales in sold_comps.
//   2. Own-the-data doctrine — pricing standard lives in our pool,
//      not a vendor's aggregation.
//   3. Latency — one Cosmos query instead of a remote CH round-trip
//      per grade tier.
/** Matches the tier LABEL "BGS 10 Black Label". */
const BLACK_LABEL_LABEL_RE = /black\s*label/i;

/**
 * CF-BGS-BLACK-LABEL-SPLIT (2026-08-22). Is this sale a BGS Black Label?
 *
 * Detected from the listing title because `gradeQualifier` — the field that
 * exists for this — is null on all 4,000 BGS 10 rows sampled. Sellers name it
 * explicitly when they have one; it is the whole point of the card.
 *
 * Conservative by construction: only a positive title match splits a sale out.
 * An unlabelled Black Label stays in the Pristine pool, which understates it
 * slightly. The reverse — a Pristine 10 pulled into the Black pool — would
 * overstate a much scarcer grade, so the asymmetry is deliberate.
 */
export function isBlackLabelSale(title: string | null | undefined): boolean {
  return BLACK_LABEL_LABEL_RE.test(String(title ?? ""));
}

async function fetchRawSalesForGrade(
  cardId: string,
  grade: string,
): Promise<Array<{ price: number; date: string | null; saleType: string | null; source: string | null; contributorUserId: string | null }>> {
  // CF-GRADE-CURVE-TEST-SEAM (2026-08-16). The Cosmos read moved to
  // soldCompsGradeReader so tests can mock a seam of our own instead of
  // "@azure/cosmos" — mocking that module hits every other Cosmos consumer in
  // the graph and took the suite from 89 to 107 failures. Filtering stays HERE
  // so mocking the reader still exercises the real title rules below.
  // CF-BGS-BLACK-LABEL-SPLIT (2026-08-22). Both tiers read the same BGS 10
  // rows and then partition on the title, because gradeQualifier is null on
  // every one of them.
  const isBlackTier = BLACK_LABEL_LABEL_RE.test(grade);
  const readGrade = isBlackTier ? "BGS 10" : grade;
  const resources = await readSoldCompsForGrade(cardId, readGrade);

  // Title-based rejection — filters IP/TTM tokens, bulk lot listings,
  // "read description", etc.
  const kept = resources.filter((r) => {
    if (!Number.isFinite(r.price) || r.price <= 0) return false;
    if (shouldRejectSaleTitle(r.title ?? "")) return false;
    // The partition. A Black Label sale must not price a Pristine 10, and a
    // Pristine 10 sale must not price a Black Label — 3x apart.
    const black = isBlackLabelSale(r.title ?? null);
    if (isBlackTier) return black;
    if (readGrade === "BGS 10") return !black;
    return true;
  });

  return kept.map((r) => ({
    price: r.price,
    date: r.soldAt ?? null,
    // CF-BIN-WEIGHT-FIELD-RENAME (2026-08-16). Was hardcoded null on the
    // belief that sold_comps carries no sale type. It does — under
    // `listingType`, populated on 518,595 rows — so computeWeightedMedian's
    // BIN lift had been disabled by a field rename rather than by design.
    saleType: r.listingType ?? null,
    // CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). Carried so the tier can
    // DISCLOSE how many of its samples are the viewer's own purchases. The
    // rows were always in this pool -- the read filters on grade, price and
    // the adjudication flags, never on source -- but nothing downstream could
    // say so, which is why a curve tier built on an own purchase looked
    // identical to one built on an arm's-length sale.
    source: r.source ?? null,
    contributorUserId: (r as { contributorUserId?: string | null }).contributorUserId ?? null,
  }));
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
export function computeConfidence(sampleCount: number, newestDate: string | null): number {
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
  viewerUserId?: string | null,
): Promise<ObservedGradeEntry> {
  const sales = await fetchRawSalesForGrade(cardId, cfg.label);
  const prices = sales.map((s) => s.price);
  const dates = sales
    .map((s) => s.date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();

  const rawWeighted = computeWeightedMedian(
    sales.map((s) => ({ price: s.price, date: s.date, saleType: s.saleType })),
  );
  const plain = computePlainMedian(prices);
  const low = computePercentile(prices, 0.10);
  const high = computePercentile(prices, 0.90);

  // CF-VELOCITY-CLAMP (Drew, 2026-08-06, revised same day). Original
  // clamp fired whenever weighted was outside [p10, p90] — but that
  // erases legitimate recency lift when the last 4 sales all sit above
  // p90 (real market drift, not contamination). Revised rule: only
  // clamp DOWNWARD when the weighted median falls WAY below p10 — a
  // sub-p10 median implies the recency window is dominated by damaged
  // auction wins or seller dumps, and the pool truly is more valuable
  // than that. Upward drift is trusted (recent sales trending high IS
  // the signal we want to project forward). "Way below" = < p10 * 0.5
  // so only the egregious cases (Raw MV $4.50 vs p10 $14.50) trip.
  let weighted = rawWeighted;
  if (
    rawWeighted !== null && plain !== null && low !== null &&
    rawWeighted < low * 0.5
  ) {
    weighted = plain;
  }
  const newest = dates.length ? dates[dates.length - 1] : null;
  const oldest = dates.length ? dates[0] : null;
  // CF-RECENCY-LIFT (2026-07-05): find the price of the single newest
  // sale (by date). Sort a lightweight { price, date } view of sales,
  // then take the tail. Kept separate from `weighted` because the two
  // answer different questions — weighted median is the pool's smoothed
  // center; newestSalePrice is the freshest datapoint.
  const salesWithDates = sales.filter(
    (s): s is { price: number; date: string; saleType: string | null; source: string | null; contributorUserId: string | null } =>
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
    // CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). n is disclosed, not
    // reduced: own purchases are counted in `sampleCount` because they are
    // real sales, and `ownSampleCount` says how many of that n they are.
    ownSampleCount: sales.filter((s) => isOwnComp(s, viewerUserId)).length,
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
/** Maximum weeks look-back — trends beyond 12 weeks aren't reliable
 *  enough to linearly extrapolate. A 6-month-old comp on a hot player
 *  gets treated as-if 12 weeks old for trajectory purposes.
 *  CF-TRAJECTORY-12WK (Drew, 2026-07-28): extended from 6 → 12 weeks
 *  so 60-90-day-old comps on trending players get real projection
 *  instead of stale-comp treatment. Multiplier bounds below stop
 *  the extrapolation from producing negative or unreasonable FMVs. */
const MAX_WEEKS_LOOKBACK = 12;
/** CF-TRAJECTORY-12WK bounds. With 12-week lookback + ±10%/week rate
 *  cap, linear multiplier can hit ±120% which produces a negative FMV
 *  on the down side. Floor at 0.20 (80% max drop from anchor) and
 *  ceiling at 3.0 (200% max rise). Beyond these, we're saying "we can
 *  predict a card lost 90%+ of value in 3 months on linear model" —
 *  not defensible without direct comps. Hitting either bound emits
 *  a KQL telemetry event so we can review over time. */
const PROJECTION_MULTIPLIER_FLOOR = 0.20;
const PROJECTION_MULTIPLIER_CEILING = 3.0;
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

/**
 * CF-CONFIDENCE-TIERED-BANDS (2026-07-08, Drew): pick a Predicted band
 * width based on the entry's data source. Preserves the pre-existing
 * ±8% for observed values (kept ~ same across sample sizes to avoid
 * regressing observed-value UX). The tiering focuses on the ESTIMATED
 * paths where the pre-change ±15% flat band read the same for a
 * confident reference-price and a floor-only sibling projection.
 */
function pickBandWidthPct(entry: ObservedGradeEntry): number {
  if (entry.valueSource === "observed") {
    return PREDICTED_RANGE_PCT;   // ±8%, unchanged
  }
  if (entry.valueSource === "estimated") {
    switch (entry.estimatedFrom) {
      case "reference-price":       return 0.15;   // third-party model, decent trust
      case "empirical-ratio-tier":  return 0.15;   // per-grade calibration from ch_daily_sales
      case "empirical-ratio":       return 0.18;   // company-level calibration × subtier
      case "raw-multiplier":        return 0.20;
      case "sibling-card":          return 0.25;   // hobby-consensus floor territory
      default:                      return ESTIMATED_PREDICTED_RANGE_PCT;
    }
  }
  return PREDICTED_RANGE_PCT;
}
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
      const rawMultiplier = 1 + rate * weeksSinceSale;
      // CF-TRAJECTORY-12WK bounds. 12 weeks × ±10%/week = ±120% linear
      // rate, which produces negative multipliers on the down side.
      // Floor/ceiling stop extrapolation from producing indefensible
      // projections; hits log a boundedProjectionAlert so a nightly
      // digest can email Drew for review.
      const marketMultiplier = Math.max(
        PROJECTION_MULTIPLIER_FLOOR,
        Math.min(PROJECTION_MULTIPLIER_CEILING, rawMultiplier),
      );
      if (marketMultiplier !== rawMultiplier) {
        recordBoundedProjectionAlert({
          source: "observedGradeCurve.trendAdjust",
          playerName: playerName ?? null,
          cardId: null,
          rate,
          weeksSinceSale,
          rawMultiplier,
          bounded: marketMultiplier,
          direction: rawMultiplier > marketMultiplier ? "capped-ceiling" : "capped-floor",
        });
      }
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
    //
    // CF-PER-TIER-RATE (Drew, 2026-08-02). Previously every grade tier
    // used the SAME card-level `rate` → identical predictedPricePct on
    // every row (Drew saw "-4.3%" across all six grades). Fix: derive
    // a per-tier weekly rate from that grade's own newest sale price
    // vs its weighted median, blended with the card-level rate for
    // smoothing. Use per-tier rate when the entry has enough own-grade
    // data (n>=4); fall back to card-level when thin.
    let effectiveRate = rate;
    if (
      entry.valueSource === "observed" &&
      entry.sampleCount >= 4 &&
      typeof entry.newestSalePrice === "number" && entry.newestSalePrice > 0 &&
      typeof entry.weightedMedianPrice === "number" && entry.weightedMedianPrice > 0 &&
      typeof entry.daysSinceNewestSale === "number" && entry.daysSinceNewestSale >= 1
    ) {
      // Recent-vs-baseline signal: how far above/below the weighted
      // median is the newest observed sale, scaled to a weekly rate.
      const pctDelta = (entry.newestSalePrice / entry.weightedMedianPrice) - 1;
      const weeks = Math.max(1, entry.daysSinceNewestSale / 7);
      const perTierWeekly = pctDelta / weeks;
      // Blend 65% per-tier (dominant) with 35% card-level (smoother).
      // Cap the blended rate to ±10%/wk (same guardrail deriveWeeklyRate uses).
      const blended = 0.65 * perTierWeekly + 0.35 * rate;
      effectiveRate = Math.max(-0.10, Math.min(0.10, blended));
    }
    const predictedMultiplier = 1 + effectiveRate * (PREDICTED_HORIZON_DAYS / 7);
    const predicted =
      Math.round(marketValueForForwardAnchor * predictedMultiplier * 100) / 100;
    // CF-CONFIDENCE-TIERED-BANDS (2026-07-08, Drew: "flat ±15% band
    // reads the same whether we have 200 real sales or one sibling
    // projection"). Band width now scales by data source:
    //   observed, n>=10:   ±5%  (rich sample, low noise)
    //   observed, n=4-9:   ±10% (moderate confidence)
    //   observed, n=1-3:   ±20% (thin sample, single-sale outlier risk)
    //   estimated:
    //     - reference-price:  ±15% (third-party model, decent)
    //     - sibling with empirical premium: ±15%
    //     - sibling floor-only (no empirical): ±25% (hobby-consensus only)
    //     - raw-multiplier fallback: ±20%
    const rangePct = pickBandWidthPct(entry);
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

  // ── CF-GRADE-MONOTONICITY-CAP (2026-07-09, Drew — Devin Taylor gold
  //    auto): trend adjustment lifts raw's trendAdjustedValue above its
  //    static point estimate, but estimated graded entries stay at their
  //    Raw × multiplier value by design (line 1064 comment: layering
  //    trend on an already-projected estimate compounds uncertainty).
  //    Result: hot-market raw can visibly exceed graded on iOS ($1908
  //    trendAdjusted raw vs $1182 static PSA 10) — a clear inversion.
  //
  //    Invariant: raw's shown value must not exceed the smallest graded
  //    value whose multiplier > 1.0 (i.e. any grade that's structurally
  //    supposed to exceed raw). Cap raw's trendAdjustedValue and
  //    predictedPriceAt30d to that floor. Preserves the trend signal for
  //    raw when it's within-band; only bites when it would breach grade
  //    monotonicity.
  //
  //    Applies to BOTH the market value AND the 30d predicted (same
  //    inversion mechanism affects predicted-vs-predicted comparisons).
  //    The predicted is recomputed from the capped market value using
  //    entry.predictedPricePct (which encodes the rate over the horizon).
  const rawEntry = entries.find((e) => e.grader === "Raw");
  if (rawEntry && rawEntry.value !== null && rawEntry.value > 0) {
    const rawShownValue = rawEntry.trendAdjustedValue ?? rawEntry.value;
    // Floor = the smallest graded value where multiplier > 1 (i.e. the
    // grade is supposed to be worth strictly more than raw). Grades with
    // multiplier === 1 (e.g. PSA 8) are semantically equivalent to raw
    // per Drew's spec so they can equal raw without an inversion.
    // Track the ENTRY, not just its number — the telemetry has to say WHICH
    // grade the raw value sits above, or "sub-raw" is unactionable.
    const floorEntry = entries.reduce<ObservedGradeEntry | null>((best, e) => {
      if (e.grader === "Raw") return best;
      if (e.value === null || e.value <= 0) return best;
      const mult = e.estimatedMultiplier;
      // Only cards with a "strictly-above-raw" multiplier count as a floor.
      if (typeof mult !== "number" || mult <= 1.0) return best;
      return best === null || e.value < (best.value ?? Infinity) ? e : best;
    }, null);
    const nonRawStrictFloor = floorEntry?.value ?? null;

    if (
      nonRawStrictFloor !== null &&
      rawShownValue > nonRawStrictFloor + 0.005
    ) {
      // CF-SUB-RAW-IS-REAL (Drew, 2026-08-20: "a raw can be worth more in
      // different areas, so lets not do that"). OBSERVE, DO NOT CLAMP.
      //
      // THIS USED TO CAP RAW DOWN TO THE CHEAPEST GRADED VALUE, on the premise
      // that a raw card cannot be worth more than a graded one. The premise is
      // false: a raw card carries the OPTION on a high grade, so it routinely
      // trades above a low-graded copy — a raw with a shot at a PSA 10 is worth
      // more than a PSA 8, and in some markets more than a PSA 9.
      //
      // The rest of the system already knows this. `sub_raw_inversion_observed`
      // exists precisely to TRACK raw-above-graded as a market signal, and that
      // telemetry feeds DailyIQ. Clamping here deleted the signal the product is
      // built on, then logged the deletion as though it were a correction.
      //
      // It also destroyed correct output. A Raw card projecting to $220 off an
      // accurate 12-week trend was rewritten to $108, because the cheapest
      // ESTIMATED graded tier — itself computed as that same raw value x 1.08 —
      // became the floor. The bound was our own estimate of the number being
      // bounded, so the curve judged itself: the identical circularity we spent
      // this week removing from the catalog, where a mis-slugged comp seeds a
      // row that then vouches for the comp.
      //
      // The original 2026-07-09 complaint (Devin Taylor gold auto, raw $1908 vs
      // PSA 10 estimate $1182) was a real DISPLAY problem, but its cause is that
      // raw is trended and estimated grades deliberately are not — an
      // apples-to-oranges comparison. Clamping raw treated the symptom by
      // falsifying the better number.
      const rawMarket = rawEntry.trendAdjustedValue ?? rawEntry.value;
      logSubRawInversionObserved({
        source: "observedGradeCurve.gradeMonotonicity",
        player: playerName ?? null,
        cardId: null,
        event: {
          grader: floorEntry?.grader ?? "unknown",
          grade: floorEntry?.grade ?? "unknown",
          gradeMedian: nonRawStrictFloor,
          gradeCount: 0,
          rawMedian: rawMarket,
          marginPct: rawMarket > 0
            ? Math.round(((rawMarket - nonRawStrictFloor) / rawMarket) * 10000) / 100
            : 0,
          marginUSD: Math.round((rawMarket - nonRawStrictFloor) * 100) / 100,
        },
      });
    }
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
// CF-EMPIRICAL-ONLY-MULTIPLIER (Drew, 2026-07-20). The hand-tuned
// GRADE_MULTIPLIER_MATRIX (Base PSA 10 = 8×, Auto PSA 10 = 2.75×,
// BGS 10 = 20×, etc.) is REMOVED. The empirical (family, grader)
// medianRatios in gradeCalibrationConfig.ts are the sole source of
// truth for estimatedMultiplier.
//
// Rationale: the hand-tuned matrix was defined years before the
// empirical corpus reached the size where its ratios could be
// trusted. Keeping both meant every uncalibrated family silently
// fell back to numbers that couldn't be defended against the pool
// data. Removing it forces every uncalibrated (family, grader)
// combo to surface as valueSource: "unavailable" on the iOS pill
// and log a `grade_multiplier_uncovered` event — we then either
// (a) add a calibration entry for that family or (b) accept the
// gap. Real accuracy > false completeness.
type CardClass = "auto" | "base";

/** No-op preserved so downstream callers that still expect a
 *  fallback don't crash. Always returns undefined — the caller's
 *  entry stays valueSource: "unavailable" if empirical is also
 *  missing. */
function gradeMultiplierFor(_cardClass: CardClass, _gradeLabel: string): number | undefined {
  return undefined;
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

/** CF-EMPIRICAL-GRADE-MULTIPLIER (Drew, 2026-07-20). Sub-tier scaling
 *  applied on top of the company-level empirical medianRatio ONLY when
 *  we don't have an empirical per-tier ratio yet. Empirical calibration
 *  lumps all PSA (or BGS, etc.) grades of a company into a single
 *  ratio; this discounts down to the specific grade value so a
 *  "PSA 9" doesn't inherit the "PSA 10"-heavy company ratio verbatim.
 *
 *  CF-GRADE-CALIBRATE-PER-TIER (Drew, 2026-07-22): now a strict fallback
 *  — resolveMultiplier prefers the empirical per-tier ratio from
 *  lookupGradeRatioByTier when data is thick. Tune values here are only
 *  seen when a specific (family, grader, tier) cell has <20 samples. */
function subTierScaling(gradeValue: number | null): number {
  if (gradeValue === null || !Number.isFinite(gradeValue)) return 0;
  if (gradeValue >= 10) return 1.00;
  if (gradeValue >= 9.5) return 0.65;
  if (gradeValue >= 9)   return 0.35;
  return 0.20;
}

function parseGradeValue(gradeLabel: string): number | null {
  const m = String(gradeLabel ?? "").match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

/** Prefer empirical per-tier ratio (family, grader, tier). Fall back to
 *  empirical company-level ratio × sub-tier scaling when the tier cell
 *  is thin. Fall back further to hardcoded class-aware matrix when the
 *  family isn't calibrated at all. */
function resolveMultiplier(args: {
  entry: ObservedGradeEntry;
  family: string | null;
  sport: string | null;
  cardClass: CardClass;
  cardId?: string | null;
  rawPrice?: number | null;
  /** Set name — feeds getGraderPremium's set-bump layer. */
  setName?: string | null;
  /** Card year — feeds getGraderPremium's vintage/modern branch. */
  cardYear?: number | null;
}): number | undefined {
  const { entry, sport, cardClass, rawPrice, setName, cardYear } = args;
  // CF-MULTIPLIER-LADDER-SHARED (Drew, 2026-08-06). Prior local ladder
  // duplicated ~3 of the 9 rungs compiqEstimate.getGraderPremium runs
  // and diverged for auto cards (missed set-bump + auto-table +
  // vintage + gem-rate branches). Real case: Eric Hartman PSA 10
  // Orange Shimmer Auto — grade curve showed $8,927 while price-by-id
  // showed $4,202 for the same card.
  //
  // Fix: DELEGATE to the same function price-by-id calls. Guaranteed
  // agreement on every rung — no future drift possible when new
  // multiplier layers are added to the ladder because there's only
  // one ladder now.
  const premium = getGraderPremium(
    entry.grader,
    // getGraderPremium expects the grade VALUE (e.g. "10") not the
    // full "PSA 10" label — matches compiqEstimate's own callsites.
    entry.grade.replace(/^[A-Z]+\s+/i, ""),
    rawPrice ?? null,
    cardClass === "auto" ? "autograph" : "base",
    cardYear ?? null,
    setName ?? null,
    null,      // gemRateSignal — not available at grade-curve site
    sport,
  );
  if (Number.isFinite(premium) && premium > 0) return premium;
  // Fallback if getGraderPremium returns invalid — shouldn't happen
  // (function always returns a number) but belt-and-suspenders.
  return gradeMultiplierFor(cardClass, entry.grade);
}

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
  /** CF-EMPIRICAL-GRADE-MULTIPLIER (Drew, 2026-07-20): setName used to
   *  classify the product family for lookupGradeRatio. When provided
   *  and the (family, grader) pair has calibration data, empirical
   *  medianRatio × sub-tier scaling wins over the hardcoded matrix. */
  setName: string | null = null,
  /** Optional sport override for sport-conditioned calibration. */
  sport: string | null = null,
  /** Optional cardId — surfaces in the `grade_multiplier_uncovered`
   *  log so we can find which cards are uncalibrated. */
  cardId: string | null = null,
): void {
  const raw = entries.find((e) => e.grade === "Raw");
  const rawObserved =
    raw && raw.valueSource === "observed" && raw.weightedMedianPrice !== null
      ? raw.weightedMedianPrice
      : null;

  const family = setName ? classifyFamily(setName) : null;

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
        // Priority 2a (preferred): empirical medianRatio for
        // (family, grader) × sub-tier scaling by grade value.
        // Priority 2b (fallback): hardcoded class-aware matrix.
        // Extract cardYear from hobbyiqCardId slug — segment 2 is the
        // year in `hiq:sport:year:set:cardNumber:...`. Needed by
        // getGraderPremium's vintage-vs-modern branch.
        let cardYear: number | null = null;
        if (cardId && cardId.startsWith("hiq:")) {
          const parts = cardId.split(":");
          if (parts.length >= 3) {
            const y = Number(parts[2]);
            if (Number.isFinite(y) && y >= 1900 && y <= 2100) cardYear = y;
          }
        }
        const multiplier = resolveMultiplier({
          entry,
          family,
          sport,
          cardClass,
          cardId,
          rawPrice: rawObserved,
          setName,
          cardYear,
        });
        if (typeof multiplier === "number" && multiplier > 0) {
          entry.value = Math.round(rawObserved * multiplier * 100) / 100;
          entry.valueSource = "estimated";
          const gv = parseGradeValue(entry.grade);
          if (family && gv !== null && lookupGradeRatioByTier(family, entry.grader, gv, sport) !== null) {
            entry.estimatedFrom = "empirical-ratio-tier";
          } else if (family && lookupGradeRatio(family, entry.grader, sport) !== null) {
            entry.estimatedFrom = "empirical-ratio";
          } else {
            entry.estimatedFrom = "raw-multiplier";
          }
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
/**
 * CF-GRADE-CURVE-POOL-UNION (2026-08-22). Which slug should the unified overlay
 * union against, given the id we were called with and the one the caller kept?
 *
 * Prefer the caller's slug: a caller that resolved slug -> dominant vendor
 * cardId still knows the slug, and dropping it makes the curve price off a
 * strictly narrower pool than the portfolio path, which unions both. Fall back
 * to cardId when it IS the slug, for callers that only ever hold one id.
 *
 * Returns null when there is no slug to union — callers must not pass a vendor
 * id as hobbyiqCardId, which would union an id against itself and silently
 * widen nothing.
 */
export function resolveUnionSlug(
  cardId: string,
  callerSlug: string | null | undefined,
): string | null {
  const supplied = typeof callerSlug === "string" ? callerSlug.trim() : "";
  if (supplied.startsWith("hiq:")) return supplied;
  const own = String(cardId ?? "").trim();
  return own.startsWith("hiq:") ? own : null;
}

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
    /** CF-EMPIRICAL-GRADE-MULTIPLIER (Drew, 2026-07-20): setName drives
     *  product-family classification for empirical medianRatio lookup.
     *  Prefer over the hardcoded class matrix when calibration data
     *  exists for the family. Optional; hardcoded matrix used when
     *  absent. */
    setName?: string | null;
    /** Optional sport override for sport-specific calibration overlays. */
    sport?: string | null;
    /** CF-GRADE-CURVE-POOL-UNION (2026-08-22). The canonical hiq slug for this
     *  card, when the caller has one AND `cardId` is not it.
     *
     *  Callers that hold a slug routinely resolve it to the dominant vendor
     *  cardId before calling here, because the observed-curve queries below
     *  want the vendor id. That resolution DISCARDS the slug, and the unified
     *  overlay then unions `cardId` against nothing — a narrower pool than the
     *  portfolio pricing path, which unions (cardId OR hobbyiqCardId). Same
     *  card, two pools, two market values.
     *
     *  Pass the pre-resolution slug here and both survive. Callers that only
     *  ever have one id can omit it; the hiq:-prefix fallback below still
     *  covers them. */
    hobbyiqCardId?: string | null;
  } = {},
): Promise<ObservedGradeCurve> {
  const entries = await Promise.all(
    CANONICAL_GRADES.map((cfg) => aggregateGrade(cardId, cfg)),
  );
  // Second pass — fills value/valueSource on non-observed grades,
  // preferring reference-price over Raw × multiplier when provided.
  fillEstimatedFallback(
    entries,
    opts.referencePriceByGrade,
    opts.cardClass ?? "base",
    opts.setName ?? null,
    opts.sport ?? null,
    cardId,
  );

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

  const curve: ObservedGradeCurve = {
    cardId,
    entries,
    totalSampleCount: entries.reduce((sum, e) => sum + e.sampleCount, 0),
    computedAt: new Date().toISOString(),
    ratePerWeek: derivation?.cappedRate ?? null,
    signalSource: derivation?.signalSource ?? null,
    siblingFallback: siblingFallbackLineage,
  };

  // CF-SITE-CURVE-NO-BLANK-TIERS (2026-08-22). Captured from the unified
  // overlay below and reused as a last-resort anchor. Free — that call
  // already happens, so nothing extra is fetched for it.
  let unifiedAnchor: number | null = null;

  // CF-UNIFIED-PRICING-CONVERGE (Drew, 2026-08-04). All callers of
  // buildObservedGradeCurve get unified pricing's numbers overlaid
  // onto their entries. Same rows, same math as the portfolio
  // pricing pipeline — one number and one prediction per grade.
  //
  // Only overrides observed entries where unified has real data
  // (weightedMedian > 0 AND sampleCount > 0). Estimated fallbacks
  // (grades with no market data) keep their observedGradeCurve
  // values so we don't lose fallback coverage.
  try {
    const { computeUnifiedPrice } = await import("./unifiedPricing.service.js");
    // CF-UNIFIED-HIQ-UNION (Drew, 2026-08-08). When cardId is a hiq
    // slug (starts with "hiq:"), also pass it as hobbyiqCardId so
    // queryComps' OR-union catches rows stored under vendor cardIds
    // (CH, TCA, Cardsight) that carry the same hobbyiqCardId slug.
    // Without this, buildObservedGradeCurve's queryComps ONLY matches
    // rows where cardId literally equals the hiq slug — for Ohtani
    // 2018 BC RC that was 24 PSA 9 rows instead of 85. Overlay values
    // computed from too-thin a pool then failed the sampleCount>0 gate
    // for some tiers, silently reverting to the CH-based initial-pass
    // anchor bleed.
    //
    // CF-FIXED-WIDE-WINDOW (Drew, 2026-08-08). Also pass
    // fixedWindowDays: 180 so unified queries the full 6-month pool
    // instead of adaptive-cascading down to a 7-day window based on
    // total-pool density. The grade-curve panel needs EVERY tier that
    // has any activity in the last 6 months to receive a leading-edge
    // MV + trend. Adaptive-tight (7d) would exclude PSA 10 for Ohtani
    // (newest sale 9 days ago) from unified.gradeCurve entirely →
    // no leading-edge, no trend, no MV correction. 180d catches all.
    // CF-ONE-VALUATION-PATH (D16, 2026-08-30). Was `fixedWindowDays: 180`:
    // every tier of this curve read the pool at 180d while the headline for
    // the same tier (hobbyiq-fmv, the persist site) read it at the density
    // cascade's window — the D14 probe's grade-curve-vs-hobbyiq-fmv gap.
    // Per-tier windows run that same cascade for every tier from one 180d
    // read, so a tier here IS its headline.
    const hiqOpt: Parameters<typeof computeUnifiedPrice>[1] = {
      perTierWindows: true,
    };
    const unionSlug = resolveUnionSlug(cardId, opts.hobbyiqCardId);
    if (unionSlug) hiqOpt.hobbyiqCardId = unionSlug;
    const u = await computeUnifiedPrice(cardId, hiqOpt);
    unifiedAnchor = u.marketValue ?? u.fmv ?? null;
    const byLabel = new Map(u.gradeCurve.map((e) => [e.grade, e]));
    // CF-GRADE-LABEL-BUGFIX (Drew, 2026-08-08). entry.grade already carries
    // the grader ("PSA 10"), and unified labels its tiers the same way, so
    // the two match directly; `${grader} ${grade}` produced "PSA PSA 10",
    // matched nothing, and left every graded tier at the family's top-tier
    // anchor ("PSA 8 = PSA 9 = PSA 10" on the Grade Curve UI).
    //
    // CF-ONE-GRADE-CURVE (D4 PR 4, 2026-08-29). The overlay used to write
    // its own choice of fields here — `value` got the weighted MEDIAN and
    // `trendAdjustedValue` the market value — and the /card-panel route
    // then wrote a second, differently-windowed overlay over it, and the
    // tree enricher a third. Every number on a unified tier now goes through
    // applyUnifiedTierToEntry, the one place that decides which field
    // carries what, so iOS's `trendAdjustedValue ?? value ?? median…`
    // chain resolves to the projection on every surface.
    const seen = new Set<string>();
    for (const entry of curve.entries) {
      const label = gradeCurveEntryLabel(entry);
      seen.add(label);
      const um = byLabel.get(label);
      if (um && unifiedTierHasPool(um)) {
        applyUnifiedTierToEntry(entry, um, {
          confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate),
        });
      }
    }
    // Tiers the pool has sales for that CANONICAL_GRADES does not list —
    // PSA 7 and below on vintage, CSG / HGA slabs. The tree enricher used
    // to append these from its own 7d-first cascade (a second engine); they
    // now come from the same pool through the same writer. Each is placed
    // after the last tier of its grader so pill order stays grouped.
    for (const um of u.gradeCurve) {
      if (seen.has(um.grade) || !unifiedTierHasPool(um)) continue;
      if (/\?/.test(um.grade)) continue;   // a grader with no numeric grade is not a tier
      const grader = um.gradeCompany ? String(um.gradeCompany).toUpperCase() : "Raw";
      const extra = applyUnifiedTierToEntry(blankGradeCurveEntry(um.grade, grader), um, {
        confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate),
      });
      let insertAt = curve.entries.length;
      for (let i = curve.entries.length - 1; i >= 0; i--) {
        if (curve.entries[i].grader === grader) { insertAt = i + 1; break; }
      }
      curve.entries.splice(insertAt, 0, extra);
      seen.add(um.grade);
    }
    (curve as { totalSampleCount: number }).totalSampleCount = Math.max(
      curve.totalSampleCount,
      u.totalSampleCount,
    );
  } catch {
    // Never fails the curve — legacy numbers stay as fallback.
  }

  // ── CF-SITE-CURVE-NO-BLANK-TIERS (2026-08-22) ─────────────────────────
  // One last pass over whatever is still unavailable, anchored on the best
  // evidence we already hold (observed Raw, then an observed graded tier
  // divided back by its ratio, then the unified market value captured
  // above). Empirical ratios ONLY. Extracted to fillUnavailableTiersFromAnchor
  // (D16) so the one valuation path's curve runs the identical fill.
  await fillUnavailableTiersFromAnchor(curve.entries, {
    anchorFallback: unifiedAnchor,
    setName: opts.setName ?? null,
    sport: opts.sport ?? null,
    slug: String(opts.hobbyiqCardId ?? cardId),
  });

  // CF-GRADE-CURVE-MONOTONIC (Drew, 2026-08-06, revised same day).
  // Grade tiles must ascend WITHIN a grader (PSA 8 ≤ PSA 9 ≤ PSA 10,
  // BGS 8 ≤ 9 ≤ 9.5 ≤ 10). Original commit also floored PSA tiers to
  // Raw's value — that back-fired when Raw pool had high-end sales
  // inflating its weighted median. Raw $1,850 (real) → floored PSA 8
  // (real $150), PSA 9 (real $325), AND PSA 10 (real $1,850) all to
  // $1,850. Removed the Raw floor: Raw and graded pools are different
  // markets, Raw can legitimately exceed some low PSA tiers in edge
  // cases. Only enforce ascending WITHIN a grader.
  // CF-MONOTONIC-CONFIDENCE-GUARD (Drew, 2026-08-08). Prior version
  // used the first tier as the floor unconditionally — if PSA 8 had
  // thin/estimated data at a bogus-high value ($9,128 from CH fallback),
  // PSA 9 with 85 real observations at $2,300 got FLOORED UP to $9,128.
  // Anchor collapse via monotonic pass.
  //
  // Fix: only tiers with observed data and sampleCount >= MONOTONIC_TRUST_MIN
  // are trusted as floors for higher tiers. Thin-data / estimated tiers
  // are skipped for the floor role (their own value is still enforced
  // against a trusted-tier floor if one exists).
  const MONOTONIC_TRUST_MIN = 5;
  // extractGradeNum / isBlackLabelTier: module-level helpers (below).
  const graders = new Set(curve.entries.map((e) => e.grader).filter((g): g is string => !!g && g !== "Raw"));
  for (const grader of graders) {
    const tierRows = curve.entries
      .filter((e) => e.grader === grader)
      .map((e) => ({ e, gv: extractGradeNum(e.grade) }))
      .sort((a, b) => a.gv - b.gv)
      .map((x) => x.e);
    let prevFloor: number | null = null;
    for (const t of tierRows) {
      const own = t.trendAdjustedValue ?? t.value ?? null;
      // Enforce floor from a trusted lower tier only.
      if (prevFloor !== null && own !== null && own < prevFloor) {
        t.value = prevFloor;
        t.trendAdjustedValue = prevFloor;
        if (t.predictedPriceAt30d !== null && t.predictedPriceAt30d < prevFloor) {
          t.predictedPriceAt30d = prevFloor;
        }
      }
      // Advance prevFloor ONLY when this tier itself is trustworthy —
      // observed AND sampleCount >= MONOTONIC_TRUST_MIN. Estimated tiers
      // and thin-observed tiers can't set a floor for the next higher
      // tier (which may have far better data at a lower price).
      if (own !== null && t.valueSource === "observed" && (t.sampleCount ?? 0) >= MONOTONIC_TRUST_MIN) {
        prevFloor = own;
      }
    }
  }

  // ── CF-PROJECTED-TIERS-MONOTONIC (2026-08-22) ─────────────────────────
  // Projected tiers may not exceed the nearest HIGHER tier of the same
  // grader; observed tiers are never touched. Extracted to capProjectedTiers
  // (D16) so the one valuation path's curve applies the identical rule.
  capProjectedTiers(curve.entries);

  // CF-RUNG-LABEL (D4 PR 1). Name the rung on every tier the overlay did
  // not already label: an observed tier is this service's own exact-pool
  // read carried by the trajectory; an estimated tier is a fill; an
  // unavailable tier has no rung. A consumer (portfolioStore's tile path)
  // reads this field — it does not infer the rung from valueSource.
  for (const e of curve.entries) {
    if (e.rungLabel) continue;
    e.rungLabel = e.valueSource === "observed"
      ? "exact-pool-trajectory"
      : e.valueSource === "estimated" ? "grade-curve-estimate" : null;
  }

  return curve;
}

// ─── Shared curve passes (D16: one valuation path) ──────────────────────────
//
// buildObservedGradeCurve and the one valuation path's curve
// (oneValuationPath.service) run the SAME fill and the SAME cap, defined once
// here. The observed-tier floor pass (CF-GRADE-CURVE-MONOTONIC) is deliberately
// NOT shared: it rewrites an observed tier's number, and the one valuation
// path never rewrites what the engine computed (grade monotonicity is not an
// invariant).

/** CF-GRADE-SORT-BUGFIX (Drew, 2026-08-08). "PSA 10" → 10, "BGS 9.5" → 9.5.
 *  parseFloat started at "P" and returned 0 for every tier, so the monotonic
 *  walk ran in array order (descending) and floored PSA 9 up to PSA 10.
 *  CF-BGS-BLACK-LABEL-SPLIT: "BGS 10 Black Label" outranks a Pristine 10
 *  (measured 3.0x), so it is nudged above. */
export function extractGradeNum(grade: string | number | null): number {
  if (typeof grade === "number") return grade;
  const text = String(grade ?? "");
  const m = text.match(/(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : 0;
  if (/black\s*label/i.test(text)) return n + 0.25;
  return n;
}

export function isBlackLabelTier(e: { grade: string | number }): boolean {
  return /black\s*label/i.test(String(e.grade ?? ""));
}

/**
 * CF-GRADED-POOL-INVERSE (Drew, 2026-08-31). Which observed graded tier of
 * THIS identity anchors a raw price, and by what multiplier — the inverse of
 * the raw→graded direction, on the SAME GRADE_CALIBRATION tables.
 *
 * Drew's ruling: "we should be able to price from graded cards to raw if it
 * is unavailable with empirical data." The Figueroa Red Ink SSP is the case —
 * a card whose raw pool is empty while its own PSA 10 children hold sales.
 *
 * The tier is picked by EVIDENCE, never by averaging tiers: no median or mean
 * across tiers, and no "highest tier wins". The rule mirrors the ordering the
 * curve already trusts elsewhere (`MONOTONIC_TRUST_MIN`, and the cascade's
 * own preference for the denser window): a tier's evidence is its pool size
 * first, its recency second. A PSA 10 pool at n=3 beats a PSA 9 at n=1; a
 * PSA 9 at n=3 beats a PSA 10 at n=1, because three sales are three sales
 * whichever tier they sit in — the multiplier is what translates the tier,
 * and it is empirical in both directions.
 *
 * A tier with no empirical multiplier for this (family, sport, grade) cannot
 * anchor anything: `empiricalGradeMultiplier` returns null and the tier is
 * skipped, so the walk falls to the next-best-evidenced tier and, if none
 * has a multiplier, returns null. Blank beats invented.
 */
export interface GradedPoolInverseAnchor {
  /** The raw value the graded tier implies: its projection ÷ the multiplier. */
  rawValue: number;
  /** The tier that anchored it ("PSA 10"). */
  fromGrade: string;
  fromGrader: string;
  /** That tier's pool size — the evidence that won it the anchor role. */
  fromSampleCount: number;
  /** The tier's own projected next sale (never a median across tiers). */
  fromValue: number;
  /** The empirical multiplier divided out, from GRADE_CALIBRATION. */
  multiplier: number;
}

/** Rank observed graded tiers by evidence: pool size first, recency second. */
function rankGradedTiersByEvidence(entries: ObservedGradeEntry[]): ObservedGradeEntry[] {
  return entries
    .filter((e) => e.grade !== "Raw" && e.valueSource === "observed"
      && typeof (e.trendAdjustedValue ?? e.value) === "number"
      && ((e.trendAdjustedValue ?? e.value) as number) > 0)
    .sort((a, b) => {
      const n = (b.sampleCount ?? 0) - (a.sampleCount ?? 0);
      if (n !== 0) return n;
      const at = a.newestSaleDate ? Date.parse(a.newestSaleDate) : 0;
      const bt = b.newestSaleDate ? Date.parse(b.newestSaleDate) : 0;
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
}

/**
 * CF-GRADED-POOL-INVERSE. The raw price this identity's OWN graded children
 * imply, or null when no graded tier has both sales and an empirical
 * multiplier. Same identity only — the caller passes one card's curve, so a
 * different card number or a different auto can never reach this.
 *
 * The numerator is the tier's PROJECTION (`trendAdjustedValue`, the rung's
 * number — FMV is the projected next sale), not its weighted median.
 */
export function gradedPoolInverseAnchor(
  entries: ObservedGradeEntry[],
  ratioFor: (grader: string, value: number | null) => number | null,
): GradedPoolInverseAnchor | null {
  for (const e of rankGradedTiersByEvidence(entries)) {
    const gradeNum = Number(String(e.grade).replace(/[^0-9.]/g, "")) || null;
    const r = ratioFor(e.grader, gradeNum);
    if (r === null || !Number.isFinite(r) || r <= 0) continue;   // no empirical multiplier → this tier cannot anchor
    const fromValue = (e.trendAdjustedValue ?? e.value) as number;
    const rawValue = fromValue / r;
    if (!Number.isFinite(rawValue) || rawValue <= 0) continue;
    return {
      rawValue,
      fromGrade: String(e.grade),
      fromGrader: String(e.grader ?? ""),
      fromSampleCount: e.sampleCount ?? 0,
      fromValue,
      multiplier: r,
    };
  }
  return null;
}

/** The (family, sport) pair a slug's calibration lookups use. */
export function calibrationScopeFor(
  opts: { setName?: string | null; sport?: string | null; slug?: string | null },
): { family: string; sport: string | null } {
  const seg = String(opts.slug ?? "").split(":");
  return {
    sport: opts.sport ?? (seg[0] === "hiq" ? seg[1] ?? null : null),
    family: classifyFamily(opts.setName ?? (seg[0] === "hiq" ? seg[3] ?? null : null)),
  };
}

/**
 * CF-SITE-CURVE-NO-BLANK-TIERS (2026-08-22). Fill every tier still
 * "unavailable" from the best anchor the curve already holds, × the EMPIRICAL
 * grade ratio (GRADE_CALIBRATION via empiricalGradeMultiplier) — a grade with
 * no calibration stays unavailable rather than being projected off a
 * hardcoded matrix. Anchor precedence: observed Raw; then the best-EVIDENCED
 * observed graded tier divided back by its own ratio (CF-GRADED-POOL-INVERSE,
 * Drew 2026-08-31 — the graded→raw rung); then `anchorFallback` (the unified
 * market value the caller captured). Marks filled tiers "estimated" /
 * estimatedFrom "anchor-projection". Returns the anchor used.
 */
export async function fillUnavailableTiersFromAnchor(
  entries: ObservedGradeEntry[],
  opts: { anchorFallback: number | null; setName?: string | null; sport?: string | null; slug?: string | null },
): Promise<number | null> {
  try {
    const { empiricalGradeMultiplier } = await import("./canonicalFmv.service.js");
    const { family: familyForRatio, sport: sportForRatio } = calibrationScopeFor(opts);

    const ratioFor = (grader: string, value: number | null): number | null =>
      empiricalGradeMultiplier(grader, value, familyForRatio, sportForRatio);

    let anchor: number | null = null;
    const rawEntry = entries.find((e) => e.grade === "Raw");
    if (rawEntry?.valueSource === "observed" && typeof rawEntry.value === "number" && rawEntry.value > 0) {
      anchor = rawEntry.value;
    }
    if (anchor === null) {
      // CF-GRADED-POOL-INVERSE: this identity's own graded children price the
      // raw, best-evidenced tier first, on the same empirical tables.
      anchor = gradedPoolInverseAnchor(entries, ratioFor)?.rawValue ?? null;
    }
    if (anchor === null && opts.anchorFallback !== null && opts.anchorFallback > 0) {
      anchor = opts.anchorFallback;
    }

    if (anchor !== null && Number.isFinite(anchor) && anchor > 0) {
      for (const entry of entries) {
        if (entry.valueSource !== "unavailable") continue;
        if (entry.grade === "Raw") {
          (entry as { value: number | null }).value = Math.round(anchor * 100) / 100;
          (entry as { valueSource: string }).valueSource = "estimated";
          (entry as { estimatedFrom: string | null }).estimatedFrom = "anchor-projection";
          (entry as { confidenceScore: number | null }).confidenceScore = 0.4;
          continue;
        }
        const gradeNum = Number(String(entry.grade).replace(/[^0-9.]/g, ""));
        const r = ratioFor(entry.grader, Number.isFinite(gradeNum) ? gradeNum : null);
        if (r === null || !Number.isFinite(r) || r <= 0) continue;   // no calibration → stays hidden
        const projected = anchor * r;
        if (!Number.isFinite(projected) || projected <= 0) continue;
        (entry as { value: number | null }).value = Math.round(projected * 100) / 100;
        (entry as { valueSource: string }).valueSource = "estimated";
        (entry as { estimatedFrom: string | null }).estimatedFrom = "anchor-projection";
        (entry as { estimatedMultiplier: number | null }).estimatedMultiplier = r;
        (entry as { confidenceScore: number | null }).confidenceScore = 0.35;
      }
    }
    return anchor;
  } catch { return null; /* silent-safe — a blank tier is bad, a broken curve is worse */ }
}

/**
 * CF-PROJECTED-TIERS-MONOTONIC (2026-08-22). When a card has no graded sales,
 * every tier is projected from one anchor × a ratio, and the ratio table's own
 * inconsistencies pass straight through (SGC 9 $2,121 above SGC 10 $1,086 —
 * two calibration cells disagreeing, not a market inversion). So projected
 * tiers may not exceed the nearest HIGHER tier of the same grader. Observed
 * tiers are never touched — they set the ceiling, they do not receive one —
 * so a genuine observed inversion still shows, exactly as the doctrine
 * requires. Black Label sits out of the walk (a qualifier on the 10, no
 * calibration cell of its own) and takes one floor: not below the Pristine
 * 10 it outranks, and only when it is itself an estimate.
 */
export function capProjectedTiers(entries: ObservedGradeEntry[]): void {
  const graders = new Set(entries.map((e) => e.grader).filter((g): g is string => !!g && g !== "Raw"));
  for (const grader of graders) {
    const rows = entries
      .filter((e) => e.grader === grader && !isBlackLabelTier(e))
      .map((e) => ({ e, gv: extractGradeNum(e.grade) }))
      .sort((a, b) => b.gv - a.gv);   // highest grade first
    let ceiling: number | null = null;
    for (const { e } of rows) {
      const own = e.trendAdjustedValue ?? e.value ?? null;
      if (own === null) continue;
      if (e.valueSource === "estimated" && ceiling !== null && own > ceiling) {
        e.value = ceiling;
        e.trendAdjustedValue = ceiling;
        if (e.predictedPriceAt30d !== null && e.predictedPriceAt30d > ceiling) {
          e.predictedPriceAt30d = ceiling;
        }
        continue;   // capped value must not then raise the ceiling
      }
      ceiling = ceiling === null ? own : Math.min(ceiling, own);
    }

    const black = entries.find((e) => e.grader === grader && isBlackLabelTier(e));
    const plainTen = entries.find(
      (e) => e.grader === grader && !isBlackLabelTier(e) && extractGradeNum(e.grade) === 10,
    );
    if (black && plainTen && black.valueSource === "estimated") {
      const blackVal = black.trendAdjustedValue ?? black.value ?? null;
      const tenVal = plainTen.trendAdjustedValue ?? plainTen.value ?? null;
      if (blackVal !== null && tenVal !== null && blackVal < tenVal) {
        black.value = tenVal;
        black.trendAdjustedValue = tenVal;
      }
    }
  }
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
export const BULK_CONCURRENCY = 8;

/** CF-EMPIRICAL-GRADE-MULTIPLIER (Drew, 2026-07-20). Per-card meta the
 *  bulk helper can pipe to buildObservedGradeCurve so each card's
 *  empirical (family, grader) multiplier resolves correctly. Callers
 *  without meta can omit — those cards will log
 *  grade_multiplier_uncovered and return valueSource: "unavailable"
 *  on non-observed entries (by design). */
export interface BulkPerCardMeta {
  setName?: string | null;
  sport?: string | null;
  cardClass?: "auto" | "base";
}

export async function buildObservedGradeCurvesBulk(
  cardIds: readonly string[],
  perCardMeta?: ReadonlyMap<string, BulkPerCardMeta>,
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
        const meta = perCardMeta?.get(id) ?? {};
        const curve = await buildObservedGradeCurve(id, {
          setName: meta.setName ?? null,
          sport: meta.sport ?? null,
          cardClass: meta.cardClass ?? "base",
        });
        results.set(id, curve);
      } catch (err) {
        console.warn(
          `[observedGradeCurve.bulk] card_id=${id} failed (non-fatal): ${
            (err as Error)?.message ?? err
          }`,
        );
        results.set(id, {
          cardId: id,
          entries: CANONICAL_GRADES.map((cfg) => blankGradeCurveEntry(cfg.label, cfg.grader)),
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
