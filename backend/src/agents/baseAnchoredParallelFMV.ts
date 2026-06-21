// CF-BUILD-B (2026-06-21): base-anchored parallel FMV — Build B.
//
// Consumes the engine's calibrated `baseRelativePremium` from the
// multiplier table to price holdings whose comp pool can't anchor
// mechanism1 (e.g. Hartman: 64 base autos, 0 Ref/499 sales, mechanism1
// fails at curatedParallelCount < 3). For those holdings the only
// honestly-available signal is the holding's OWN base-auto pool ×
// an empirical paired premium calibrated from the broader CPA corpus.
//
// Locked design choices (docs/build-b-off-sample-tier-handling.md):
//   §1+2  Strict-set min/max sampleBaseRange + boolean above-max detection
//   §3    Off-sample low-end from observed topBaseBucketRatio when ≥3
//         cards in bucket, else flagged 0.7× haircut.
//   §4    Distinct estimateBasis off-sample vs in-sample; tier-extrapolated
//         flag; emits through the CF-A(a) honesty path.
//   §5    In-sample = relaxed-IQR band, no extrapolation flag.
//   §6    provenance === "empirical" required to fire (dormancy gate).
//   §7    Optional sampleBaseRange + topBaseBucketRatio fields on
//         BaseRelativePremium.
//
// Dormancy: at ship, zero rows carry the new fields → Build B returns
// null for every lookup → no live pricing change.

import {
  lookupBowmanFamilyEntry,
  type BaseRelativePremium,
  type BowmanFamilyProduct,
  type BowmanFamilySubset,
} from "../services/compiq/chromeDraftMultipliers.js";
import { isBaseAutoTitle } from "../curation/multiplierCalibration/saleClassifier.js";

/**
 * CF-BUILD-B (2026-06-21): low-end fallback when topBaseBucketRatio is
 * null (top bucket has <3 cards, can't honestly anchor on observed data).
 * The 0.7× value is documented and flagged in iOS as an extrapolation —
 * not a number we expect to defend point-precisely, but a coarse honest
 * floor that's clearly NOT data-derived.
 */
export const ROUND_HAIRCUT_FRACTION = 0.7;

/**
 * Minimum base-auto sale count on the holding's own pool before Build B
 * fires. Below this, the holding's base median is too thin to anchor
 * the per-holding pricing.
 */
export const MIN_BASE_AUTO_COMPS = 3;

export interface BaseAnchoredFmvSubject {
  playerName: string;
  year: number;
  product: BowmanFamilyProduct;
  subset: BowmanFamilySubset;
  parallelName: string;
}

export interface BaseAnchoredFmvComp {
  title: string;
  price: number;
}

export type BaseAnchoredEstimateBasis =
  | "base_anchored_paired_premium"
  | "base_anchored_off_sample_paired_premium";

export interface BaseAnchoredFmvResult {
  /** Centroid of the emitted band — the "best single number" for UX point displays. */
  estimatedValue: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  estimateBasis: BaseAnchoredEstimateBasis | null;
  valuationStatus: "estimated" | null;
  isEstimate: boolean;
  /** Off-sample emission carries the tier-extrapolated flag; in-sample does not. */
  tierExtrapolated: boolean;
  /**
   * "rough" for in-sample, "ballpark" for off-sample. null when Build B
   * didn't fire.
   */
  confidence: "rough" | "ballpark" | null;
  /**
   * Reason Build B did or didn't fire (audit trail; never surfaced to
   * the wire).
   */
  internalReason:
    | "fired-in-sample"
    | "fired-off-sample-observed-bucket"
    | "fired-off-sample-haircut-fallback"
    | "no-curated-row"
    | "provenance-not-empirical"
    | "missing-sample-base-range"
    | "insufficient-base-autos"
    | "non-positive-base-median";
  /** Holding's own base-auto median ($/sale). Surfaced for diagnostics. */
  baseAutoMedian: number | null;
  baseAutoCount: number;
}

const NULL_RESULT_BASE: Omit<BaseAnchoredFmvResult, "internalReason"> = {
  estimatedValue: null,
  estimateLow: null,
  estimateHigh: null,
  estimateBasis: null,
  valuationStatus: null,
  isEstimate: false,
  tierExtrapolated: false,
  confidence: null,
  baseAutoMedian: null,
  baseAutoCount: 0,
};

