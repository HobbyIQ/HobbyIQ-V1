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
  selectSalesByGrade,
  getGraderPremium,
} from "./compiqEstimate.service.js";
import { lookupMultiplier } from "./chromeDraftMultipliers.js";
import { isBaseTitle } from "./parallelTitleMatch.js";

// ── Public types ───────────────────────────────────────────────────────────

export type GradedProjectionConfidenceTier =
  | "estimate"      // tier-1 card ratio × base raw anchor (cleanest)
  | "rough"         // tier-1 card ratio × parallel anchor (compose noise)
  | "ballpark"      // tier-3 market ratio × any anchor
  | "insufficient"; // missing anchor or no ratio source

export type GradedProjectionRatioSource = "card" | "market" | "none";

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

function resolveRatio(
  company: string,
  grade: string,
  label: string,
  baseRawMedian: number | null,
  pricing: CardsightPricingResponse,
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
  // Tier 2 (Phase 1b) — player/set-level aggregated ratio. Clean seam.
  //
  // const playerSetRatio = resolvePlayerSetRatio(...);
  // if (playerSetRatio) return { ...playerSetRatio, source: "player-set" };

  // Tier 3 — market grade-premium table (read-only).
  const marketPremium = getGraderPremium(company, grade);
  if (marketPremium > 0 && marketPremium !== 1.0) {
    return {
      ratio: marketPremium,
      source: "market",
      description: `${label} fell back to market grade-premium table (${marketPremium.toFixed(3)}×) — only ${cardSpecificBaseSamples} card-specific base sale(s), below the tier-1 threshold of ${TIER1_MIN_BASE_SAMPLES}`,
      cardSpecificBaseSamples,
      targetGradeBaseMedian: null,
    };
  }
  return {
    ratio: null,
    source: "none",
    description: `${label} has no card-specific data (n=${cardSpecificBaseSamples}) and no market premium`,
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
  // ratioSource === "card"
  if (anchorKind === "base") return "estimate";
  return "rough"; // parallel-observed or parallel-composed
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
    const ratio = resolveRatio(
      tg.company,
      tg.grade,
      tg.label,
      baseRawMedian,
      pricing,
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
