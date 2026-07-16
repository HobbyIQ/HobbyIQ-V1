// CF-GRADED-PRICE-PROJECTION (2026-06-12) — Phase 1a engine.
//
// Predicts PSA/BGS/SGC values for a card from its observed raw anchor +
// a hierarchical grade-premium ratio:
//   Tier 1 (card-specific): the card's own base raw → base graded ratio,
//                           when n_grade_base >= 3.
//   Tier 2 (player/set):    NOT IMPLEMENTED in 1a. Clean seam in
//                           resolveRatio() between tier 1 and tier 3.
//   Tier 3 (market):        existing GRADER_PREMIUMS table, read-only.
//
// DISPLAY-NOT-TRAIN DISCIPLINE
// Every result has marketValue: null AND fairMarketValue: null by
// construction. These are ESTIMATES — labeled, ranged, basis-disclosed.
// The training join's realizedReturn formula reads fairMarketValue;
// nulling it here is the structural gate that excludes graded projections
// from training-as-observed, same discipline as CF-TREND-EXTRAPOLATED.
//
// Phase 1a scope: engine + types + unit tests. NOT yet surfaced on any
// response. Wiring lands in 1b after the seam fills in.

import type {
  CardsightPricingResponse,
  CardsightSaleRecord,
} from "./catalogSource.js";
import {
  searchCatalog,
  getPricing as fetchPricing,
} from "./catalogSource.js";
import {
  selectSalesByGrade,
  getGraderPremium,
  detectGradeFromTitle,
} from "./compiqEstimate.service.js";
import {
  computeGemRateFromObservations,
  type GemRateSignal,
} from "./gemRateSignal.service.js";
import { lookupMultiplier } from "./chromeDraftMultipliers.js";
import { isBaseTitle } from "./parallelTitleMatch.js";
import { tokenizeParallel } from "./parallelTokenizer.js";
import { buildParallelTitleMatcher } from "./parallelTitleMatch.js";
import {
  computeFittedComposedMultiplier,
  getPsa10BucketRatio,
  getFittedRangeBand,
} from "./chromeFittedLadder.js";
import { cacheWrap } from "../shared/cache.service.js";
import type { TrendIQResult, TrendIQCoverage } from "./trendIQ.types.js";
import { computeForwardProjectionFactor } from "./forwardProjection.js";

// ── Public types ───────────────────────────────────────────────────────────

export type GradedProjectionConfidenceTier =
  | "estimate"      // tier-1 card ratio × base raw anchor (cleanest)
  | "rough"         // tier-1 card ratio × parallel anchor (compose noise)
  | "ballpark"      // tier-3 market ratio × any anchor — SURFACES with number
                    // (CF-ALWAYS-A-NUMBER 2026-06-12 reversed the prior 3A drop)
  | "no-data";      // no anchor at all (no raw/parallel/release value to multiply)
// CF-LEGACY-UNION-CLEANUP (audit PR #491, 2026-07-15): retired the
// deprecated "insufficient" tier. Grep-verified zero backend producers
// of `confidence: "insufficient"` / `confidenceTier: "insufficient"`
// after classifyConfidence was retargeted to "no-data" for the no-
// anchor case. iOS decodes confidenceTier as a plain String? so any
// stale wire value from an older tenant would round-trip as an unknown
// string — no crash.

export type GradedProjectionRatioSource =
  | "card"          // Tier 1: card-specific base graded/raw ratio
  | "player-set"    // Tier 2a: aggregated across sibling cards (same player, same release)
  | "release"       // Tier 2b: median per-card ratio across the entire release (set-level curve)
  | "market"        // Tier 3: existing GRADER_PREMIUMS table
  | "fitted-bucket" // CF-FITTED-LADDER (2026-06-16): pooled BCPA PSA 10
                    //                    ratio per parallel-value bucket. Applied
                    //                    only to PSA 10 + fitted composed anchor.
  | "none";         // Insufficient (no anchor or no ratio source available)

export type GradedProjectionAnchorKind =
  | "base"
  | "parallel-observed"
  // CF-ESTIMATOR-PHASE-1 (2026-06-14): observed-anchor paths. "same" =
  // a record tagged to the target parallel (pid or title-token) at any
  // grade; we derive a parallel-raw equivalent from it. "sibling" = a
  // record on a different parallel of the same card, with both ends
  // resolvable in the multiplier table so parallel ratios cancel. Both
  // are gated by BASE_RAW_TRUST_FLOOR — "same" preempts composed
  // unconditionally; "sibling" only fires when composed would be a
  // degenerate-outlier anchor (baseRawSampleCount < floor).
  | "parallel-observed-same"
  | "parallel-observed-sibling"
  | "parallel-composed"
  | "none";

export interface GradedProjectionResult {
  /** Human-readable target grade (e.g. "PSA 10", "BGS 9.5"). */
  grade: string;
  /** Point estimate, or null when insufficient. */
  estimatedValue: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  /** One-sentence basis — anchor source + ratio source + any borrow. */
  basis: string;
  confidenceTier: GradedProjectionConfidenceTier;
  ratioSource: GradedProjectionRatioSource;
  anchorKind: GradedProjectionAnchorKind;
  /** Structural training-exclusion flag. */
  isEstimate: true;
  /** Display-not-train discipline (mirrors trend-extrapolated). */
  marketValue: null;
  fairMarketValue: null;
  /**
   * CF-FITTED-RANGE-LAYER (2026-06-17): comp-sufficiency tiering that
   * drives the iOS two-line "this is an estimated range" hint. Forced to
   * "none" for any parallel at serial ≤ 50 regardless of n — top tier is
   * structurally unreliable per the fit and always shows as an estimated
   * range, never a point lifted from a single auction-driven comp.
   *   sufficient → ≥3 observed comps for the parallel → point + "comps"
   *   thin       → 1-2 observed → point + range + "comps-thin"
   *   none       → 0 observed (or top-tier override) → range only +
   *                "multiplier-range"  ← the "No recent comps" state
   */
  compSufficiency?: "sufficient" | "thin" | "none";
  /** Drives the iOS basis prose. Always present alongside compSufficiency. */
  estimateBasis?: "comps" | "comps-thin" | "multiplier-range";
  /**
   * Observed comp count for the target parallel (raw + every graded
   * bucket combined, pooled across singular/plural canonical-equivalent
   * sibling pids). iOS surfaces as "Based on N sales" when ≥1.
   */
  n?: number;
  /**
   * Fitted-multiplier range bounds. Present when a fitted composed
   * multiplier was computed (numberedTo known); null on observed-anchor
   * paths where the multiplier wasn't the deciding lever.
   */
  multiplierLow?: number | null;
  multiplierHigh?: number | null;
  /**
   * Dollar range. Always present alongside compSufficiency: defaults to
   * existing (estimateLow, estimateHigh) when no fitted multiplier was
   * applied. For compSufficiency="none" + serial ≤ 50, rangeHigh is
   * additionally widened by the card-level premium so high-profile
   * cards' top-tier upper bounds reach plausible market levels.
   */
  rangeLow?: number | null;
  rangeHigh?: number | null;
  /** Ops + future calibration; safe to log, never displayed as a price. */
  diagnostics: {
    anchorPrice: number | null;
    /** n base graded records that drove the card-specific tier-1 check. */
    cardSpecificBaseSamples: number;
    /** The final ratio actually applied (card or market or null). */
    ratio: number | null;
    /** Median of card-specific base graded comps when tier 1 fired. */
    targetGradeBaseMedian: number | null;
    /** Median of card-specific base RAW comps (the tier-1 anchor). */
    baseRawMedian: number | null;
    /** Sample count behind `baseRawMedian`. */
    baseRawSampleCount: number;
    /**
     * CF-FITTED-RANGE-LAYER (2026-06-17): within-card premium applied to
     * the upper bound of top-tier ranges. Median of (observed / fitted-
     * predicted) across the card's observed parallels, bounded [1.0, 3.0],
     * default 1.0. Surfaces here for diagnostics, never as a price.
     */
    cardPremium?: number | null;
  };
}

/**
 * Tier-2 sibling input — one sale from another card by the same player
 * in the same release. The live path's fetchCompsByPlayer returns
 * `{ cardId, title, price, date, source }` (CompByPlayer) — title is
 * the load-bearing field for base/grade detection. `parallel_id` is
 * optional because the live aggregated fetch doesn't preserve it; when
 * absent we accept the (slightly weaker) title-only base check and
 * note the limitation in the basis prose. Callers with richer per-
 * sibling pricing payloads can populate it.
 */
export interface GradedProjectionSiblingComp {
  title: string | null | undefined;
  price: number;
  parallel_id?: string | null;
}

/**
 * Tier-2b input — release-level grade-premium curve. Keyed by grade
 * label ("PSA 10", "PSA 9", "BGS 9.5", "SGC 10"). Each entry is the
 * median per-card ratio (value-normalized so expensive cards don't
 * skew the curve) plus the count of contributing cards.
 *
 * Computed once per (release, year) and cached at the same 6h TTL as
 * cs:pricing — first card in a release computes it, the rest reuse.
 * See computeReleaseGradeCurve() below.
 */
export interface ReleaseGradeRatio {
  /** Median per-card ratio for the grade across the release. */
  ratio: number;
  /** Number of release cards with ≥1 base graded(g) AND ≥1 base raw — the
   *  per-card ratios that contributed to the median. */
  contributingCards: number;
}

export type ReleaseGradeCurve = ReadonlyMap<string, ReleaseGradeRatio>;

export interface ComputeGradedProjectionInput {
  pricing: CardsightPricingResponse;
  /** Cardsight parallelId the user is asking about. Null/undefined for base. */
  targetParallelId?: string | null;
  /** Observed raw FMV for the parallel target, if available (single sale OK).
   *  When present and positive, used as the parallel-observed anchor. */
  targetParallelRawFmv?: number | null;
  /** Where the parallel-raw anchor came from. "fmv" = pool median (the value
   *  iOS shows as marketTier.value). "last-sale" = a single observed sale (the
   *  value iOS shows in the "last sold $X, N ago" slot when coverage is
   *  thin). The estimator emits a different basis string for each so the
   *  thin/stale provenance is visible, not hidden. Default "fmv" when absent. */
  targetParallelRawFmvSource?: "fmv" | "last-sale";
  /** Age in days of the last-sale anchor. Only meaningful when
   *  targetParallelRawFmvSource === "last-sale"; surfaced in the basis prose. */
  targetParallelRawFmvAgeDays?: number | null;
  /** Parallel name (e.g. "Blue Refractor") for parallel-composed fallback
   *  via lookupMultiplier when targetParallelRawFmv is absent. */
  targetParallelName?: string | null;
  /**
   * Tier-2a input: flat list of sibling sales (same player + same release,
   * exact-card-id excluded). Documented as no-op on the live path post
   * CF-Phase-1c recon — fetchCompsByPlayer surfaces only raw comps,
   * so per-player aggregation can't fire in practice. Interface kept for
   * test coverage and future graded-capable sibling sources.
   */
  siblingComps?: ReadonlyArray<GradedProjectionSiblingComp>;
  /**
   * Tier-2b input: release-level grade-premium curve, pre-computed by the
   * caller via computeReleaseGradeCurve(release, year). The engine reads
   * the entry for each target grade label; missing entries fall through
   * to tier-3 market premium. This is the production tier-2 source.
   */
  releaseRatios?: ReleaseGradeCurve | null;
  /** Human-readable release label for the tier-2b basis string
   *  ("2024 Bowman Chrome Prospects Autographs"). Optional; falls back to
   *  a generic phrasing when absent. */
  releaseLabel?: string | null;
  /**
   * CF-ESTIMATOR-PHASE-1 (2026-06-14): trend signal used by the observed-
   * anchor paths to forward-project an old sibling/same-parallel sale to
   * today. Threaded from `est.trendIQ`. When null/undefined or coverage
   * is "insufficient", computeForwardProjectionFactor returns 1.0 → no
   * forward shift. Composed/base anchor paths intentionally do NOT apply
   * trend (medians are already partially trend-aware via comp-pool
   * weighting; double-counting would over-claim).
   */
  trendIQ?: TrendIQResult | null;
  /**
   * CF-ESTIMATOR-PHASE-1 (2026-06-14): card-level parallels[] for the
   * sibling-observed anchor. Sourced from `getCardDetail(cardId).parallels`
   * at the caller (pricing.card doesn't carry parallels). Required for
   * the sibling branch to map parallel_id → name → lookupMultiplier.
   * Optional — omit and the sibling branch is skipped (falls through to
   * composed → none).
   */
  cardParallels?: ReadonlyArray<{ id: string; name: string; numberedTo?: number | null }>;
  /**
   * CF-ESTIMATOR-PHASE-2 (2026-06-15): "this card is a prospect-auto"
   * detection signal. Sourced at the caller from
   * `getCardDetail(cardId).attributes.includes("AUTO")` (same fetch that
   * provides cardParallels). When true, the parallel-composed anchor
   * applies the auto-base power-law correction `mult^0.283` instead of
   * raw `mult` — see AUTO_BASE_MULTIPLIER_EXPONENT above. When
   * false/undefined the composed path is byte-identical to pre-Phase-2.
   * Does NOT affect the sibling-anchor path (raw ratios preserved).
   */
  isAuto?: boolean;
  /** Target grade tuples to project. Defaults to TARGET_GRADES below. */
  targetGrades?: ReadonlyArray<{ company: string; grade: string; label: string }>;
}

/** Liquid grade set per Phase 0 recon. PSA 10, PSA 9, BGS 9.5, SGC 10.
 *  BGS 10 Black Label / SGC 9.5 / lower PSA grades intentionally excluded
 *  from the default; surface them via opts.targetGrades on demand. */
export const TARGET_GRADES: ReadonlyArray<{
  company: string;
  grade: string;
  label: string;
}> = [
  { company: "PSA", grade: "10",  label: "PSA 10" },
  { company: "PSA", grade: "9",   label: "PSA 9" },
  { company: "BGS", grade: "9.5", label: "BGS 9.5" },
  { company: "SGC", grade: "10",  label: "SGC 10" },
];

/** Minimum card-specific base graded samples to trust the tier-1 ratio. */
const TIER1_MIN_BASE_SAMPLES = 3;
/** Minimum aggregated sibling base graded samples to trust the tier-2a ratio. */
const TIER2_MIN_SIBLING_BASE_SAMPLES = 5;
/** Minimum contributing cards to trust the tier-2b release ratio. */
const TIER2_RELEASE_MIN_CONTRIBUTING_CARDS = 3;
/**
 * CF-ESTIMATOR-PHASE-1 decision (B) (2026-06-14): hybrid precedence gate.
 * Composed (baseRawMedian × parallel multiplier) only fires when the
 * pid=null base raw pool has at least this many samples — below floor,
 * a single anomalous base sale fully determines the result and the
 * resulting anchor is a degenerate outlier (Konnor n=1 case). Cards
 * above the floor (Leo n=22) stay on composed and remain byte-identical
 * to pre-Phase-1. Tuned to 3 because that's the same threshold the
 * tier-1 card-specific ratio uses for "enough data to trust per-card."
 *
 * Under decision (B), this floor is also the implicit gate that
 * separates "trust the per-card calibration" from "fall through to the
 * observed-anchor paths (same-parallel then sibling)" — see the
 * selection-order comment inside resolveAnchor.
 */
const BASE_RAW_TRUST_FLOOR = 3;

