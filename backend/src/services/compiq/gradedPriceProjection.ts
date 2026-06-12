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
} from "./cardsight.client.js";
import {
  searchCatalog,
  getPricing as fetchPricing,
} from "./cardsight.client.js";
import {
  selectSalesByGrade,
  getGraderPremium,
  detectGradeFromTitle,
} from "./compiqEstimate.service.js";
import { lookupMultiplier } from "./chromeDraftMultipliers.js";
import { isBaseTitle } from "./parallelTitleMatch.js";
import { tokenizeParallel } from "./cardsight.mapper.js";
import { cacheWrap } from "../shared/cache.service.js";

// ── Public types ───────────────────────────────────────────────────────────

export type GradedProjectionConfidenceTier =
  | "estimate"      // tier-1 card ratio × base raw anchor (cleanest)
  | "rough"         // tier-1 card ratio × parallel anchor (compose noise)
  | "ballpark"      // tier-3 market ratio × any anchor
  | "insufficient"; // missing anchor or no ratio source

export type GradedProjectionRatioSource =
  | "card"        // Tier 1: card-specific base graded/raw ratio
  | "player-set"  // Tier 2a: aggregated across sibling cards (same player, same release)
  | "release"     // Tier 2b: median per-card ratio across the entire release (set-level curve)
  | "market"      // Tier 3: existing GRADER_PREMIUMS table
  | "none";       // Insufficient (no anchor or no ratio source available)

export type GradedProjectionAnchorKind =
  | "base"
  | "parallel-observed"
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
 */
function countObservedInScope(
  pricing: CardsightPricingResponse,
  company: string,
  grade: string,
  targetParallelId: string | null | undefined,
  targetParallelName: string | null | undefined,
): number {
  const records = selectSalesByGrade(pricing, `${company} ${grade}`);
  if (records.length === 0) return 0;

  // BASE scope
  if (!targetParallelId) {
    return records.filter(isBaseRecord).length;
  }

  // PARALLEL scope — strict tag first
  const strict = records.filter((r) => r.parallel_id === targetParallelId);
  if (strict.length > 0) return strict.length;

  // PARALLEL scope — title-token fallback (untagged Cardsight records)
  if (targetParallelName) {
    const tokens = tokenizeParallel(targetParallelName);
    if (tokens.length === 0) return 0;
    const patterns = tokens.map(
      (t) => new RegExp(`\\b${escapeRegex(t)}\\b`, "i"),
    );
    return records.filter((r) => {
      const title = r.title ?? "";
      return patterns.every((p) => p.test(title));
    }).length;
  }
  return 0;
}

// ── Anchor resolution ──────────────────────────────────────────────────────

interface ResolvedAnchor {
  price: number | null;
  kind: GradedProjectionAnchorKind;
  description: string;
}