function nullResult(reason: BaseAnchoredFmvResult["internalReason"]): BaseAnchoredFmvResult {
  return { ...NULL_RESULT_BASE, internalReason: reason };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * CF-BUILD-B (2026-06-21): the main entry point. Returns a null result
 * (every field null/false except internalReason) when Build B can't
 * honestly fire. Returns a populated estimated-tier result when the
 * full gate chain passes.
 */
export function computeBaseAnchoredParallelFMV(params: {
  subject: BaseAnchoredFmvSubject;
  comps: ReadonlyArray<BaseAnchoredFmvComp>;
}): BaseAnchoredFmvResult {
  const { subject, comps } = params;

  // ─── Gate 1: curated row exists at the subject's year-strict lookup ─
  const row = lookupBowmanFamilyEntry({
    product: subject.product,
    subset: subject.subset,
    parallelName: subject.parallelName,
    year: subject.year,
  });
  if (!row) return nullResult("no-curated-row");

  // ─── Gate 2: row carries a baseRelativePremium ──────────────────────
  const premium: BaseRelativePremium | undefined = row.baseRelativePremium;
  if (!premium) return nullResult("no-curated-row");

  // ─── Gate 3: empirical provenance (dormancy gate) ──────────────────
  if (premium.provenance !== "empirical") {
    return nullResult("provenance-not-empirical");
  }

  // ─── Gate 4: sampleBaseRange must exist (CF-BUILD-B engine fields) ─
  // Older calibrations (pre-CF-BUILD-B) may have shipped without these
  // fields. Without the range Build B has no honest off-sample detection,
  // so we hold rather than guess.
  if (!premium.sampleBaseRange) return nullResult("missing-sample-base-range");

  // ─── Gate 5: holding has enough base-auto comps to anchor ──────────
  const baseAutoPrices = comps
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && isBaseAutoTitle(c.title))
    .map((c) => Number(c.price));
  if (baseAutoPrices.length < MIN_BASE_AUTO_COMPS) {
    return {
      ...nullResult("insufficient-base-autos"),
      baseAutoCount: baseAutoPrices.length,
    };
  }

  const baseMedian = median(baseAutoPrices);
  if (baseMedian === null || baseMedian <= 0) {
    return {
      ...nullResult("non-positive-base-median"),
      baseAutoCount: baseAutoPrices.length,
    };
  }

  // ─── In-sample vs off-sample classification ────────────────────────
  const [, sampleMax] = premium.sampleBaseRange;
  const isOffSample = baseMedian > sampleMax;

  if (!isOffSample) {
    // §5 — In-sample: relaxed-IQR band, no extrapolation flag.
    const [rangeLow, rangeHigh] = premium.range;
    const estimateLow = round2(baseMedian * rangeLow);
    const estimateHigh = round2(baseMedian * rangeHigh);
    const estimatedValue = round2(baseMedian * premium.value);
    return {
      estimatedValue,
      estimateLow,
      estimateHigh,
      estimateBasis: "base_anchored_paired_premium",
      valuationStatus: "estimated",
      isEstimate: true,
      tierExtrapolated: false,
      confidence: "rough",
      internalReason: "fired-in-sample",
      baseAutoMedian: round2(baseMedian),
      baseAutoCount: baseAutoPrices.length,
    };
  }

  // §3/§4 — Off-sample: observed top-base-bucket ratio when available,
  // else flagged round haircut.
  //
  // CF-BUILD-B (live-data refinement, 2026-06-21): the band is
  // [min(value, anchorRatio), max(value, anchorRatio)] — NOT a hardcoded
  // (anchor=low, flat=high). Drew's original spec assumed tier-shrink
  // (high-base cards show LOWER ratios than the global median, the
  // CF-X2-ANCHOR pattern), but the first live engine run on 2026 Bowman
  // CPA's BXF/150 showed the opposite for that scope: top-base bucket
  // ratio 3.254× > flat premium 2.974×. High-tier players' parallels
  // carry an additional scarcity premium beyond the flat ratio in this
  // dataset. Building min/max handles BOTH directions honestly without
  // committing to a tier-direction prior.
  let anchorRatio: number;
  let internalReason: BaseAnchoredFmvResult["internalReason"];
  if (
    premium.topBaseBucketRatio !== null &&
    premium.topBaseBucketRatio !== undefined &&
    premium.topBaseBucketRatio > 0
  ) {
    anchorRatio = premium.topBaseBucketRatio;
    internalReason = "fired-off-sample-observed-bucket";
  } else {
    // Haircut fallback: bucket too thin to observe. Assume conservative
    // shrink prior (since we have NO data to disprove it) — anchorRatio
    // < value → emitted as the low end of the band.
    anchorRatio = ROUND_HAIRCUT_FRACTION * premium.value;
    internalReason = "fired-off-sample-haircut-fallback";
  }

  const lowRatio = Math.min(premium.value, anchorRatio);
  const highRatio = Math.max(premium.value, anchorRatio);
  const estimateLow = round2(baseMedian * lowRatio);
  const estimateHigh = round2(baseMedian * highRatio);
  const estimatedValue = round2((estimateLow + estimateHigh) / 2);
  return {
    estimatedValue,
    estimateLow,
    estimateHigh,
    estimateBasis: "base_anchored_off_sample_paired_premium",
    valuationStatus: "estimated",
    isEstimate: true,
    tierExtrapolated: true,
    confidence: "ballpark",
    internalReason,
    baseAutoMedian: round2(baseMedian),
    baseAutoCount: baseAutoPrices.length,
  };
}