/**
 * CF-ESTIMATOR-PHASE-2 (2026-06-15): auto-base multiplier correction.
 *
 * The Chrome-Draft multiplier table is calibrated against NON-auto base.
 * For prospect-auto numbered parallels (CPA-LD, CPA-KG, etc.) the auto
 * IS the base, and the table's multipliers over-claim systematically:
 * a constrained power-law fit on 15 raw-only same-parallel sales across
 * 8 auto cards gave `over(mult) = mult^0.717` (R²=0.369, n=15,
 * constrained to over(1.0)=1.0 so Base Auto trivially equals itself).
 *
 * The corrected auto multiplier is therefore:
 *   autoCorrected(mult) = mult / over(mult) = mult / mult^0.717 = mult^0.283
 *
 * Expected effects:
 *   Blue (5.7×)        → 1.64× corrected   (Leo PSA 10 $3,260 → $937)
 *   Gold (14.5×)       → 2.13× corrected
 *   Red (55×)          → 3.11× corrected
 *   Base Auto (1.0×)   → 1.00× corrected   (identity floor)
 *
 * Applied ONLY at:
 *   (a) parallel-composed anchor in resolveAnchor (this file, ~L725)
 *   (b) predictedRangeMultiplierAnchored.ts L204+L236 (separate consumer)
 *
 * NOT applied at the sibling-anchor path (this file, ~L467-L469):
 *   sibling math uses parallel multiplier RATIOS (target_mult / source_mult).
 *   A power-law correction breaks ratio identity:
 *     (5.7^0.283) / (4.9^0.283) = (5.7/4.9)^0.283 ≠ 5.7/4.9
 *   Correcting both ends would shift Phase 1's shipped sibling outputs
 *   (Konnor PSA 9 $830 → ~$745). The sibling path stays on raw ratios.
 *
 * Detection signal: getCardDetail(cardId).attributes.includes("AUTO")
 * is threaded as `isAuto` via ComputeGradedProjectionInput. Non-auto
 * path is BYTE-IDENTICAL to pre-Phase-2 (uses raw entry.baseMultiplier).
 *
 * Re-tune lever: when color-parallel data grows via eBay ingestion /
 * marketplace expansion, refit the exponent. Current 0.283 is conservative
 * (passes the over(1.0)=1.0 safety floor at the cost of a noisier R²).
 */
const AUTO_BASE_MULTIPLIER_EXPONENT = 0.283;

/**
 * CF-ESTIMATOR-PHASE-2 HIGH-TIER FIX (2026-06-15): the power-law
 * `mult^0.283` over-corrects above the Blue tier. Phase 2 recon
 * re-characterization confirmed the actual over-claim shape is a HUMP
 * (peaks at Blue/Green-Atomic, descends back to ~1.0× by Gold Refractor)
 * rather than the power law's monotonic-increase assumption. The
 * original fit was poisoned by 9 mis-tagged low-dollar high-tier
 * "Gold"/"Red" sales ($16-$293, almost certainly Cardsight beta-pipeline
 * mis-bucketed base autos) that the power law extrapolated through.
 *
 * Verified external anchor (Leo De Vries CPA-LD):
 *   Gold Refractor (mult 14.5×) PSA 10 = $8,100 ≈ uncorrected composed
 *   ($228.93 × 14.5 × 2.499 = $8,295) — over-claim ≈ 1.03× (raw is right)
 *
 * So at mult ≥ 14 we revert to the RAW table multiplier. Below 14 we
 * keep the power law correction (Blue $936 stays anchored; Gold Shimmer
 * mult 9.30 remains under-claimed at ~$1,075 vs verified ~$2,400 — an
 * ACCEPTED residual; the brief explicitly favors the conservative
 * threshold over a curve-fit on 2-3 data points).
 *
 * When color-parallel data for the mult 7-14 band grows (eBay ingestion
 * / marketplace expansion), the proper fix is a tapered correction
 * descending from the Blue peak to ~1.0 at Gold-Refractor; that's
 * deferred until enough verified high-tier sales exist to fit it.
 */
const AUTO_HIGH_TIER_THRESHOLD = 14;

function autoCorrectedBaseMultiplier(rawBaseMultiplier: number): number {
  if (!Number.isFinite(rawBaseMultiplier) || rawBaseMultiplier <= 0) return rawBaseMultiplier;
  // High-tier autos (Gold Refractor /50 and rarer) hold value — raw table
  // multiplier is verified correct against Leo Gold Refractor $8,100.
  // Revert to raw at and above the threshold.
  if (rawBaseMultiplier >= AUTO_HIGH_TIER_THRESHOLD) return rawBaseMultiplier;
  return Math.pow(rawBaseMultiplier, AUTO_BASE_MULTIPLIER_EXPONENT);
}
/** Release-curve cache + harvest tuning. */
const RELEASE_CURVE_TTL_SEC = 6 * 3600;
const RELEASE_HARVEST_CONCURRENCY = 5;
const RELEASE_SEARCH_TAKE = 25;

// ── Helpers ────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  const cleaned = values
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (cleaned.length === 0) return null;
  const m = Math.floor(cleaned.length / 2);
  return cleaned.length % 2 === 1
    ? cleaned[m]!
    : (cleaned[m - 1]! + cleaned[m]!) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** True when the record is a "base" record:
 *    parallel_id is null/undefined AND title carries no finish-qualifier
 *    tokens (per parallelTitleMatch's isBaseTitle predicate). */
function isBaseRecord(r: CardsightSaleRecord): boolean {
  if (r.parallel_id != null) return false;
  return isBaseTitle(r.title);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── CF-ESTIMATOR-PHASE-1 observed-anchor helpers ───────────────────────────
//
// findSameParallelObservedAnchor / findSiblingParallelObservedAnchor walk
// pricing.raw + pricing.graded to find the most defensible observed sale
// to anchor on, derive a parallel-raw equivalent for the target parallel,
// and report the metadata needed for basis prose + tier classification.
//
// Both return null when no usable candidate exists; the caller falls
// through to composed (if base-raw passes the trust floor) or no-data.
//
// Rules:
//   • "raw equivalent" = sale.price / graderPremium(sale.grade) when
//     the sale is graded, else sale.price. Coerces graded sales into
//     a parallel-raw axis so the per-grade loop can apply target-grade
//     multipliers consistently.
//   • Sibling: requires lookupMultiplier(siblingParallelName) AND
//     lookupMultiplier(targetParallelName) BOTH non-null, so the
//     parallel ratio (target_mult / sibling_mult) is a real number,
//     not an absolute multiplier hiding as a ratio. If either side
//     doesn't resolve, the sibling is skipped (the "ratios cancel"
//     property the brief depends on requires both ends in the table).
//   • "Nearest" sibling: minimize |target_mult − sibling_mult|. Then
//     nearest grade by graderPremium numeric distance. Then most recent.

interface ObservedAnchorCandidate {
  /** The sale's value coerced into target-parallel-raw axis. */
  parallelRawEquivalent: number;
  /** The actual sale we picked. */
  sourceSale: {
    price: number;
    date: string | null;
    title: string;
  };
  /** Detected grade label ("PSA 10", "BGS 9.5") or null if raw. */
  saleGradeLabel: string | null;
  /** Sale grade's GRADER_PREMIUMS value (1.0 when raw). */
  saleGradePremium: number;
  /** Age of the sale in whole days from now, or null when date is missing/unparseable. */
  ageDays: number | null;
  /** Name of the sibling parallel (null for same-parallel picks). */
  siblingParallelName: string | null;
  /** target_mult / source_mult (1.0 when same-parallel). */
  parallelRatio: number;
  /** The source-side baseMultiplier from lookupMultiplier (target-mult for same). */
  sourceMultiplier: number;
  /** The target-side baseMultiplier from lookupMultiplier. */
  targetMultiplier: number;
}

function parseSaleDateToAgeDays(date: string | null | undefined): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return null;
  const age = (Date.now() - t) / (24 * 60 * 60 * 1000);
  return age < 0 ? 0 : Math.round(age);
}

function detectRecordGrade(co: string, gradeValue: unknown, title: string | null | undefined): string | null {
  // Prefer the bucket's company/grade tag (more reliable than title parsing).
  const coTrim = String(co ?? "").toUpperCase().trim();
  const gradeStr = String(gradeValue ?? "").trim();
  if (coTrim && gradeStr) return `${coTrim} ${gradeStr}`;
  // Fallback to title parsing.
  if (!title) return null;
  const det = detectGradeFromTitle(title);
  return det ? `${det.company} ${det.grade}` : null;
}

/**
 * Walk pricing for sales tagged to OR titled as the target parallel; pick
 * the most recent, prefer raw over graded. Returns the parallel-raw
 * equivalent (graded sales coerced via getGraderPremium) plus metadata.
 */
/**
 * CF-GRADED-PRECEDENCE-OBSERVED (2026-06-15): caller-side observed-parallel-
 * raw lookup for graded-scope requests. Used by
 * compileGradedEstimatesForCard to compute a parallel-raw anchor median
 * the engine's existing "parallel-observed" short-circuit can consume on
 * graded scope (it already consumes the equivalent on raw scope via
 * estimate.fairMarketValue). Composed remains the fallback when this
 * returns null.
 *
 * Selector logic:
 *   1. Records WITH parallel_id === targetParallelId — definitive, always
 *      included (Cardsight already classified them).
 *   2. Records WITH parallel_id !== targetParallelId — skipped (Cardsight
 *      classified them as a DIFFERENT parallel; do not title-rebucket).
 *   3. Records WITH parallel_id == null — title-matched against the
 *      canonical buildParallelTitleMatcher (word-boundary + catalog-
 *      derived sibling exclusion + finish-vocab span backstop). This is
 *      the same matcher resolver-side parallelTitleMatch uses, so the
 *      "Blue Refractor" $1,183 sale is included but "Blue Wave Refractor"
 *      / "Reptilian Blue Refractor" titles are excluded via the
 *      distinguishing-token guard.
 *
 * Median (not most-recent): approximates what the raw-scope FMV the
 * engine would compute for the same parallel, so graded-scope and
 * raw-scope rails stay coherent on multi-sale parallels. n=1 collapses
 * to the single value (Blue case).
 *
 * CF-GRADED-PRECEDENCE-FLOOR (2026-06-15): cheap-raw / mis-tag guard.
 * Reject the observed median when it isn't clearly above base raw
 * (< base × OBSERVED_PARALLEL_RAW_PREMIUM_FLOOR). A numbered parallel
 * that "sold raw" at ~base price is either Cardsight-mis-tagged base
 * (the base card sold, but the record got tagged to a parallel pid) or
 * an unreliably-cheap raw sale (chase buyer didn't price the scarcity).
 * In both cases composed (base × parallel-multiplier) is the more
 * predictive anchor for the graded tier, where the parallel's scarcity
 * premium DOES show up. The floor reverts those cases to composed.
 *
 * Returns null when no records survive the selector OR when the floor
 * rejects the observed median — composed remains the fallback in both
 * cases via the engine's existing precedence.
 */
const OBSERVED_PARALLEL_RAW_PREMIUM_FLOOR = 1.3;

/**
 * CF-PARALLEL-PLURAL-NORMALIZE (2026-06-16): a parallel's "canonical key"
 * is its sorted token set after singularization (tokenizeParallel applies
 * the singularize step). Two siblings that catalog the same physical
 * parallel under singular AND plural names (e.g. "Refractor" + "Refractors",
 * "Speckle Refractor" + "Speckle Refractors") collapse to one key here,
 * so the pooler treats them as equivalent identities.
 */
function canonicalParallelKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const tokens = tokenizeParallel(name);
  if (tokens.length === 0) return null;
  return [...tokens].sort().join("|");
}

/**
 * CF-FITTED-RANGE-PROVENANCE-FIX (2026-06-17): single source of truth
 * for "does this parallel have qualifying observed comps?". Returns the
 * count + median of raw records that:
 *   (a) match the target parallel via canonical-equivalent pid OR strict
 *       title match (CF-PARALLEL-PLURAL-NORMALIZE + the resolver-side
 *       buildParallelTitleMatcher with sibling-distinguishing exclusion),
 *   (b) survive the cheap-raw / mis-tag floor (price ≥ baseRawMedian ×
 *       1.3) — same filter the precedence fix uses.
 *
 * Graded sales are NOT counted: they don't inform the parallel-raw
 * anchor and the sufficiency tier asks "do we have raw comps that
 * actually drove the engine's number?". The provenance bug surfaced by
 * the verify CF was exactly this — counting graded + below-floor raw
 * inflated the comp count and produced "Based on N sales" labels next
 * to fitted-curve numbers. Now BOTH the engine's anchoring AND the
 * post-loop sufficiency labeling read from this one helper.
 */
export interface ObservedParallelCompPool {
  /** Count of raw records that survived the floor + matched the parallel. */
  n: number;
  /** Median of those records — null when n=0. */
  median: number | null;
}

export function getObservedParallelCompPool(
  pricing: CardsightPricingResponse,
  targetParallelId: string,
  targetParallelName: string | null | undefined,
  siblingParallels: ReadonlyArray<{ id: string; name: string }>,
  baseRawMedian: number | null,
): ObservedParallelCompPool {
  const targetCanonical = canonicalParallelKey(targetParallelName);
  const equivalentIds = new Set<string>([targetParallelId]);
  if (targetCanonical) {
    for (const s of siblingParallels) {
      if (s.id === targetParallelId) continue;
      if (canonicalParallelKey(s.name) === targetCanonical) {
        equivalentIds.add(s.id);
      }
    }
  }

  const prices: number[] = [];

  // 1. Tagged raw records — definitive pid match (target + canonical
  //    equivalents).
  for (const r of (pricing.raw?.records ?? [])) {
    if (r.parallel_id == null) continue;
    if (!equivalentIds.has(r.parallel_id)) continue;
    const p = Number(r.price);
    if (!Number.isFinite(p) || p <= 0) continue;
    prices.push(p);
  }

  // 2. Untagged raw records (parallel_id == null) — strict title match.
  if (targetParallelName) {
    const built = buildParallelTitleMatcher(targetParallelName, siblingParallels, {
      matchedParallelId: targetParallelId,
    });
    if (built) {
      for (const r of (pricing.raw?.records ?? [])) {
        if (r.parallel_id != null) continue;
        if (!built.matches(r.title)) continue;
        const p = Number(r.price);
        if (!Number.isFinite(p) || p <= 0) continue;
        prices.push(p);
      }
    }
  }

  // 3. Cheap-raw / mis-tag floor — filter individual records, not the
  //    median (the provenance fix). A pool with some sub-floor records
  //    + some legit records keeps the legit ones; pre-fix the helper
  //    rejected the entire pool if its median fell below floor, which
  //    coupled two unrelated decisions (per-record validity vs aggregate).
  let survivors = prices;
  if (baseRawMedian != null && baseRawMedian > 0) {
    const floor = baseRawMedian * OBSERVED_PARALLEL_RAW_PREMIUM_FLOOR;
    survivors = prices.filter((p) => p >= floor);
  }

  return { n: survivors.length, median: median(survivors) };
}

/**
 * Backward-compatible wrapper — preserves the existing public signature
 * for `compileGradedEstimatesForCard` and any external callers, but now
 * delegates to the unified pool helper so the engine's anchor decision
 * and the post-loop sufficiency labeling are guaranteed to agree.
 */
export function computeSameParallelRawMedian(
  pricing: CardsightPricingResponse,
  targetParallelId: string,
  targetParallelName: string | null | undefined,
  siblingParallels: ReadonlyArray<{ id: string; name: string }>,
): number | null {
  const baseRawRecords = (pricing.raw?.records ?? []).filter(isBaseRecord);
  const baseRawMedian = median(baseRawRecords.map((r) => Number(r.price)));
  const pool = getObservedParallelCompPool(
    pricing,
    targetParallelId,
    targetParallelName,
    siblingParallels,
    baseRawMedian,
  );
  return pool.median;
}