function resolveAnchor(
  baseRawMedian: number | null,
  baseRawSampleCount: number,
  opts: {
    targetParallelId?: string | null;
    targetParallelRawFmv?: number | null;
    targetParallelName?: string | null;
  },
): ResolvedAnchor {
  // Parallel target
  if (opts.targetParallelId) {
    // Parallel-observed: caller provided a parallel-raw anchor
    const pf = opts.targetParallelRawFmv;
    if (typeof pf === "number" && Number.isFinite(pf) && pf > 0) {
      return {
        price: pf,
        kind: "parallel-observed",
        description: `parallel raw anchor ${fmtUSD(pf)} (observed single-sale or thin pool)`,
      };
    }
    // Parallel-composed: base × parallel multiplier
    if (
      baseRawMedian !== null
      && baseRawMedian > 0
      && opts.targetParallelName
    ) {
      const entry = lookupMultiplier(opts.targetParallelName);
      if (entry && Number.isFinite(entry.baseMultiplier) && entry.baseMultiplier > 0) {
        const composed = round2(baseRawMedian * entry.baseMultiplier);
        return {
          price: composed,
          kind: "parallel-composed",
          description: `composed parallel anchor ${fmtUSD(composed)} = base raw median ${fmtUSD(baseRawMedian)} (n=${baseRawSampleCount}) × ${entry.parallelName} multiplier (${entry.baseMultiplier.toFixed(3)}×)`,
        };
      }
    }
    return {
      price: null,
      kind: "none",
      description: `no parallel anchor (no observed raw FMV, no composable parallel multiplier)`,
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

  // Tier 3 — market grade-premium table (read-only).
  const marketPremium = getGraderPremium(company, grade);
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

function classifyConfidence(
  anchorKind: GradedProjectionAnchorKind,
  ratioSource: GradedProjectionRatioSource,
): GradedProjectionConfidenceTier {
  if (anchorKind === "none" || ratioSource === "none") return "insufficient";
  if (ratioSource === "market") return "ballpark";
  if (ratioSource === "player-set") return "rough";
  if (ratioSource === "release") return "rough";
  // ratioSource === "card"
  if (anchorKind === "base") return "estimate";
  return "rough"; // parallel-observed or parallel-composed with card ratio
}

/** Range as a fraction of the point estimate — widens with lower confidence. */
function spreadFor(tier: GradedProjectionConfidenceTier): number {
  switch (tier) {
    case "estimate":     return 0.10;
    case "rough":        return 0.20;
    case "ballpark":     return 0.30;
    case "insufficient": return 0;
  }
}

// ── Engine ─────────────────────────────────────────────────────────────────

export function computeGradedProjection(
  input: ComputeGradedProjectionInput,
): GradedProjectionResult[] {
  const {
    pricing,
    targetParallelId,
    targetParallelRawFmv,
    targetParallelName,
    siblingComps = [],
    releaseRatios = null,
    releaseLabel = null,
    targetGrades = TARGET_GRADES,
  } = input;

  // Base raw anchor: parallel_id null AND title carries no finish tokens.
  const rawRecords = pricing.raw?.records ?? [];
  const baseRawRecords = rawRecords.filter(isBaseRecord);
  const baseRawMedian = median(baseRawRecords.map((r) => r.price));
  const baseRawSampleCount = baseRawRecords.length;

  // Anchor — resolved once per call (parallel target shares anchor across
  // all target grades; base target shares the base raw median).
  const anchor = resolveAnchor(baseRawMedian, baseRawSampleCount, {
    targetParallelId,
    targetParallelRawFmv,
    targetParallelName,
  });

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

    const ratio = resolveRatio(
      tg.company,
      tg.grade,
      tg.label,
      baseRawMedian,
      pricing,
      siblingComps,
      releaseRatios,
      releaseLabel,
    );
    const tier = classifyConfidence(anchor.kind, ratio.source);

    let estimatedValue: number | null = null;
    let estimateLow: number | null = null;
    let estimateHigh: number | null = null;
    if (
      anchor.price !== null
      && ratio.ratio !== null
      && tier !== "insufficient"
    ) {
      const v = round2(anchor.price * ratio.ratio);
      const s = spreadFor(tier);
      estimatedValue = v;
      estimateLow = round2(v * (1 - s));
      estimateHigh = round2(v * (1 + s));
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
  return results;
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
  targetParallelName?: string | null;
  siblingComps?: ReadonlyArray<GradedProjectionSiblingComp>;
  /** Tier-2b release-level grade-premium curve, pre-computed by the caller
   *  via computeReleaseGradeCurve(release, year). When present, fills gap
   *  grades at confidenceTier="rough" / ratioSource="release". */
  releaseRatios?: ReleaseGradeCurve | null;
  /** Human-readable release label for the tier-2b basis string. */
  releaseLabel?: string | null;
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
    targetParallelName: input.targetParallelName,
    siblingComps: input.siblingComps,
    releaseRatios: input.releaseRatios,
    releaseLabel: input.releaseLabel,
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

  const grounded = all.filter(
    (r) => r.confidenceTier === "estimate" || r.confidenceTier === "rough",
  );
  return { estimates: grounded, mutationDetected: false };
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
): Promise<string[]> {
  const catalog = await searchCatalog(release, { year, take: RELEASE_SEARCH_TAKE });
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
): Promise<ReleaseGradeCurve> {
  const releaseClean = (release ?? "").trim();
  if (!releaseClean || !Number.isFinite(year) || year <= 0) {
    return new Map();
  }
  const key = `cs:graded-curve:${releaseClean.toLowerCase()}|${year}`;
  const entries = await cacheWrap(
    key,
    async () => {
      const ids = await discoverReleaseCardIds(releaseClean, year);
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