/**
 * CF-FITTED-RANGE-LAYER (2026-06-17): within-card premium — median of
 * (observed_parallel_raw / curve_predicted_parallel_raw) across the
 * card's parallels that have observed comps. Bounded to [1.0, 3.0];
 * defaults to 1.0 when the card has no observed parallels. Applied only
 * to the UPPER bound of compSufficiency="none" results (top tier) so a
 * Leo /1 ballpark can stretch toward market reality without shifting
 * the central point or the lower bound.
 *
 * Floor at 1.0× because we never want to widen DOWNWARD — the conservative
 * move is "the card's observed parallels trade at-or-above the pooled
 * curve, so the upper end may also". A card whose observed parallels
 * UNDER-trade the curve gets cardPremium=1.0 (no widening), not <1.0.
 */
const CARD_PREMIUM_FLOOR = 1.0;
const CARD_PREMIUM_CEILING = 3.0;

export function computeCardPremium(
  pricing: CardsightPricingResponse,
  cardParallels: ReadonlyArray<{ id: string; name: string; numberedTo?: number | null }>,
  baseRawMedian: number | null,
): number {
  if (!cardParallels || cardParallels.length === 0) return CARD_PREMIUM_FLOOR;
  if (baseRawMedian == null || baseRawMedian <= 0) return CARD_PREMIUM_FLOOR;
  const ratios: number[] = [];
  for (const p of cardParallels) {
    const fitted = computeFittedComposedMultiplier(p.name, p.numberedTo);
    if (!fitted) continue;
    const predicted = baseRawMedian * fitted.multiplier;
    if (!Number.isFinite(predicted) || predicted <= 0) continue;
    const observed = computeSameParallelRawMedian(
      pricing,
      p.id,
      p.name,
      cardParallels,
    );
    if (observed == null || observed <= 0) continue;
    ratios.push(observed / predicted);
  }
  if (ratios.length === 0) return CARD_PREMIUM_FLOOR;
  const m = median(ratios);
  if (m == null || !Number.isFinite(m)) return CARD_PREMIUM_FLOOR;
  return Math.max(CARD_PREMIUM_FLOOR, Math.min(CARD_PREMIUM_CEILING, m));
}

function findSameParallelObservedAnchor(
  pricing: CardsightPricingResponse,
  targetParallelId: string,
  targetParallelName: string | null | undefined,
  targetMultiplier: number,
): ObservedAnchorCandidate | null {
  const candidates: Array<{
    record: CardsightSaleRecord;
    saleGradeLabel: string | null;
    saleGradePremium: number;
    rawEquivalent: number;
  }> = [];

  // Lax matcher kept for the existing same-parallel-observed anchor path
  // (decision-B): pid OR contains-all-tokens. This path only fires when
  // base-raw is below the trust floor (Konnor-shape cards), where the
  // over-permissive title match has historically not been load-bearing
  // because composed wins for cards with strong tier-1. The new
  // computeSameParallelRawMedian above uses the STRICTER catalog-derived
  // matcher to avoid leaking sibling parallels into the graded-scope
  // anchor.
  const tokens = targetParallelName ? tokenizeParallel(targetParallelName) : [];
  const patterns = tokens.map((t) => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"));
  const matchesTarget = (r: CardsightSaleRecord): boolean => {
    if (r.parallel_id === targetParallelId) return true;
    if (patterns.length > 0) {
      const title = r.title ?? "";
      return patterns.every((p) => p.test(title));
    }
    return false;
  };

  // Raw records
  for (const r of (pricing.raw?.records ?? [])) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    if (!matchesTarget(r)) continue;
    candidates.push({
      record: r,
      saleGradeLabel: null,
      saleGradePremium: 1.0,
      rawEquivalent: Number(r.price),
    });
  }
  // Graded records — every (company, grade) bucket
  for (const co of (pricing.graded ?? [])) {
    const coName = String(co.company_name ?? "").toUpperCase().trim();
    if (!coName) continue;
    for (const g of (co.grades ?? [])) {
      const gradeStr = String(g.grade_value ?? "").trim();
      if (!gradeStr) continue;
      const premium = getGraderPremium(coName, gradeStr);
      if (!(premium > 0)) continue;
      const label = `${coName} ${gradeStr}`;
      for (const r of (g.records ?? [])) {
        if (!Number.isFinite(r.price) || r.price <= 0) continue;
        if (!matchesTarget(r)) continue;
        candidates.push({
          record: r,
          saleGradeLabel: label,
          saleGradePremium: premium,
          rawEquivalent: Number(r.price) / premium,
        });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Sort: raw before graded (saleGradeLabel null first), then most recent.
  candidates.sort((a, b) => {
    const aIsRaw = a.saleGradeLabel == null ? 1 : 0;
    const bIsRaw = b.saleGradeLabel == null ? 1 : 0;
    if (aIsRaw !== bIsRaw) return bIsRaw - aIsRaw;
    const aDate = String(a.record.date ?? "");
    const bDate = String(b.record.date ?? "");
    return bDate.localeCompare(aDate);
  });
  const best = candidates[0]!;
  return {
    parallelRawEquivalent: best.rawEquivalent,
    sourceSale: {
      price: Number(best.record.price),
      date: best.record.date ?? null,
      title: best.record.title ?? "",
    },
    saleGradeLabel: best.saleGradeLabel,
    saleGradePremium: best.saleGradePremium,
    ageDays: parseSaleDateToAgeDays(best.record.date),
    siblingParallelName: null,
    parallelRatio: 1.0,
    sourceMultiplier: targetMultiplier,
    targetMultiplier,
  };
}

/**
 * Walk pricing for sibling-parallel sales (parallel_id != null AND !=
 * target), ratio-adjust to the target parallel via lookupMultiplier on
 * both ends. Skips any sibling whose parallel name doesn't resolve in
 * the multiplier table — those couldn't cancel cleanly. Picks by
 * minimum |target_mult − sibling_mult|, then by parallel-raw axis
 * proximity to the resulting value space (effectively: prefer recent +
 * matching grade), then most recent.
 */
function findSiblingParallelObservedAnchor(
  pricing: CardsightPricingResponse,
  targetParallelId: string,
  targetParallelName: string | null | undefined,
  targetMultiplier: number,
  cardParallels: ReadonlyArray<{ id: string; name: string }>,
): ObservedAnchorCandidate | null {
  // Build parallels lookup: parallel_id → parallel name → multiplier.
  // Parallels come from getCardDetail (passed in by the caller) because
  // pricing.card.parallels[] is not on the CardsightPricingCard shape;
  // CardsightCardDetail.parallels is.
  const parallelMultByPid = new Map<string, { name: string; mult: number }>();
  for (const p of cardParallels) {
    const pid = p?.id;
    const name = p?.name;
    if (!pid || !name || pid === targetParallelId) continue;
    const entry = lookupMultiplier(name);
    if (!entry || !(entry.baseMultiplier > 0)) continue;
    parallelMultByPid.set(pid, { name, mult: entry.baseMultiplier });
  }
  if (parallelMultByPid.size === 0) return null;

  interface SiblingCandidate {
    record: CardsightSaleRecord;
    siblingName: string;
    siblingMult: number;
    saleGradeLabel: string | null;
    saleGradePremium: number;
    rawEquivalentSibling: number;   // sale value coerced to sibling-raw axis
    rawEquivalentTarget: number;    // then scaled to target-parallel-raw via mult ratio
    distance: number;               // |target_mult − siblingMult|
  }

  const candidates: SiblingCandidate[] = [];

  // Raw sibling records
  for (const r of (pricing.raw?.records ?? [])) {
    if (!Number.isFinite(r.price) || r.price <= 0) continue;
    const pid = r.parallel_id;
    if (!pid) continue;
    const sib = parallelMultByPid.get(pid);
    if (!sib) continue;
    const ratio = targetMultiplier / sib.mult;
    candidates.push({
      record: r,
      siblingName: sib.name,
      siblingMult: sib.mult,
      saleGradeLabel: null,
      saleGradePremium: 1.0,
      rawEquivalentSibling: Number(r.price),
      rawEquivalentTarget: Number(r.price) * ratio,
      distance: Math.abs(targetMultiplier - sib.mult),
    });
  }

  // Graded sibling records
  for (const co of (pricing.graded ?? [])) {
    const coName = String(co.company_name ?? "").toUpperCase().trim();
    if (!coName) continue;
    for (const g of (co.grades ?? [])) {
      const gradeStr = String(g.grade_value ?? "").trim();
      if (!gradeStr) continue;
      const premium = getGraderPremium(coName, gradeStr);
      if (!(premium > 0)) continue;
      const label = `${coName} ${gradeStr}`;
      for (const r of (g.records ?? [])) {
        if (!Number.isFinite(r.price) || r.price <= 0) continue;
        const pid = r.parallel_id;
        if (!pid) continue;
        const sib = parallelMultByPid.get(pid);
        if (!sib) continue;
        const ratio = targetMultiplier / sib.mult;
        const siblingRaw = Number(r.price) / premium;
        candidates.push({
          record: r,
          siblingName: sib.name,
          siblingMult: sib.mult,
          saleGradeLabel: label,
          saleGradePremium: premium,
          rawEquivalentSibling: siblingRaw,
          rawEquivalentTarget: siblingRaw * ratio,
          distance: Math.abs(targetMultiplier - sib.mult),
        });
      }
    }
  }
  if (candidates.length === 0) return null;

  // Sort by mult distance, then most recent.
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const aDate = String(a.record.date ?? "");
    const bDate = String(b.record.date ?? "");
    return bDate.localeCompare(aDate);
  });
  const best = candidates[0]!;
  return {
    parallelRawEquivalent: best.rawEquivalentTarget,
    sourceSale: {
      price: Number(best.record.price),
      date: best.record.date ?? null,
      title: best.record.title ?? "",
    },
    saleGradeLabel: best.saleGradeLabel,
    saleGradePremium: best.saleGradePremium,
    ageDays: parseSaleDateToAgeDays(best.record.date),
    siblingParallelName: best.siblingName,
    parallelRatio: targetMultiplier / best.siblingMult,
    sourceMultiplier: best.siblingMult,
    targetMultiplier,
  };
}

// CF-COMP-SPARSITY-STALENESS-FILTER (2026-06-29): a singleton observation
// older than this threshold is NOT credibly observed. Mirrors CH's own
// confidence_grade=C signaling (Mays 1959 PSA 10 was 224d stale at
// support=1 when CH itself flagged it C-grade). The threshold lives here
// so countObservedInScope and extractObservedGradeValues share one
// definition of "credibly observed" — both must agree, else a grade
// could be rail-skipped (treated observed) but absent from R-selection
// (treated unobserved) or vice versa.
const STALE_SINGLETON_CUTOFF_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * Apply the n=1 staleness filter. A grade with multiple sales is always
 * credible (corroboration). A grade with a single sale is credible only
 * if that sale is recent. n=1 with no parsable date is NOT credible —
 * defensive default; an undated outlier is the case we most want to
 * exclude.
 *
 * Returns the filtered record array (the empty array means "not
 * credibly observed").
 */
export function filterCredibleObserved(
  records: ReadonlyArray<CardsightSaleRecord>,
  nowMs: number = Date.now(),
): CardsightSaleRecord[] {
  if (records.length === 0) return [];
  if (records.length >= 2) return [...records];
  const r = records[0]!;
  if (!r.date) return [];
  const t = Date.parse(r.date);
  if (!Number.isFinite(t)) return [];
  if (nowMs - t > STALE_SINGLETON_CUTOFF_DAYS * DAY_MS) return [];
  return [r];
}

/**
 * CF-GRADED-PRICE-PROJECTION (2026-06-12) — observed-first precedence GUARD.
 *
 * Counts the OBSERVED comps a target grade carries within the requested
 * scope (base or parallel). The estimator NEVER emits a result when this
 * returns > 0 — observed data always wins; the estimator fills gaps,
 * never competes with real sales.
 *
 * Scope rules:
 *   - BASE target (no parallelId): count records that pass `isBaseRecord`
 *     (parallel_id null AND title carries no finish-vocab tokens).
 *   - PARALLEL target: count records that match the parallel by EITHER
 *       (a) `parallel_id === targetParallelId` (strict Cardsight tag), OR
 *       (b) title contains ALL user-parallel tokens as word-boundary
 *           matches (covers untagged parallels — Cardsight's tagging is
 *           unreliable for many cards; see cardsight.client.ts:513-522).
 *     This intentionally over-counts toward "observed" — better to skip
 *     a justified estimate than to overlay one on real data.
 *
 * CF-COMP-SPARSITY-STALENESS-FILTER (2026-06-29): post-scope, apply the
 * singleton-staleness filter. A grade backed by a single sale older than
 * STALE_SINGLETON_CUTOFF_DAYS counts as UNOBSERVED — the rail then
 * estimates it via R-scaling, surfacing a credible value instead of
 * the stale outlier.
 */
/**
 * CF-GEM-RATE-WIRED (Drew, 2026-07-15, PR #495 follow-up).
 * Walks pricing.graded ONCE and builds a per-card gem-rate signal from the
 * observed base-scope graded sales. Base-scope only — gem-rate math on a
 * parallel-scoped subset would blow up variance (a Blue Refractor /150 has
 * ~5-15 sales total; a single PSA 10 tilts the rate 20 points). Signal
 * lives at the card level and applies to every target grade the loop calls
 * `getGraderPremium` for.
 */
export function buildGemRateSignalFromPricing(
  pricing: CardsightPricingResponse,
  cardId: string | null,
): GemRateSignal | null {
  const observations: { grade: string; price: number }[] = [];
  for (const co of (pricing.graded ?? [])) {
    const coName = String(co.company_name ?? "").toUpperCase().trim();
    if (!coName) continue;
    for (const g of (co.grades ?? [])) {
      const gradeVal = g.grade_value;
      if (gradeVal === null || gradeVal === undefined) continue;
      const gradeStr = String(gradeVal).trim();
      if (!gradeStr) continue;
      const label = `${coName} ${gradeStr}`;
      for (const rec of (g.records ?? [])) {
        if (!isBaseRecord(rec)) continue;
        const price = typeof rec.price === "number" ? rec.price : Number(rec.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        observations.push({ grade: label, price });
      }
    }
  }
  if (observations.length === 0) return null;
  return computeGemRateFromObservations(observations, { cardId, windowDays: 365 });
}

function countObservedInScope(
  pricing: CardsightPricingResponse,
  company: string,
  grade: string,
  targetParallelId: string | null | undefined,
  targetParallelName: string | null | undefined,
): number {
  const records = selectSalesByGrade(pricing, `${company} ${grade}`);
  if (records.length === 0) return 0;

  let scope: CardsightSaleRecord[];
  // BASE scope
  if (!targetParallelId) {
    scope = records.filter(isBaseRecord);
  } else {
    // PARALLEL scope — strict tag first
    const strict = records.filter((r) => r.parallel_id === targetParallelId);
    if (strict.length > 0) {
      scope = strict;
    } else if (targetParallelName) {
      // PARALLEL scope — title-token fallback (untagged Cardsight records)
      const tokens = tokenizeParallel(targetParallelName);
      if (tokens.length === 0) return 0;
      const patterns = tokens.map(
        (t) => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"),
      );
      scope = records.filter((r) => {
        const title = r.title ?? "";
        return patterns.every((p) => p.test(title));
      });
    } else {
      return 0;
    }
  }
  return filterCredibleObserved(scope).length;
}

// ── Anchor resolution ──────────────────────────────────────────────────────

interface ResolvedAnchor {
  price: number | null;
  kind: GradedProjectionAnchorKind;
  description: string;
  /**
   * CF-ESTIMATOR-PHASE-1: present only for "parallel-observed-same" and
   * "parallel-observed-sibling" kinds. The per-grade loop branches on
   * this to bypass resolveRatio (which would re-apply tier-1/2/2b/3
   * cascade and stack noise on the already-anchored value); instead it
   * applies getGraderPremium directly per target grade. The basis
   * builder also consumes these fields to render scope-labeled prose.
   */
  observedSource?: ObservedAnchorCandidate;
  /**
   * CF-FITTED-LADDER (2026-06-16): set on the composed branch when the
   * fitted (serial, finish) cell is unobserved, finish has no fitted
   * modifier, or serial ≤ 50 (top-tier player-desirability residual).
   * Per-grade loop maps this to confidenceTier="ballpark" + ballpark
   * spread/rounding for any grade projected off the anchor.
   */
  lowConfidence?: boolean;
  /**
   * CF-FITTED-LADDER (2026-06-16): the resolved print run (numberedTo)
   * used to compute the fitted composed multiplier. Read by the per-
   * grade loop to look up the PSA 10 per-bucket ratio.
   */
  serial?: number | null;
}

function resolveAnchor(
  baseRawMedian: number | null,
  baseRawSampleCount: number,
  opts: {
    targetParallelId?: string | null;
    targetParallelRawFmv?: number | null;
    targetParallelRawFmvSource?: "fmv" | "last-sale";
    targetParallelRawFmvAgeDays?: number | null;
    targetParallelName?: string | null;
    pricing?: CardsightPricingResponse;
    /**
     * CF-ESTIMATOR-PHASE-1: card-level parallels[] for sibling resolution.
     * Sourced from getCardDetail at the caller (pricing.card.parallels[]
     * doesn't exist on CardsightPricingCard). Required for the sibling-
     * observed branch; safe to omit for same-parallel-observed and
     * composed paths.
     */
    cardParallels?: ReadonlyArray<{ id: string; name: string; numberedTo?: number | null }>;
    /**
     * CF-ESTIMATOR-PHASE-2: auto-base detection signal. Applied ONLY in
     * the parallel-composed branch (line ~725) — not in sibling-anchor
     * (raw ratios must be preserved per Phase 1 invariant).
     */
    isAuto?: boolean;
  },
): ResolvedAnchor {
  // Parallel target
  if (opts.targetParallelId) {
    // Parallel-observed: caller provided a parallel-raw anchor
    const pf = opts.targetParallelRawFmv;
    if (typeof pf === "number" && Number.isFinite(pf) && pf > 0) {
      // CF-ANCHOR-PRECEDENCE (2026-06-14): when the anchor came from the
      // last-sale slot (iOS thin-data path), the basis prose names it and
      // its age so the thin/stale provenance is visible — never hidden
      // behind generic "parallel raw anchor" phrasing.
      const source = opts.targetParallelRawFmvSource ?? "fmv";
      if (source === "last-sale") {
        const ageDays = opts.targetParallelRawFmvAgeDays;
        const agePhrase =
          ageDays != null && Number.isFinite(ageDays) && ageDays >= 0
            ? `, ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? "" : "s"} ago`
            : "";
        return {
          price: pf,
          kind: "parallel-observed",
          description: `anchored on the last sale ${fmtUSD(pf)}${agePhrase} (single observed parallel sale; thin pool)`,
        };
      }
      return {
        price: pf,
        kind: "parallel-observed",
        description: `parallel raw anchor ${fmtUSD(pf)} (observed single-sale or thin pool)`,
      };
    }

    // CF-ESTIMATOR-PHASE-1 (2026-06-14): hybrid precedence, decision (B).
    // Selection order in the parallel-target branch, top to bottom:
    //   (a) composed                  — when baseRawSampleCount >= floor
    //                                   (the card has a well-calibrated
    //                                   tier-1 path; trust it)
    //   (b) same-parallel observed    — pid OR title-token match
    //                                   (real sale in the exact parallel)
    //   (c) sibling-parallel observed — nearest-mult sibling with both
    //                                   ends in the multiplier table
    //   (d) none
    // Why (B) over (A): rule "same-parallel always wins" preempted Leo
    // (base-raw n=22, strong tier-1 signal) onto a single title-matched
    // $285 raw sale, dropping his rail ~60%. Decision (B) keeps composed
    // when the base-raw pool is reliable, so cards with strong per-card
    // calibration (Leo) stay byte-identical; cards with degenerate
    // base-raw (Konnor n=1) fall through composed and pick up the
    // sibling/same-parallel paths.
    //
    // Phase 2 caveat: the composed path uses Chrome-Draft absolute
    // multipliers calibrated against NON-AUTO base. For prospect-auto
    // numbered parallels (CPA-LD, CPA-KG, etc.) the multiplier is
    // inflated — same root cause as Konnor's PSA 10 $9,040 overclaim;
    // Leo's PSA 10 $3,260 is also (smaller) inflation by the same
    // mechanism. Phase 2 will recalibrate or branch the multiplier by
    // is-auto, which will move Leo too. Decision (B) intentionally
    // doesn't sweep that fix into Phase 1.
    const targetEntry = opts.targetParallelName ? lookupMultiplier(opts.targetParallelName) : null;
    const targetMult =
      targetEntry && Number.isFinite(targetEntry.baseMultiplier) && targetEntry.baseMultiplier > 0
        ? targetEntry.baseMultiplier
        : null;

    // (a) Composed — when base-raw passes the trust floor.
    //
    // CF-FITTED-LADDER (2026-06-16): swap the chrome-draft heuristic
    // multiplier table + Phase-2 power-law patch (mult^0.283) + high-tier
    // auto-revert (mult ≥ 14 → raw) for the empirical fitted curve from
    // CF-LADDER-FIT. New multiplier = f(serial) · g(finish), parsed from
    // detail.parallels.{numberedTo, name} via cardParallels. The
    // observed-wins precedence in decision (B) is preserved unchanged —
    // composed only fires when no parallel-raw FMV was threaded in and
    // base-raw passes the trust floor.
    //
    // CF-DEVRIES-FIX (2026-06-21): restore the auto-base correction in
    // this branch. CF-FITTED-LADDER (2026-06-16) retired
    // `autoCorrectedBaseMultiplier` here on the premise that the fitted
    // ladder produced calibrated multipliers. CF-DEVRIES-RECON verified
    // the fitted ladder emits the SAME 5.700× for Blue /150 the
    // heuristic table did — the retirement removed the correction
    // without the fitted ladder actually correcting anything. Result:
    // Leo De Vries PSA 10 over-claimed $3,260 vs observed $664 (4.91×
    // over-claim). The canonical anchor at line 323 ("Leo PSA 10
    // $3,260 → $937") is now re-honored.
    //
    // Surface scope verified (CF-DEVRIES-RECON):
    //   - sibling-observed-anchor (b/c below): by-design uncorrected;
    //     ratios cancel the correction (preserved unchanged).
    //   - predictedRangeMultiplierAnchored.ts:248-250: still applies the
    //     correction in its composed branch (verified positively).
    //   - this composed branch: regressed — restored now.
    const targetParallelEntry = opts.cardParallels?.find((p) => p.id === opts.targetParallelId);
    const targetNumberedTo = targetParallelEntry?.numberedTo ?? null;
    if (
      baseRawMedian !== null
      && baseRawMedian > 0
      && baseRawSampleCount >= BASE_RAW_TRUST_FLOOR
      && opts.targetParallelName
    ) {
      const fitted = computeFittedComposedMultiplier(opts.targetParallelName, targetNumberedTo);
      if (fitted) {
        const effectiveMultiplier = opts.isAuto
          ? autoCorrectedBaseMultiplier(fitted.multiplier)
          : fitted.multiplier;
        const composed = round2(baseRawMedian * effectiveMultiplier);
        const correctionNote = opts.isAuto && effectiveMultiplier !== fitted.multiplier
          ? ` → corrected ${effectiveMultiplier.toFixed(3)}× via mult^${AUTO_BASE_MULTIPLIER_EXPONENT} (auto-base)`
          : "";
        return {
          price: composed,
          kind: "parallel-composed",
          description: `composed parallel anchor ${fmtUSD(composed)} = base raw median ${fmtUSD(baseRawMedian)} (n=${baseRawSampleCount}) × ${fitted.basis}${correctionNote}`,
          lowConfidence: fitted.lowConfidence,
          serial: fitted.serial,
        };
      }
      // Fitted path needs numberedTo to fire. When the catalog omits it
      // (rare on BCPA — most parallels carry their print run), fall
      // through to the legacy table path below as a safety net so we
      // don't regress to no-data on missing-metadata edge cases.
      if (
        targetEntry
        && Number.isFinite(targetEntry.baseMultiplier)
        && targetEntry.baseMultiplier > 0
      ) {
        const rawMult = targetEntry.baseMultiplier;
        const effectiveMult = opts.isAuto ? autoCorrectedBaseMultiplier(rawMult) : rawMult;
        const composed = round2(baseRawMedian * effectiveMult);
        const correctionNote = opts.isAuto && effectiveMult !== rawMult
          ? ` → corrected ${effectiveMult.toFixed(3)}× via mult^${AUTO_BASE_MULTIPLIER_EXPONENT} (auto-base)`
          : "";
        return {
          price: composed,
          kind: "parallel-composed",
          description: `composed parallel anchor ${fmtUSD(composed)} = base raw median ${fmtUSD(baseRawMedian)} (n=${baseRawSampleCount}) × ${targetEntry.parallelName} multiplier ${rawMult.toFixed(3)}×${correctionNote} [legacy table fallback — numberedTo missing for fitted path]`,
          lowConfidence: true,
        };
      }
    }

    // (b) Same-parallel observed — pid OR title-token match. Demoted
    // below composed in decision (B) so cards with strong tier-1 base
    // calibration don't get re-anchored on a single title-matched sale.
    if (opts.pricing && opts.targetParallelName && targetMult != null) {
      const sameParallel = findSameParallelObservedAnchor(
        opts.pricing,
        opts.targetParallelId,
        opts.targetParallelName,
        targetMult,
      );
      if (sameParallel) {
        const saleSlug = sameParallel.saleGradeLabel ? `${sameParallel.saleGradeLabel} sale` : "raw sale";
        const ageBit =
          sameParallel.ageDays != null
            ? `, ${sameParallel.ageDays}d ago`
            : "";
        return {
          price: round2(sameParallel.parallelRawEquivalent),
          kind: "parallel-observed-same",
          description:
            `anchored on a ${opts.targetParallelName} ${saleSlug} of `
            + `${fmtUSD(sameParallel.sourceSale.price)}${ageBit}; coerced to parallel-raw axis `
            + `(÷ ${sameParallel.saleGradePremium.toFixed(2)}× grade premium)`,
          observedSource: sameParallel,
        };
      }
    }

    // (c) Sibling-parallel observed — fires when composed unavailable
    // (base-raw n below floor) AND no same-parallel candidate exists.
    if (
      opts.pricing
      && opts.targetParallelName
      && targetMult != null
      && opts.cardParallels
      && opts.cardParallels.length > 0
    ) {
      const sibling = findSiblingParallelObservedAnchor(
        opts.pricing,
        opts.targetParallelId,
        opts.targetParallelName,
        targetMult,
        opts.cardParallels,
      );
      if (sibling) {
        const saleSlug = sibling.saleGradeLabel ? `${sibling.saleGradeLabel} sale` : "raw sale";
        const ageBit =
          sibling.ageDays != null
            ? `, ${sibling.ageDays}d ago`
            : "";
        return {
          price: round2(sibling.parallelRawEquivalent),
          kind: "parallel-observed-sibling",
          description:
            `anchored on a ${sibling.siblingParallelName} ${saleSlug} of `
            + `${fmtUSD(sibling.sourceSale.price)}${ageBit}; ratio-adjusted to `
            + `${opts.targetParallelName} (parallel ratio `
            + `${sibling.targetMultiplier.toFixed(2)}/${sibling.sourceMultiplier.toFixed(2)} = `
            + `${sibling.parallelRatio.toFixed(3)}×) and coerced to parallel-raw axis `
            + `(÷ ${sibling.saleGradePremium.toFixed(2)}× grade premium)`,
          observedSource: sibling,
        };
      }
    }

    return {
      price: null,
      kind: "none",
      description: `no parallel anchor (no observed same-parallel sale, base-raw n=${baseRawSampleCount} below trust floor ${BASE_RAW_TRUST_FLOOR}, no sibling with a resolvable multiplier)`,
    };
  }
  // Base target
  if (baseRawMedian !== null) {
    return {
      price: baseRawMedian,
      kind: "base",
      description: `base raw median ${fmtUSD(baseRawMedian)} (n=${baseRawSampleCount})`,
    };
  }
  return {
    price: null,
    kind: "none",
    description: `no base raw anchor`,
  };
}

// ── Ratio resolution ───────────────────────────────────────────────────────

interface ResolvedRatio {
  ratio: number | null;
  source: GradedProjectionRatioSource;
  description: string;
  cardSpecificBaseSamples: number;
  targetGradeBaseMedian: number | null;
}

/**
 * Tier 2 — aggregated base graded median / base raw median across sibling
 * cards (same player, same release; exact card-id excluded by the caller's
 * sibling-fetch logic). "Base" defined as `isBaseTitle(title) AND
 * parallel_id ∈ {null, undefined}`. The aggregated raw denominator comes
 * from the SAME sibling pool (raw-titled records that pass the base check
 * AND lack any graded marker in title) — not from the card's own anchor.
 *
 * Returns null when the ratio can't be defended (too few graded samples,
 * missing denominator, or zero/negative medians). Caller falls through to
 * tier 3.
 */
function resolvePlayerSetRatio(
  company: string,
  grade: string,
  label: string,
  siblingComps: ReadonlyArray<GradedProjectionSiblingComp>,
): {
  ratio: number;
  description: string;
  siblingBaseGradedSamples: number;
  siblingBaseRawSamples: number;
  siblingBaseGradedMedian: number;
  siblingBaseRawMedian: number;
} | null {
  if (siblingComps.length === 0) return null;
  const numNeeded = Number(grade);
  if (!Number.isFinite(numNeeded)) return null;

  // Sibling base pool — base check uses isBaseTitle and (when parallel_id
  // is provided) parallel_id == null. When parallel_id is absent, treat
  // it as null (the live aggregated fetch via fetchCompsByPlayer doesn't
  // preserve parallel_id, so this is the realistic input shape — slightly
  // less strict than tier 1's record-level base detection).
  const baseSiblings = siblingComps.filter((c) => {
    if (c.parallel_id != null) return false;
    return isBaseTitle(c.title);
  });
  if (baseSiblings.length === 0) return null;

  // Bucket by grade detected from title.
  const baseGraded: number[] = [];
  const baseRaw: number[] = [];
  for (const c of baseSiblings) {
    const det = c.title ? detectGradeFromTitle(c.title) : null;
    if (!det) {
      // No graded marker in title → treat as raw
      baseRaw.push(c.price);
      continue;
    }
    if (
      det.company.toUpperCase() === company.toUpperCase()
      && Number(det.grade) === numNeeded
    ) {
      baseGraded.push(c.price);
    }
    // Other grades for the same sibling — ignored at this layer (each
    // tier-2 call resolves ONE grade; other grades surface in their own
    // resolvePlayerSetRatio call).
  }

  if (baseGraded.length < TIER2_MIN_SIBLING_BASE_SAMPLES) return null;
  if (baseRaw.length === 0) return null;

  const gradedMed = median(baseGraded);
  const rawMed = median(baseRaw);
  if (gradedMed === null || rawMed === null || rawMed <= 0) return null;

  const ratio = gradedMed / rawMed;
  return {
    ratio,
    description:
      `${label} ratio ${ratio.toFixed(3)}× from ${baseGraded.length} base ${label} ` +
      `comps across this player's same-release sibling cards ` +
      `(median ${fmtUSD(gradedMed)} ÷ aggregated sibling base raw median ` +
      `${fmtUSD(rawMed)} from ${baseRaw.length} sales)`,
    siblingBaseGradedSamples: baseGraded.length,
    siblingBaseRawSamples: baseRaw.length,
    siblingBaseGradedMedian: gradedMed,
    siblingBaseRawMedian: rawMed,
  };
}

function resolveRatio(
  company: string,
  grade: string,
  label: string,
  baseRawMedian: number | null,
  pricing: CardsightPricingResponse,
  siblingComps: ReadonlyArray<GradedProjectionSiblingComp>,
  releaseRatios: ReleaseGradeCurve | null | undefined,
  releaseLabel: string | null | undefined,
  gemRateSignal?: GemRateSignal | null,
): ResolvedRatio {
  // Tier 1 — card-specific base ratio (dup-bucket merge inherited from
  // selectSalesByGrade — see compiqEstimate.service.ts:1022-1056).
  let cardSpecificBaseSamples = 0;
  let targetGradeBaseMedian: number | null = null;
  if (baseRawMedian !== null && baseRawMedian > 0) {
    const records = selectSalesByGrade(pricing, `${company} ${grade}`);
    const baseRecords = records.filter(isBaseRecord);
    cardSpecificBaseSamples = baseRecords.length;
    if (baseRecords.length >= TIER1_MIN_BASE_SAMPLES) {
      const med = median(baseRecords.map((r) => r.price));
      if (med !== null && med > 0) {
        targetGradeBaseMedian = med;
        const ratio = med / baseRawMedian;
        return {
          ratio,
          source: "card",
          description: `${label} ratio ${ratio.toFixed(3)}× from card's own ${baseRecords.length} base graded comps (median ${fmtUSD(med)} ÷ base raw ${fmtUSD(baseRawMedian)})`,
          cardSpecificBaseSamples,
          targetGradeBaseMedian,
        };
      }
    }
  }

  // Tier 2 — player/set-level aggregated ratio across sibling cards.
  // Fires when tier 1 missed (card n_base < TIER1_MIN_BASE_SAMPLES) AND
  // sibling-aggregated n_base >= TIER2_MIN_SIBLING_BASE_SAMPLES.
  const playerSet = resolvePlayerSetRatio(company, grade, label, siblingComps);
  if (playerSet) {
    return {
      ratio: playerSet.ratio,
      source: "player-set",
      description:
        cardSpecificBaseSamples > 0
          ? `${playerSet.description}; card's own ${cardSpecificBaseSamples} base ${label} sample(s) were below the tier-1 threshold of ${TIER1_MIN_BASE_SAMPLES}`
          : playerSet.description,
      cardSpecificBaseSamples,
      targetGradeBaseMedian: null,
    };
  }

  // Tier 2b — release-level grade-premium curve. Median per-card ratio
  // across the release; value-normalized so expensive cards in the
  // release don't skew the curve. Caller pre-computes via
  // computeReleaseGradeCurve(release, year) — the engine just reads.
  if (releaseRatios) {
    const entry = releaseRatios.get(label);
    if (entry && entry.ratio > 0) {
      const releasePhrase = releaseLabel
        ? `${releaseLabel}'s`
        : "this release's";
      return {
        ratio: entry.ratio,
        source: "release",
        description:
          `${label} ${entry.ratio.toFixed(3)}× from ${releasePhrase} typical ` +
          `${label} premium across ${entry.contributingCards} cards in the ` +
          `release (median of per-card raw→graded ratios)`,
        cardSpecificBaseSamples,
        targetGradeBaseMedian: null,
      };
    }
  }

  // Tier 3 — market grade-premium table (read-only). Gem-rate signal
  // short-circuits inside getGraderPremium for top grades on cards with
  // ≥10 base graded observations (CF-GEM-RATE-WIRED, PR #495 follow-up).
  const marketPremium = getGraderPremium(
    company,
    grade,
    undefined,
    undefined,
    undefined,
    undefined,
    gemRateSignal,
  );
  if (marketPremium > 0 && marketPremium !== 1.0) {
    return {
      ratio: marketPremium,
      source: "market",
      description: `${label} fell back to market grade-premium table (${marketPremium.toFixed(3)}×) — only ${cardSpecificBaseSamples} card-specific base sale(s), below the tier-1 threshold of ${TIER1_MIN_BASE_SAMPLES}; sibling aggregation also thin or absent`,
      cardSpecificBaseSamples,
      targetGradeBaseMedian: null,
    };
  }
  return {
    ratio: null,
    source: "none",
    description: `${label} has no card-specific data (n=${cardSpecificBaseSamples}), no sibling aggregation, and no market premium`,
    cardSpecificBaseSamples,
    targetGradeBaseMedian: null,
  };
}

// ── Confidence classification ──────────────────────────────────────────────

// ── CF-ALWAYS-A-NUMBER (2026-06-12) ────────────────────────────────────────
// Tunable per-tier spread + rounding. Single source of truth so spread/round
// calibration against actuals only changes one constant. The point estimate
// AND the range bounds are both rounded per tier — ballpark numbers must
// READ ballpark (2 sig figs: ~$830, ~$2,300, ~$23,000), never the false
// precision of "$832.42".

export interface GradeConfidenceConfig {
  /** Range as a fraction of the point estimate — widens with lower confidence. */
  spreadPct: number;
  /** Sig-fig rounding for the point + bounds. null → cents (legacy round2). */
  roundSigFigs: number | null;
}

export const GRADE_CONFIDENCE: Record<
  "estimate" | "rough" | "ballpark",
  GradeConfidenceConfig
> = {
  // CF-FINAL-CONSTANTS (2026-06-12): locked after CF-CROSS-GRADE-COHERENCE
  // live actuals confirmed the relative-scaling math reads coherent at
  // these widths/rounds.
  estimate: { spreadPct: 0.10, roundSigFigs: 3 }, // card-specific; 3 sf kills cents-precision UX
  rough:    { spreadPct: 0.20, roundSigFigs: 3 }, // release / parallel-anchor card ratio
  ballpark: { spreadPct: 0.40, roundSigFigs: 2 }, // generic-relative; 2 sf reads round-guess
};

/** Round to N significant figures. E.g.:
 *    roundToSigFigs(832.42, 2)   → 830
 *    roundToSigFigs(2299, 2)     → 2300
 *    roundToSigFigs(22940, 2)    → 23000
 *    roundToSigFigs(572, 3)      → 572 (already 3 sig figs)
 *  Zero and non-finite inputs pass through. Negative inputs round absolute
 *  magnitude (sign preserved).
 */
function roundToSigFigs(n: number, sigFigs: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  if (!Number.isFinite(sigFigs) || sigFigs <= 0) return n;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const magnitude = Math.floor(Math.log10(abs));
  const factor = Math.pow(10, magnitude - sigFigs + 1);
  return sign * Math.round(abs / factor) * factor;
}

/** Apply per-tier rounding to a value. */
function applyTierRounding(
  v: number,
  tier: "estimate" | "rough" | "ballpark",
): number {
  const cfg = GRADE_CONFIDENCE[tier];
  return cfg.roundSigFigs == null ? round2(v) : roundToSigFigs(v, cfg.roundSigFigs);
}

function classifyConfidence(
  anchorKind: GradedProjectionAnchorKind,
  ratioSource: GradedProjectionRatioSource,
): GradedProjectionConfidenceTier {
  // CF-ALWAYS-A-NUMBER (2026-06-12): "insufficient" is RETIRED for the
  // anchored-but-thin case; tier-3 ballpark surfaces with a number now.
  // The remaining no-data case is when there's no anchor at all OR
  // no ratio at all to multiply by — render "no-data" so the assembler
  // emits a marker the user can read as "can't anchor an estimate."
  if (anchorKind === "none" || ratioSource === "none") return "no-data";
  if (ratioSource === "market") return "ballpark";
  if (ratioSource === "player-set") return "rough";
  if (ratioSource === "release") return "rough";
  // ratioSource === "card"
  if (anchorKind === "base") return "estimate";
  return "rough"; // parallel-observed or parallel-composed with card ratio
}

/**
 * CF-ESTIMATOR-PHASE-1 (2026-06-14): tier mapping for observed-anchor
 * results. Implements the HALT-1 Q4 confidence-label table:
 *   - sibling anchor → always ballpark (cross-parallel adjustment widens uncertainty)
 *   - same anchor, target grade match, ≤90d, full/no_segment/no_card → estimate
 *   - same anchor, target grade match, ≤90d, card_only/segment_only → rough
 *   - same anchor, target grade match, ≤180d → rough
 *   - same anchor, cross-grade, ≤180d → rough
 *   - same anchor, >180d → ballpark
 *   - trendIQ insufficient → downgrade one tier
 */
function classifyObservedAnchorTier(
  anchorKind: "parallel-observed-same" | "parallel-observed-sibling",
  targetGradeLabel: string,
  saleGradeLabel: string | null,
  ageDays: number | null,
  trendCoverage: TrendIQCoverage | undefined,
): "estimate" | "rough" | "ballpark" {
  if (anchorKind === "parallel-observed-sibling") {
    return trendCoverage === "insufficient" ? "ballpark" : "ballpark";
  }
  const age = ageDays ?? 365; // unknown date = old
  const sameGrade = saleGradeLabel === targetGradeLabel;
  const richCoverage =
    trendCoverage === "full" || trendCoverage === "no_segment" || trendCoverage === "no_card";
  const cardOrSegmentCoverage =
    trendCoverage === "card_only" || trendCoverage === "segment_only";

  let baseTier: "estimate" | "rough" | "ballpark";
  if (sameGrade && age <= 90 && richCoverage) {
    baseTier = "estimate";
  } else if (sameGrade && age <= 90 && cardOrSegmentCoverage) {
    baseTier = "rough";
  } else if (sameGrade && age <= 90) {
    baseTier = "rough"; // L1-only or no coverage
  } else if (sameGrade && age <= 180) {
    baseTier = "rough";
  } else if (!sameGrade && age <= 180) {
    baseTier = "rough";
  } else {
    baseTier = "ballpark"; // > 180d, regardless of grade match
  }
  if (trendCoverage === "insufficient") {
    if (baseTier === "estimate") return "rough";
    if (baseTier === "rough") return "ballpark";
  }
  return baseTier;
}

/**
 * CF-ESTIMATOR-PHASE-1 (2026-06-14): basis prose for observed-anchor
 * results. Names the actual source sale, the parallel/grade adjustments
 * applied, and the trend factor. NEVER says "no related sales" — the
 * caller only invokes this when a candidate pool existed.
 */
function buildObservedAnchorBasis(
  anchorKind: "parallel-observed-same" | "parallel-observed-sibling",
  targetGradeLabel: string,
  targetParallelName: string,
  observed: ObservedAnchorCandidate,
  targetGradePremium: number,
  trendFactor: number,
  trendIQ: TrendIQResult | null | undefined,
  estimatedValue: number | null,
): string {
  const saleKind = observed.saleGradeLabel ? `${observed.saleGradeLabel} sale` : "raw sale";
  const ageBit = observed.ageDays != null ? `${observed.ageDays}d ago` : "date unknown";
  const trendBit =
    trendIQ && trendIQ.coverage !== "insufficient"
      ? `trend factor ${trendFactor.toFixed(2)}× (${trendIQ.direction}, ${trendIQ.coverage})`
      : `no trend signal (factor 1.00×)`;
  if (anchorKind === "parallel-observed-same") {
    const gradeBit = observed.saleGradeLabel === targetGradeLabel
      ? `same grade as target`
      : `grade ratio ${(targetGradePremium / observed.saleGradePremium).toFixed(2)}× (${targetGradeLabel}/${observed.saleGradeLabel ?? "raw"})`;
    return (
      `Estimated from a ${targetParallelName} ${saleKind} of `
      + `${fmtUSD(observed.sourceSale.price)} (${ageBit}), `
      + `${gradeBit}, ${trendBit}`
      + (estimatedValue != null ? ` ⇒ ${fmtUSD(estimatedValue)}.` : `.`)
    );
  }
  // sibling
  return (
    `Estimated from a ${observed.siblingParallelName} ${saleKind} of `
    + `${fmtUSD(observed.sourceSale.price)} (${ageBit}), `
    + `parallel ratio ${observed.parallelRatio.toFixed(2)}× (${targetParallelName}/${observed.siblingParallelName} = `
    + `${observed.targetMultiplier.toFixed(2)}/${observed.sourceMultiplier.toFixed(2)}), `
    + `grade ratio ${(targetGradePremium / observed.saleGradePremium).toFixed(2)}× `
    + `(${targetGradeLabel}/${observed.saleGradeLabel ?? "raw"}), `
    + `${trendBit}`
    + (estimatedValue != null ? ` ⇒ ${fmtUSD(estimatedValue)}.` : `.`)
    + ` Indicative — derived from a single sibling-parallel sale, not a direct ${targetParallelName} comp.`
  );
}

/** Legacy spread reader — kept for any external consumer; new code reads
 *  GRADE_CONFIDENCE[tier].spreadPct directly. */
function spreadFor(tier: GradedProjectionConfidenceTier): number {
  // CF-LEGACY-UNION-CLEANUP (PR #491): "insufficient" comparison retired
  // with the union member — engine no longer produces it.
  if (tier === "no-data") return 0;
  return GRADE_CONFIDENCE[tier].spreadPct;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export function computeGradedProjection(
  input: ComputeGradedProjectionInput,
): GradedProjectionResult[] {
  const {
    pricing,
    targetParallelId,
    targetParallelRawFmv,
    targetParallelRawFmvSource,
    targetParallelRawFmvAgeDays,
    targetParallelName,
    siblingComps = [],
    releaseRatios = null,
    releaseLabel = null,
    trendIQ = null,
    cardParallels = undefined,
    isAuto = false,
    targetGrades = TARGET_GRADES,
  } = input;

  // Base raw anchor: parallel_id null AND title carries no finish tokens.
  const rawRecords = pricing.raw?.records ?? [];
  const baseRawRecords = rawRecords.filter(isBaseRecord);
  const baseRawMedian = median(baseRawRecords.map((r) => r.price));
  const baseRawSampleCount = baseRawRecords.length;

  // Anchor — resolved once per call (parallel target shares anchor across
  // all target grades; base target shares the base raw median). The new
  // observed-anchor paths need pricing to walk pricing.raw + pricing.graded.
  const anchor = resolveAnchor(baseRawMedian, baseRawSampleCount, {
    targetParallelId,
    targetParallelRawFmv,
    targetParallelRawFmvSource,
    targetParallelRawFmvAgeDays,
    targetParallelName,
    pricing,
    cardParallels,
    isAuto,
  });

  // CF-ESTIMATOR-PHASE-1 (2026-06-14): the trend factor is applied
  // ONLY when the anchor is observed-derived (same- or sibling-parallel).
  // Composed / base / parallel-observed-by-raw-fmv paths use medians of
  // comp pools that are already partially trend-aware via per-comp
  // weighting in computeEstimate; double-counting trend here would
  // over-claim. Observed-anchor paths anchor on a SINGLE old sale and
  // genuinely need forward projection — that's the brief's "old anchor ×
  // trend = new price" form.
  const trendFactorForObservedAnchor: number =
    anchor.kind === "parallel-observed-same" || anchor.kind === "parallel-observed-sibling"
      ? (trendIQ ? computeForwardProjectionFactor(trendIQ) : 1.0)
      : 1.0;

  // CF-GEM-RATE-WIRED (Drew, 2026-07-15, PR #495 follow-up): compute the
  // card's gem-rate signal ONCE from the graded observations at hand, then
  // thread it into every getGraderPremium call in this loop. When the card
  // has ≥10 observed graded sales, top-grade multipliers (PSA 10 / BGS 10 /
  // BGS 10 Black Label / BGS 9.5 / SGC 10) come from Drew's -3·ln(gemRate)
  // + 0.5 formula instead of the static table — the pricing engine's per-
  // card "learning loop" on scarcity. Mid-tier grades keep the table.
  const gemRateSignal = buildGemRateSignalFromPricing(
    pricing,
    pricing.card?.card_id ?? null,
  );

  const results: GradedProjectionResult[] = [];
  for (const tg of targetGrades) {
    // GUARD — observed-first precedence. Skip estimating any grade with
    // ≥1 observed sale in the requested scope. Observed data renders
    // through the existing FMV / comp / gradeBreakdown pipeline; the
    // estimator only fills gaps, never overlays real numbers.
    const observedInScope = countObservedInScope(
      pricing,
      tg.company,
      tg.grade,
      targetParallelId,
      targetParallelName,
    );
    if (observedInScope > 0) continue;

    // CF-ESTIMATOR-PHASE-1 (2026-06-14): observed-anchor branch. When the
    // anchor came from a real same/sibling parallel sale, anchor.price IS
    // already the parallel-raw equivalent — multiply by the target grade's
    // GRADER_PREMIUMS directly (skip resolveRatio's tier-1/2/2b cascade,
    // which would stack noise on a value that's already self-anchored).
    // Trend factor is applied per-grade as a final multiplier so the
    // coherence pass's sub-raw floor (which checks against anchor.price)
    // still reads against the pre-trend parallel-raw equivalent.
    if (
      (anchor.kind === "parallel-observed-same" || anchor.kind === "parallel-observed-sibling")
      && anchor.price !== null
      && anchor.price > 0
      && anchor.observedSource
    ) {
      const generic = getGraderPremium(
        tg.company,
        tg.grade,
        undefined,
        undefined,
        undefined,
        undefined,
        gemRateSignal,
      );
      const observed = anchor.observedSource;
      if (!(generic > 0)) {
        results.push({
          grade: tg.label,
          estimatedValue: null,
          estimateLow: null,
          estimateHigh: null,
          basis: `No GRADER_PREMIUMS entry for ${tg.label}.`,
          confidenceTier: "no-data",
          ratioSource: "none",
          anchorKind: anchor.kind,
          isEstimate: true,
          marketValue: null,
          fairMarketValue: null,
          diagnostics: {
            anchorPrice: anchor.price,
            cardSpecificBaseSamples: 0,
            ratio: null,
            targetGradeBaseMedian: null,
            baseRawMedian,
            baseRawSampleCount,
          },
        });
        continue;
      }
      const tier = classifyObservedAnchorTier(
        anchor.kind,
        tg.label,
        observed.saleGradeLabel,
        observed.ageDays,
        trendIQ?.coverage,
      );
      const rawValue = anchor.price * generic * trendFactorForObservedAnchor;
      const cfg = GRADE_CONFIDENCE[tier];
      const estimatedValue = applyTierRounding(rawValue, tier);
      const estimateLow = applyTierRounding(rawValue * (1 - cfg.spreadPct), tier);
      const estimateHigh = applyTierRounding(rawValue * (1 + cfg.spreadPct), tier);
      const basis = buildObservedAnchorBasis(
        anchor.kind,
        tg.label,
        targetParallelName ?? "this parallel",
        observed,
        generic,
        trendFactorForObservedAnchor,
        trendIQ,
        estimatedValue,
      );
      results.push({
        grade: tg.label,
        estimatedValue,
        estimateLow,
        estimateHigh,
        basis,
        confidenceTier: tier,
        ratioSource: "market",
        anchorKind: anchor.kind,
        isEstimate: true,
        marketValue: null,
        fairMarketValue: null,
        diagnostics: {
          anchorPrice: anchor.price,
          cardSpecificBaseSamples: 0,
          ratio: generic,
          targetGradeBaseMedian: null,
          baseRawMedian,
          baseRawSampleCount,
        },
      });
      continue;
    }

    // CF-FITTED-LADDER (2026-06-16): for fitted composed PSA 10, replace
    // the resolveRatio cascade (tier-1 card ratio → player-set → release
    // → market) with the per-bucket PSA 10 ratio from CF-LADDER-FIT
    // Step 3. PSA 9 and below stay on resolveRatio — the corpus showed
    // base PSA 9 / raw < 1.0× (implausible), indicating the pool is too
    // noisy for hardcoded ratios.
    let ratio = resolveRatio(
      tg.company,
      tg.grade,
      tg.label,
      baseRawMedian,
      pricing,
      siblingComps,
      releaseRatios,
      releaseLabel,
      gemRateSignal,
    );
    let bucketRatioApplied = false;
    if (
      anchor.kind === "parallel-composed"
      && tg.label === "PSA 10"
      && anchor.serial != null
    ) {
      const bucketRatio = getPsa10BucketRatio(anchor.serial);
      if (bucketRatio) {
        ratio = {
          ratio: bucketRatio.ratio,
          source: "fitted-bucket",
          description: `${tg.label} fitted-bucket ratio ${bucketRatio.ratio.toFixed(2)}× (parallel-value bucket ${bucketRatio.bucket} pooled from CF-LADDER-FIT BCPA 2022-2025 corpus)${bucketRatio.lowConfidence ? " [low-conf: bucket had no data, used best-available proxy]" : ""}`,
          cardSpecificBaseSamples: 0,
          targetGradeBaseMedian: null,
        };
        bucketRatioApplied = true;
      }
    }
    // Confidence tier: anchor-side low-conf (fitted ladder flagged top-
    // tier or unobserved cell) downgrades the result to "ballpark" with
    // wide spread, regardless of ratio source. PSA 10 /5-/25 bucket-side
    // low-conf does the same. Otherwise classifyConfidence handles the
    // standard mapping.
    const ratioBucketLowConf = bucketRatioApplied
      && tg.label === "PSA 10"
      && anchor.serial != null
      && (getPsa10BucketRatio(anchor.serial)?.lowConfidence ?? false);
    const tier: GradedProjectionConfidenceTier = (anchor.lowConfidence === true || ratioBucketLowConf)
      ? "ballpark"
      : classifyConfidence(anchor.kind, ratio.source);

    // CF-ALWAYS-A-NUMBER (2026-06-12): emit a number for every tier
    // except "no-data" (no anchor or no ratio). Per-tier spread + sig-fig
    // rounding from GRADE_CONFIDENCE config.
    let estimatedValue: number | null = null;
    let estimateLow: number | null = null;
    let estimateHigh: number | null = null;
    if (
      anchor.price !== null
      && ratio.ratio !== null
      && tier !== "no-data"
    ) {
      const rawValue = anchor.price * ratio.ratio;
      const cfg = GRADE_CONFIDENCE[tier];
      const v = applyTierRounding(rawValue, tier);
      estimatedValue = v;
      estimateLow = applyTierRounding(rawValue * (1 - cfg.spreadPct), tier);
      estimateHigh = applyTierRounding(rawValue * (1 + cfg.spreadPct), tier);
    }

    const basis = `Anchor: ${anchor.description}. Ratio: ${ratio.description}.`;

    results.push({
      grade: tg.label,
      estimatedValue,
      estimateLow,
      estimateHigh,
      basis,
      confidenceTier: tier,
      ratioSource: ratio.source,
      anchorKind: anchor.kind,
      isEstimate: true,
      marketValue: null,
      fairMarketValue: null,
      diagnostics: {
        anchorPrice: anchor.price,
        cardSpecificBaseSamples: ratio.cardSpecificBaseSamples,
        ratio: ratio.ratio,
        targetGradeBaseMedian: ratio.targetGradeBaseMedian,
        baseRawMedian,
        baseRawSampleCount,
      },
    });
  }

  // CF-CROSS-GRADE-COHERENCE (2026-06-12) — LADDER COHERENCE GUARDS.
  //
  // Step 1 of two: anchor every ballpark grade to the card's grounded
  // LEVEL, not the absolute generic curve. The pre-CF mix of strategies
  // (grounded grades anchored on card data, ballparks anchored on
  // absolute generic) produced cross-grade incoherence: Leo Blue PSA 10
  // grounded $2,850 sat below BGS 9.5 ballpark $4,100 because PSA 10
  // used the card's below-market ratio while BGS 9.5 used the at-market
  // generic. Relative scaling fixes this by scaling the generic CURVE
  // to the card's LEVEL.
  //
  // OBSERVED IS FACT (hard structural invariant): observed grades are
  // never in `results` — `countObservedInScope` at the top of the
  // per-grade loop skips them entirely. Both Guard 1 + the ordering
  // ceiling iterate over `results`; they CANNOT touch an observed
  // grade's value. The "OBSERVED IS FACT" comment below every loop
  // documents this so a future refactor doesn't accidentally drop the
  // observed-skip and start clamping real comp sales. Confirmed via
  // explicit defensive check in selectAnchorGrade() too — R candidates
  // include observed VALUES, but rail emit is GUARD-skipped upstream.
  if (anchor.price !== null && anchor.price > 0) {
    const anchorPrice = anchor.price;

    // Demote a result to no-data — used when refusal floor triggers.
    const demoteToNoData = (r: GradedProjectionResult, reason: string) => {
      r.estimatedValue = null;
      r.estimateLow = null;
      r.estimateHigh = null;
      r.confidenceTier = "no-data";
      r.ratioSource = "none";
      r.diagnostics.ratio = null;
      r.diagnostics.targetGradeBaseMedian = null;
      r.basis = `${r.basis} [coherence: ${reason} → demoted to no-data]`;
    };

    // Stamp a ballpark result at a given absolute value with ballpark
    // rounding + spread.
    const setBallparkValue = (r: GradedProjectionResult, value: number, ratio: number, reason: string) => {
      const cfg = GRADE_CONFIDENCE.ballpark;
      r.estimatedValue = applyTierRounding(value, "ballpark");
      r.estimateLow = applyTierRounding(value * (1 - cfg.spreadPct), "ballpark");
      r.estimateHigh = applyTierRounding(value * (1 + cfg.spreadPct), "ballpark");
      r.confidenceTier = "ballpark";
      r.ratioSource = "market";
      r.diagnostics.ratio = ratio;
      r.diagnostics.targetGradeBaseMedian = null;
      r.basis = `${r.basis} [coherence: ${reason}]`;
    };

    // SUB-RAW DEMOTION (the canonical PSA 9 case): a card/release ratio
    // that produces a sub-raw value is unreliable as a card-specific
    // signal. Demote the grade from estimate/rough to ballpark so the
    // relative-scaling pass below re-anchors it via R, producing a
    // coherent number above raw. The pre-CF behavior fell back to the
    // ABSOLUTE generic — that mixed strategies and re-introduced cross-
    // grade incoherence. Now it's relative-scaled like every other
    // ballpark. OBSERVED IS FACT: this loop only touches results entries
    // (observed grades are GUARD-skipped upstream).
    for (const r of results) {
      if (r.estimatedValue == null) continue;
      if (r.confidenceTier !== "estimate" && r.confidenceTier !== "rough") continue;
      if (r.estimatedValue >= anchorPrice) continue;
      r.confidenceTier = "ballpark";
      r.ratioSource = "market";
      r.basis = `${r.basis} [coherence: sub-raw card-ratio (value $${r.estimatedValue.toFixed(2)} < anchor $${anchorPrice.toFixed(2)}) → demoted to ballpark for relative scaling]`;
    }

    // OBSERVED IS FACT: extract observed values from the pricing payload
    // so the relative-scaling anchor R can use real comp sales when
    // available. These values are READ-ONLY here — never mutated, never
    // surfaced as estimates. The rail's per-grade compute loop already
    // GUARD-skipped the same grades from emission; observedValues exists
    // as auxiliary context for R selection + the ordering ceiling.
    const observedValues = extractObservedGradeValues(
      pricing,
      targetParallelId,
      targetParallelName,
    );

    // R selection. Candidates: observed grades with n ≥ tier-1 threshold
    // AND a generic premium entry > 1.0, OR rail estimate/rough entries
    // with same constraint. Ballparks are NOT candidates (using a
    // ballpark to scale another ballpark is circular). Sort by:
    //   1. confidence rank (observed-sufficient > observed-thin > estimate > rough)
    //   2. numeric grade rank (10 > 9.5 > 9 > ...)
    //   3. value (tie-break)
    interface RCandidate {
      label: string;
      company: string;
      gradeStr: string;
      value: number;
      genericPremium: number;
      confidenceRank: number;
      gradeRank: number;
    }
    const rCandidates: RCandidate[] = [];
    for (const [label, info] of observedValues) {
      const generic = getGraderPremium(info.company, info.gradeStr);
      if (!(generic > 1.0)) continue;
      const gradeRank = Number(info.gradeStr);
      if (!Number.isFinite(gradeRank)) continue;
      const confidenceRank = info.n >= TIER1_MIN_BASE_SAMPLES ? 100 : 70;
      rCandidates.push({
        label,
        company: info.company,
        gradeStr: info.gradeStr,
        value: info.value,
        genericPremium: generic,
        confidenceRank,
        gradeRank,
      });
    }
    for (const r of results) {
      if (r.estimatedValue == null) continue;
      if (r.confidenceTier !== "estimate" && r.confidenceTier !== "rough") continue;
      const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
      if (!m) continue;
      const generic = getGraderPremium(m[1]!, m[2]!);
      if (!(generic > 1.0)) continue;
      const gradeRank = Number(m[2]!);
      if (!Number.isFinite(gradeRank)) continue;
      rCandidates.push({
        label: r.grade,
        company: m[1]!,
        gradeStr: m[2]!,
        value: r.estimatedValue,
        genericPremium: generic,
        confidenceRank: r.confidenceTier === "estimate" ? 50 : 40,
        gradeRank,
      });
    }
    rCandidates.sort(
      (a, b) =>
        b.confidenceRank - a.confidenceRank
        || b.gradeRank - a.gradeRank
        || b.value - a.value,
    );
    const R = rCandidates.length > 0 ? rCandidates[0]! : null;

    if (R !== null) {
      // RELATIVE SCALING: anchor ballparks to R's grounded level.
      //   ballpark(G) = R.value × ( genericPremium(G) / R.genericPremium )
      // For Leo BASE with R = PSA 10 (value $572, generic 4.0×):
      //   BGS 9.5 ballpark = $572 × (3.5 / 4.0) = $500.50
      //   SGC 10 ballpark = $572 × (3.4 / 4.0) = $486.20
      // Sub-raw guard (≥-raw floor): a relative-scaled ballpark below
      // the raw anchor signals the card-anchor is so far below the
      // generic curve that lower grades round-trip to sub-raw. Refuse
      // to print sub-raw — demote to no-data. Falling back to absolute
      // generic here would re-introduce the mix-strategies bug.
      // OBSERVED IS FACT: this loop only touches results entries;
      // observed grades are not in results.
      for (const r of results) {
        if (r.confidenceTier !== "ballpark") continue;
        const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) continue;
        const generic = getGraderPremium(m[1]!, m[2]!);
        if (!(generic > 0)) {
          demoteToNoData(r, `no generic premium for ${r.grade}`);
          continue;
        }
        const scaleRatio = generic / R.genericPremium;
        const relative = R.value * scaleRatio;
        if (relative < anchorPrice) {
          demoteToNoData(
            r,
            `relative-scaled to ${R.label} ($${R.value.toFixed(2)}) × ${scaleRatio.toFixed(3)} = $${relative.toFixed(2)} < raw $${anchorPrice.toFixed(2)}`,
          );
          continue;
        }
        setBallparkValue(
          r,
          relative,
          scaleRatio,
          `relative-scaled to ${R.label} ($${R.value.toFixed(2)}) × ${scaleRatio.toFixed(3)}`,
        );
      }

      // ORDERING CEILING: a ballpark grade may not exceed a grounded
      // HIGHER-ranked grade. Rank = numeric grade value (10 > 9.5 > 9).
      // Same-rank grades (BGS 10 vs PSA 10 vs SGC 10) are unconstrained
      // — cross-grader prestige is fuzzy. Observed grades and rail
      // estimate/rough entries qualify as grounded for the ceiling;
      // OTHER ballparks do NOT (using ballpark to constrain ballpark is
      // circular).
      // OBSERVED IS FACT: ceiling READS observed values from observedValues,
      // but only CLAMPS ballparks in results — observed grades are not
      // in results.
      const groundedByRank = new Map<number, number[]>();
      for (const [, info] of observedValues) {
        const rank = Number(info.gradeStr);
        if (!Number.isFinite(rank)) continue;
        if (!groundedByRank.has(rank)) groundedByRank.set(rank, []);
        groundedByRank.get(rank)!.push(info.value);
      }
      for (const r of results) {
        if (r.estimatedValue == null) continue;
        if (r.confidenceTier !== "estimate" && r.confidenceTier !== "rough") continue;
        const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) continue;
        const rank = Number(m[2]!);
        if (!Number.isFinite(rank)) continue;
        if (!groundedByRank.has(rank)) groundedByRank.set(rank, []);
        groundedByRank.get(rank)!.push(r.estimatedValue);
      }
      for (const r of results) {
        if (r.confidenceTier !== "ballpark") continue;
        if (r.estimatedValue == null) continue;
        const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) continue;
        const myRank = Number(m[2]!);
        if (!Number.isFinite(myRank)) continue;
        let ceiling = Infinity;
        for (const [otherRank, values] of groundedByRank) {
          if (otherRank > myRank) {
            const minHere = Math.min(...values);
            if (minHere < ceiling) ceiling = minHere;
          }
        }
        if (Number.isFinite(ceiling) && r.estimatedValue > ceiling) {
          setBallparkValue(
            r,
            ceiling,
            ceiling / anchorPrice,
            `ordering ceiling clamp from grounded higher-rank ($${ceiling.toFixed(2)})`,
          );
        }
      }
    } else {
      // No grounded grade with a generic premium — fall back to ABSOLUTE
      // generic curve (current pre-CF Guard 1 behavior). Applies the
      // sub-raw floor + same-grader monotonicity. Rare path: only fires
      // when the card has zero observed grades AND no card/release-ratio
      // tier-1/tier-2 fired for any target grade.
      const rebaseToGeneric = (
        r: GradedProjectionResult,
        company: string,
        gradeStr: string,
        reason: string,
      ) => {
        // CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28): pass anchorPrice so the
        // multiplier comes from the matching price tier instead of the
        // fallback overall-average. <$25 raws now get the higher PSA 10
        // premium (4.9×) they actually trade at; $100+ raws get the lower
        // 2.2× that matches the market instead of the old 4.0× over-claim.
        // CF-GEM-RATE-WIRED (PR #495): gem-rate signal short-circuits to
        // the -3·ln(gemRate) formula for top grades when the card carries
        // ≥10 base graded observations. Mid-tier grades keep the tiered
        // table on this path.
        const generic = getGraderPremium(
          company,
          gradeStr,
          anchorPrice,
          undefined,
          undefined,
          undefined,
          gemRateSignal,
        );
        if (!Number.isFinite(generic) || generic < 1.0) {
          demoteToNoData(r, reason);
          return;
        }
        setBallparkValue(r, anchorPrice * generic, generic, reason);
      };
      // Guard 1: ≥ raw anchor floor (absolute fallback).
      for (const r of results) {
        if (r.estimatedValue == null) continue;
        if (r.estimatedValue >= anchorPrice) continue;
        const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) continue;
        rebaseToGeneric(r, m[1]!, m[2]!, "ratio < 1.0 (sub-raw)");
      }
      // Guard 2: same-grader monotonicity (absolute fallback).
      interface GradeEntry {
        result: GradedProjectionResult;
        company: string;
        gradeValue: number;
        gradeStr: string;
      }
      const byGrader = new Map<string, GradeEntry[]>();
      for (const r of results) {
        if (r.estimatedValue == null) continue;
        const m = r.grade.match(/^([A-Z]+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) continue;
        const co = m[1]!;
        const gradeStr = m[2]!;
        const gv = Number(gradeStr);
        if (!Number.isFinite(gv)) continue;
        if (!byGrader.has(co)) byGrader.set(co, []);
        byGrader.get(co)!.push({ result: r, company: co, gradeValue: gv, gradeStr });
      }
      for (const [, list] of byGrader) {
        list.sort((a, b) => b.gradeValue - a.gradeValue);
        for (let i = 0; i < list.length - 1; i++) {
          const higher = list[i]!;
          const lower = list[i + 1]!;
          if (higher.result.estimatedValue == null || lower.result.estimatedValue == null) continue;
          if (higher.result.estimatedValue >= lower.result.estimatedValue) continue;
          const reason = `same-grader inversion (${lower.result.grade}=$${lower.result.estimatedValue} > ${higher.result.grade}=$${higher.result.estimatedValue})`;
          rebaseToGeneric(higher.result, higher.company, higher.gradeStr, reason);
          rebaseToGeneric(lower.result, lower.company, lower.gradeStr, reason);
        }
      }
    }
  }

  // CF-FITTED-RANGE-LAYER (2026-06-17): post-process every result with
  // the sufficiency tier + range fields. CF-FITTED-RANGE-PROVENANCE-FIX
  // (2026-06-17): the SINGLE source of truth is the floor-surviving
  // observed comp pool. Both the engine's anchor decision (above, via
  // compileGradedEstimatesForCard → computeSameParallelRawMedian) and
  // the labels emitted here read the SAME helper, so the count and the
  // number always agree on which records anchored what. Universal
  // invariant: the emitted point sits inside [rangeLow, rangeHigh].
  if (results.length > 0 && targetParallelId && targetParallelName) {
    const siblings = cardParallels ?? [];
    const targetEntry = siblings.find((p) => p.id === targetParallelId);
    const numberedTo = targetEntry?.numberedTo ?? null;
    const fittedAtTarget = computeFittedComposedMultiplier(targetParallelName, numberedTo);
    // CF-FITTED-RANGE-BAND-HONESTY (2026-06-17): finish-aware lookup —
    // (finish, serial) cell band when the corpus had enough data to pin
    // that pairing, else tier band. Wider bands honestly reflect the
    // engine's parallel-level uncertainty.
    const band = getFittedRangeBand(numberedTo, fittedAtTarget?.finish);
    const isTopTier = numberedTo != null && numberedTo > 0 && numberedTo <= 50;

    // Single source of truth for the LABEL: floor-surviving raw comp
    // pool. In production the caller's computeSameParallelRawMedian
    // delegates to the same helper, so pool.median != null is equivalent
    // to "anchor.kind = parallel-observed" — but anchor.kind is what we
    // actually consult for the range (per-result) so the invariant holds
    // even on artificial inputs.
    const pool = getObservedParallelCompPool(
      pricing,
      targetParallelId,
      targetParallelName,
      siblings,
      baseRawMedian,
    );

    const cardPremium = isTopTier
      ? computeCardPremium(pricing, siblings, baseRawMedian)
      : 1.0;

    // Sufficiency — top-tier override forces "none" (structurally
    // unreliable per the fit); otherwise based on pool.n.
    const compSufficiency: "sufficient" | "thin" | "none" = isTopTier
      ? "none"
      : pool.n >= 3
        ? "sufficient"
        : pool.n >= 1
          ? "thin"
          : "none";
    const estimateBasis: "comps" | "comps-thin" | "multiplier-range" =
      compSufficiency === "sufficient"
        ? "comps"
        : compSufficiency === "thin"
          ? "comps-thin"
          : "multiplier-range";

    for (const r of results) {
      r.n = pool.n;
      r.compSufficiency = compSufficiency;
      r.estimateBasis = estimateBasis;
      r.diagnostics.cardPremium = cardPremium;

      // Range provenance follows the POINT's provenance, decided per-
      // result by anchor.kind (what the engine actually used to build
      // the point) — NOT by pool.median alone. The pool drives the
      // LABEL (n + sufficiency + basis); anchor.kind drives the RANGE.
      // In production these always agree; the dual signal is defensive
      // against artificial inputs (e.g., FMV threaded by caller without
      // matching records in pricing — the invariant still holds).
      //   • Observed-anchor kinds → range = engine's GRADE_CONFIDENCE
      //     spread × point (already brackets point by construction).
      //   • Composed/base/none → fitted band × multiplier × ratio (band
      //     has low ≤ 1.0 ≤ high so it brackets the central point).
      const isObservedAnchor =
        r.anchorKind === "parallel-observed"
        || r.anchorKind === "parallel-observed-same"
        || r.anchorKind === "parallel-observed-sibling";
      if (isObservedAnchor) {
        r.multiplierLow = null;
        r.multiplierHigh = null;
        r.rangeLow = r.estimateLow;
        r.rangeHigh = r.estimateHigh;
      } else if (
        fittedAtTarget != null
        && baseRawMedian != null
        && baseRawMedian > 0
        && r.estimatedValue != null
        && r.estimatedValue > 0
      ) {
        const m = fittedAtTarget.multiplier;
        const mLow = m * band.low;
        let mHigh = m * band.high;
        // Top-tier upper widening — conservative, upper-bound only.
        if (compSufficiency === "none") mHigh *= cardPremium;
        r.multiplierLow = mLow;
        r.multiplierHigh = mHigh;
        // Range derivation: scale the EMITTED POINT by the band so the
        // invariant (point ∈ [rangeLow, rangeHigh]) holds even when the
        // coherence-pass guards (CROSS-GRADE-COHERENCE) mutated the
        // per-grade-loop's anchor × ratio decoupling diagnostics.ratio
        // from estimatedValue. Mathematically: base × m × band × ratio
        // = (base × m × ratio) × band = point × band — same answer
        // pre-coherence, but robust post-coherence.
        const rangeLowMult = band.low;
        const rangeHighMult = compSufficiency === "none"
          ? band.high * cardPremium
          : band.high;
        r.rangeLow = round2(r.estimatedValue * rangeLowMult);
        r.rangeHigh = round2(r.estimatedValue * rangeHighMult);
      } else {
        // No fitted multiplier (no numberedTo) AND no observed pool —
        // fall back to the engine's existing range. Conservative.
        r.multiplierLow = null;
        r.multiplierHigh = null;
        r.rangeLow = r.estimateLow;
        r.rangeHigh = r.estimateHigh;
      }
    }
  } else {
    // BASE scope OR no parallel target — fill defaults so consumers can
    // still read the fields without conditional checks. n=0, sufficiency
    // doesn't apply, ranges mirror existing low/high (the engine already
    // computed them via GRADE_CONFIDENCE spread).
    for (const r of results) {
      r.n = 0;
      r.compSufficiency = "none";
      r.estimateBasis = "multiplier-range";
      r.multiplierLow = null;
      r.multiplierHigh = null;
      r.rangeLow = r.estimateLow;
      r.rangeHigh = r.estimateHigh;
    }
  }

  return results;
}

/** Observed grade aggregate for the requested scope. Read-only auxiliary
 *  context for the ladder coherence guards — never mutated, never surfaced
 *  as an estimate. The rail's per-grade compute loop already GUARD-skips
 *  these grades from emission via countObservedInScope. */
interface ObservedGradeValue {
  value: number;       // base-only or parallel-scope median
  n: number;           // sample count
  company: string;
  gradeStr: string;
}

/** Extract observed (company, grade) median values from the pricing
 *  payload, filtered to the same scope (base or parallel) that
 *  countObservedInScope uses. Iterates pricing.graded directly, then
 *  re-queries selectSalesByGrade per unique (company, grade) tuple to
 *  handle Cardsight's dup-bucket quirk (CF-PRICING-BUCKET-MERGE). */
function extractObservedGradeValues(
  pricing: CardsightPricingResponse,
  targetParallelId: string | null | undefined,
  targetParallelName: string | null | undefined,
): Map<string, ObservedGradeValue> {
  const out = new Map<string, ObservedGradeValue>();
  const tuples = new Set<string>();
  for (const company of (pricing.graded ?? [])) {
    const co = String(company.company_name ?? "").toUpperCase().trim();
    if (!co) continue;
    for (const g of (company.grades ?? [])) {
      const gradeStr = String(g.grade_value ?? "").trim();
      if (!gradeStr) continue;
      tuples.add(`${co}|${gradeStr}`);
    }
  }
  for (const key of tuples) {
    const [co, gradeStr] = key.split("|");
    if (!co || !gradeStr) continue;
    const records = selectSalesByGrade(pricing, `${co} ${gradeStr}`);
    // Filter to scope (mirrors countObservedInScope above)
    let scope: CardsightSaleRecord[];
    if (!targetParallelId) {
      scope = records.filter(isBaseRecord);
    } else {
      const strict = records.filter((r) => r.parallel_id === targetParallelId);
      if (strict.length > 0) {
        scope = strict;
      } else if (targetParallelName) {
        const ptokens = tokenizeParallel(targetParallelName);
        if (ptokens.length === 0) continue;
        const patterns = ptokens.map(
          (t) => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"),
        );
        scope = records.filter((r) => {
          const title = r.title ?? "";
          return patterns.every((p) => p.test(title));
        });
      } else {
        continue;
      }
    }
    if (scope.length === 0) continue;
    // CF-COMP-SPARSITY-STALENESS-FILTER (2026-06-29): mirror
    // countObservedInScope. A stale singleton is NOT credibly observed;
    // excluding it here keeps R-selection + the ordering ceiling
    // consistent with the rail-skip gate.
    const credible = filterCredibleObserved(scope);
    if (credible.length === 0) continue;
    const med = median(credible.map((r) => r.price));
    if (med === null || med <= 0) continue;
    out.set(`${co} ${gradeStr}`, {
      value: med,
      n: credible.length,
      company: co,
      gradeStr,
    });
  }
  return out;
}

// ── Phase 2 wiring (CF-GRADED-PRICE-PROJECTION) ────────────────────────────
//
// buildGradedEstimates is the live-path adapter. It wraps
// computeGradedProjection with:
//   1. GROUNDED-ONLY FILTER ("gaps honest"): drop confidenceTier
//      "ballpark" (tier-3 market table) and "insufficient" — those grades
//      simply don't surface, no generic number on the wire.
//   2. NO-MUTATION INVARIANT: snapshot the pricing payload + the three
//      observed response fields shipped on the same response
//      (marketTier.value, recentComps, gradeBreakdown) before the engine
//      call; assert byte-identical after. The estimator must NEVER touch
//      a single observed number — this is the integration-level proof
//      that surfacing the estimator doesn't touch cards with data. On
//      mismatch: return empty estimates (don't ship anything if the
//      engine misbehaved) and flag mutationDetected so the caller can
//      log + alert.

export interface BuildGradedEstimatesInput {
  pricing: CardsightPricingResponse;
  targetParallelId?: string | null;
  targetParallelRawFmv?: number | null;
  /** Mirror of ComputeGradedProjectionInput.targetParallelRawFmvSource. */
  targetParallelRawFmvSource?: "fmv" | "last-sale";
  /** Mirror of ComputeGradedProjectionInput.targetParallelRawFmvAgeDays. */
  targetParallelRawFmvAgeDays?: number | null;
  targetParallelName?: string | null;
  siblingComps?: ReadonlyArray<GradedProjectionSiblingComp>;
  /** Tier-2b release-level grade-premium curve, pre-computed by the caller
   *  via computeReleaseGradeCurve(release, year). When present, fills gap
   *  grades at confidenceTier="rough" / ratioSource="release". */
  releaseRatios?: ReleaseGradeCurve | null;
  /** Human-readable release label for the tier-2b basis string. */
  releaseLabel?: string | null;
  /**
   * CF-ESTIMATOR-PHASE-1 (2026-06-14): trend signal threaded through to
   * forward-project observed-anchor results. Pass `est.trendIQ` here.
   * Null or "insufficient" coverage → factor 1.0 (no forward shift).
   * Only consumed when the engine picks a parallel-observed-same or
   * parallel-observed-sibling anchor.
   */
  trendIQ?: TrendIQResult | null;
  /**
   * CF-ESTIMATOR-PHASE-1 (2026-06-14): card-level parallels[] for the
   * sibling-observed anchor. Sourced from `getCardDetail(cardId).parallels`
   * at the caller. Skipping this field disables the sibling branch
   * (composed → none).
   */
  cardParallels?: ReadonlyArray<{ id: string; name: string; numberedTo?: number | null }>;
  /**
   * CF-ESTIMATOR-PHASE-2 (2026-06-15): auto-base detection signal,
   * threaded to ComputeGradedProjectionInput. See
   * AUTO_BASE_MULTIPLIER_EXPONENT block in gradedPriceProjection.ts.
   */
  isAuto?: boolean;
  /** Observed fields shipped on the same response. Snapshotted pre-call;
   *  asserted byte-identical post-call. The estimator never receives
   *  references to these (it takes only `pricing` + scope params), so
   *  the invariant is structurally guaranteed — this asserts it
   *  explicitly at the integration boundary. */
  snapshots?: {
    marketTierValue?: number | null;
    recentComps?: ReadonlyArray<unknown>;
    gradeBreakdown?: ReadonlyArray<unknown>;
  };
}

export interface BuildGradedEstimatesResult {
  estimates: GradedProjectionResult[];
  /** True iff any snapshot diverged across the engine call. When true,
   *  estimates is forced to []. Callers should log + alert. */
  mutationDetected: boolean;
}

export function buildGradedEstimates(
  input: BuildGradedEstimatesInput,
): BuildGradedEstimatesResult {
  const pricingBefore = JSON.stringify(input.pricing);
  const snapMarketBefore = input.snapshots?.marketTierValue ?? null;
  const snapRecentBefore = JSON.stringify(input.snapshots?.recentComps ?? []);
  const snapBreakdownBefore = JSON.stringify(input.snapshots?.gradeBreakdown ?? []);

  const all = computeGradedProjection({
    pricing: input.pricing,
    targetParallelId: input.targetParallelId,
    targetParallelRawFmv: input.targetParallelRawFmv,
    targetParallelRawFmvSource: input.targetParallelRawFmvSource,
    targetParallelRawFmvAgeDays: input.targetParallelRawFmvAgeDays,
    targetParallelName: input.targetParallelName,
    siblingComps: input.siblingComps,
    releaseRatios: input.releaseRatios,
    releaseLabel: input.releaseLabel,
    trendIQ: input.trendIQ,
    cardParallels: input.cardParallels,
    isAuto: input.isAuto,
  });

  const pricingAfter = JSON.stringify(input.pricing);
  const snapMarketAfter = input.snapshots?.marketTierValue ?? null;
  const snapRecentAfter = JSON.stringify(input.snapshots?.recentComps ?? []);
  const snapBreakdownAfter = JSON.stringify(input.snapshots?.gradeBreakdown ?? []);

  const mutationDetected =
    pricingBefore !== pricingAfter
    || snapMarketBefore !== snapMarketAfter
    || snapRecentBefore !== snapRecentAfter
    || snapBreakdownBefore !== snapBreakdownAfter;

  if (mutationDetected) {
    return { estimates: [], mutationDetected: true };
  }

  // CF-ALWAYS-A-NUMBER (2026-06-12): reverse the Phase 3A drop of tier-3.
  // The new pass-through rules:
  //   • grounded (estimate / rough) → pass through with value + range,
  //     engine's technical basis preserved verbatim.
  //   • ballpark → PASS THROUGH WITH NUMBER + range + tier-rounded value.
  //     Override the engine's technical basis with the scope-labeled
  //     friendly prose so iOS reads "No PSA 10 sales for this Blue
  //     Refractor — extrapolated from the generic grade-premium curve.
  //     Indicative only." The number IS surfaced — anti-leak no longer
  //     applies to ballpark.
  //   • no-data → COLLAPSE to a marker with null value + scope-labeled
  //     "can't anchor an estimate" prose. This is the only remaining
  //     null-value branch.
  // FIREWALL unchanged: ballpark + estimate + rough all stay
  // fairMarketValue/marketValue null, isEstimate true, display-not-
  // train, never a comp. Surfacing the number changes DISPLAY policy,
  // not TRAINING policy.
  const parallelScopeName = input.targetParallelId
    ? (input.targetParallelName && input.targetParallelName.trim().length > 0
       ? input.targetParallelName.trim()
       : "parallel")
    : null;

  const estimates: GradedProjectionResult[] = all.map((r) => {
    // CF-ESTIMATOR-PHASE-1 (2026-06-14): observed-anchor results carry
    // their own scope-labeled basis prose built in computeGradedProjection
    // (buildObservedAnchorBasis), which names the actual source sale +
    // ratios + trend factor. Preserve verbatim — don't run through the
    // generic ballpark/no-data overrides below, which would erase that
    // detail and re-stamp "no related sales" when the candidate pool is
    // non-empty.
    if (
      r.anchorKind === "parallel-observed-same"
      || r.anchorKind === "parallel-observed-sibling"
    ) {
      return r;
    }
    if (r.confidenceTier === "estimate" || r.confidenceTier === "rough") {
      return r;
    }
    if (r.confidenceTier === "ballpark") {
      // CF-ALWAYS-A-NUMBER: surface the number, override basis with the
      // scope-labeled friendly prose. Everything else (value, range,
      // diagnostics, isEstimate, FMV nulls) is preserved.
      return {
        ...r,
        basis: buildBallparkBasis(r.grade, parallelScopeName),
      };
    }
    // no-data (or legacy "insufficient" if it ever leaks through) →
    // collapse to a marker. No value + scope-labeled prose.
    return {
      grade: r.grade,
      estimatedValue: null,
      estimateLow: null,
      estimateHigh: null,
      basis: buildNoDataBasis(r.grade, parallelScopeName),
      confidenceTier: "no-data",
      ratioSource: "none",
      anchorKind: "none",
      isEstimate: true,
      marketValue: null,
      fairMarketValue: null,
      diagnostics: {
        anchorPrice: null,
        cardSpecificBaseSamples: r.diagnostics.cardSpecificBaseSamples,
        ratio: null,
        targetGradeBaseMedian: null,
        baseRawMedian: r.diagnostics.baseRawMedian,
        baseRawSampleCount: r.diagnostics.baseRawSampleCount,
      },
    };
  });
  return { estimates, mutationDetected: false };
}

/** Friendly basis for ballpark entries — surfaces that the number came
 *  from the generic grade-premium table, scope-labeled for parallel vs
 *  base. The number itself is in r.estimatedValue / range; this prose
 *  is the "why it's wide" tap-state context. */
function buildBallparkBasis(
  grade: string,
  parallelScopeName: string | null,
): string {
  const isParallel = parallelScopeName != null && parallelScopeName.length > 0;
  const scope = isParallel ? `this ${parallelScopeName}` : "this card";
  return `No ${grade} sales for ${scope} — extrapolated from the generic grade-premium curve. Indicative only.`;
}

/** Basis for no-data markers — no anchor at all, no grade to multiply.
 *  Distinct from buildInsufficientBasis (the retired pool-count prose):
 *  this is the "can't anchor anything" floor. */
function buildNoDataBasis(
  grade: string,
  parallelScopeName: string | null,
): string {
  const isParallel = parallelScopeName != null && parallelScopeName.length > 0;
  const scopePhrase = isParallel ? ` for this ${parallelScopeName}` : "";
  return `Can't anchor an estimate${scopePhrase} — no sales in ${grade} or any related grade or parallel.`;
}

/**
 * Build the "why" prose for an insufficient marker using observed pool
 * stats. All numeric inputs are OBSERVED counts (real raw / real graded
 * sale counts at this card), preserved from the engine result; the helper
 * never references estimates or derived values. baseRawMedian is
 * intentionally NOT surfaced in the prose — it's pool context, never
 * the grade's value. iOS uses this string verbatim in the row's tap-
 * state.
 *
 * Scope label (Phase 3A addendum-2): when the request is for a parallel
 * (parallelScopeName non-null), the count is labeled "base raw" — the
 * raw sample count comes from the base pool, not the parallel itself —
 * AND the parallel name is named so the user knows which grade gap the
 * prose is about. When base scope (null), prose says "raw sales observed"
 * unmodified, since the count IS the base raw count and "base" is
 * implicit.
 */
function buildInsufficientBasis(
  grade: string,
  baseRawSampleCount: number,
  cardSpecificBaseSamples: number,
  parallelScopeName: string | null,
): string {
  const rawN = baseRawSampleCount;
  const gradedN = cardSpecificBaseSamples;
  const isParallel = parallelScopeName != null && parallelScopeName.length > 0;
  const rawLabel = isParallel ? "base raw" : "raw";
  const rawWord = (n: number) => `${n} ${rawLabel} sale${n === 1 ? "" : "s"}`;
  // "for this {parallel}" frames the gap as scoped to the parallel; base
  // scope omits the phrase (the gap is at the base level).
  const scopePhrase = isParallel ? ` for this ${parallelScopeName}` : " to estimate from";

  if (rawN === 0) {
    return `No data to estimate ${grade}${isParallel ? ` for this ${parallelScopeName}` : ""} — no ${rawLabel} sales observed at this card.`;
  }
  if (gradedN === 0) {
    return `No ${grade} sales yet${scopePhrase} — ${rawWord(rawN)} observed, none graded ${grade}.`;
  }
  // gradedN > 0 but below tier-1 threshold
  return `Not enough ${grade} sales to estimate${isParallel ? ` for this ${parallelScopeName}` : ""} — ${rawWord(rawN)} observed; only ${gradedN} graded ${grade} (need at least ${TIER1_MIN_BASE_SAMPLES}).`;
}

// ── Phase 1c (CF-GRADED-PRICE-PROJECTION) — release-level grade curve ──────
//
// Tier-2b mechanism. Discovers the cards in a (release, year) via
// searchCatalog, harvests each card's getPricing payload with bounded
// concurrency, computes each card's own raw→graded ratio for the liquid
// grades, and returns the value-normalized median per-card ratio across
// the release. Cached at the same 6h TTL as cs:pricing.
//
// Why median-of-per-card-ratios, not a pooled median:
//   The pooled median would let expensive cards (rookies, autos) dominate
//   the curve while commons contribute nothing. The median of per-card
//   ratios is value-normalized — each contributing card votes once,
//   regardless of price.

/** Bounded-concurrency map. Caps in-flight promises; results in input
 *  order. Errors per item resolve to whatever fn() returns for them. */
async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const my = cursor++;
        if (my >= items.length) return;
        results[my] = await fn(items[my]!, my);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Per-card sub-result used by the curve compute step. */
interface PerCardRatios {
  /** Map from grade label ("PSA 10") to that card's raw→graded ratio. */
  ratios: Map<string, number>;
}

function computePerCardRatios(
  pricing: CardsightPricingResponse | null | undefined,
): PerCardRatios | null {
  if (!pricing || (pricing as { notFound?: boolean }).notFound) return null;
  const baseRaw = (pricing.raw?.records ?? []).filter(isBaseRecord);
  const baseRawMed = median(baseRaw.map((r) => r.price));
  if (baseRawMed === null || baseRawMed <= 0) return null;

  const ratios = new Map<string, number>();
  for (const tg of TARGET_GRADES) {
    const recs = selectSalesByGrade(pricing, `${tg.company} ${tg.grade}`);
    const baseRecs = recs.filter(isBaseRecord);
    if (baseRecs.length === 0) continue;
    const gMed = median(baseRecs.map((r) => r.price));
    if (gMed === null || gMed <= 0) continue;
    ratios.set(tg.label, gMed / baseRawMed);
  }
  return { ratios };
}

/** Aggregate per-card ratios into a release curve. Each grade requires
 *  ≥ TIER2_RELEASE_MIN_CONTRIBUTING_CARDS contributing cards. */
function aggregateReleaseCurve(
  perCard: ReadonlyArray<PerCardRatios | null>,
): Array<[string, ReleaseGradeRatio]> {
  const out: Array<[string, ReleaseGradeRatio]> = [];
  for (const tg of TARGET_GRADES) {
    const ratios: number[] = [];
    for (const c of perCard) {
      if (!c) continue;
      const r = c.ratios.get(tg.label);
      if (r != null && Number.isFinite(r) && r > 0) ratios.push(r);
    }
    if (ratios.length < TIER2_RELEASE_MIN_CONTRIBUTING_CARDS) continue;
    const med = median(ratios);
    if (med === null || !Number.isFinite(med) || med <= 0) continue;
    out.push([tg.label, { ratio: med, contributingCards: ratios.length }]);
  }
  return out;
}

/** Discover the cards in a (release, year) via searchCatalog with the
 *  same release-name filter fetchCompsByPlayer uses. Take-25 capped —
 *  pagination is not required for current Cardsight pages but the
 *  cap is documented so future-us knows when to revisit. */
async function discoverReleaseCardIds(
  release: string,
  year: number,
  setName?: string | null,
): Promise<string[]> {
  // Cardsight catalog indexing quirk (documented 2026-06-14): the SAME
  // physical product is sometimes indexed under multiple releaseName
  // values depending on the search query. q="Bowman Chrome" year=2024
  // returns releaseName="Bowman" / setName="Chrome Prospects", which
  // fails an exact releaseName="Bowman Chrome" filter. Only
  // q="Bowman Chrome Prospects Autographs" returns the canonical
  // releaseName="Bowman Chrome" matches. When setName is supplied
  // (pricing.card.set.name is the live source), include it in the
  // query — the catalog then returns the same releaseName the pricing
  // payload uses, and the exact-match filter holds.
  const query =
    setName && setName.trim() ? `${release} ${setName}`.trim() : release;
  const catalog = await searchCatalog(query, { year, take: RELEASE_SEARCH_TAKE });
  const expected = release.toLowerCase().trim();
  return catalog
    .filter(
      (c) =>
        (c.releaseName ?? "").toLowerCase().trim() === expected
        && Number(c.year) === year,
    )
    .map((c) => c.id);
}

/**
 * Compute (or fetch from cache) the release-level grade-premium curve
 * for (release, year). First call in a release populates the cache;
 * subsequent calls within the 6h window reuse it cheaply.
 *
 * Returns an empty Map when discovery returns 0 cards OR every grade
 * has < TIER2_RELEASE_MIN_CONTRIBUTING_CARDS contributing cards. The
 * engine treats an empty curve the same as no curve (falls through to
 * tier 3).
 */
export async function computeReleaseGradeCurve(
  release: string,
  year: number,
  setName?: string | null,
): Promise<ReleaseGradeCurve> {
  const releaseClean = (release ?? "").trim();
  if (!releaseClean || !Number.isFinite(year) || year <= 0) {
    return new Map();
  }
  // Cache key on (release, year) only — setName is a query-shape
  // disambiguator that gets the right card_ids back; the curve itself
  // is keyed on release identity, not on query path.
  const key = `cs:graded-curve:${releaseClean.toLowerCase()}|${year}`;
  const entries = await cacheWrap(
    key,
    async () => {
      const ids = await discoverReleaseCardIds(releaseClean, year, setName);
      if (ids.length === 0) return [];
      const pricings = await runWithConcurrency(
        ids,
        RELEASE_HARVEST_CONCURRENCY,
        (id) => fetchPricing(id).catch(() => null),
      );
      const perCard = pricings.map(computePerCardRatios);
      return aggregateReleaseCurve(perCard);
    },
    RELEASE_CURVE_TTL_SEC,
  );
  return new Map(entries);
}

/** Exposed for direct unit testing — feeds an array of (already-fetched)
 *  pricings into the same per-card → median aggregation the live path
 *  uses. Keeps the live path's network calls out of test scope. */
export function aggregateReleaseGradeCurveFromPricings(
  pricings: ReadonlyArray<CardsightPricingResponse | null>,
): ReleaseGradeCurve {
  const perCard = pricings.map(computePerCardRatios);
  return new Map(aggregateReleaseCurve(perCard));
}
