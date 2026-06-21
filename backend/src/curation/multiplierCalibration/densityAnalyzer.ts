// CF-CAT-ENGINE (2026-06-21): density analysis + n-gated provenance
// assignment. Aggregates per-card paired-ratio buckets into per-tier
// density verdicts and computes the calibration centerpoint + range that
// goes into the BaseRelativePremium worksheet row.
//
// The n-gate is the CF-XMULT lock: n_strict ≥ 5 → "empirical"; otherwise
// "sibling_provisional" (the gate Drew set on Blue X-Fractor /150 at
// n=2 strict). Provenance is NEVER auto-promoted at runtime — that's
// CF-C's data-poisoning invariant. The engine only proposes the flag
// in the worksheet; the owner-PR-review step is what makes it real.

import {
  pairedRatiosStrict,
  pairedRatiosRelaxed,
  median,
  percentile,
  type PerCardBuckets,
  type PairedBasis,
  type PairedRatio,
} from "./pairedRatio.js";

export interface TierDensity {
  tierKey: string;
  /** Total sales of this tier across the scope. */
  totalSales: number;
  /** Distinct cards carrying ≥1 sale of this tier. */
  distinctCards: number;
  /** Per-basis paired counts. */
  baseAuto: { strictN: number; relaxedN: number };
  ref499: { strictN: number; relaxedN: number };
}

export interface TierPremiumCandidate {
  tierKey: string;
  basis: PairedBasis;
  /** Centerpoint — strict-paired median when strictN ≥ 2; relaxed median otherwise; null when relaxed-empty. */
  centerpoint: number | null;
  /** Honest spread — IQR of the relaxed-paired ratios (p25–p75). */
  range: [number, number] | null;
  /** Strict-paired n (the n-gate's input). */
  nStrict: number;
  /** Relaxed-paired n (sample-size context). */
  nRelaxed: number;
  /** Per-card detail for audit. */
  pairedStrict: PairedRatio[];
  pairedRelaxed: PairedRatio[];
}

export interface TierProvenanceVerdict {
  /** "empirical" — n_strict ≥ MIN_EMPIRICAL_N. */
  provenance: "empirical" | "sibling_provisional";
  /** Human-readable reason for the verdict. */
  reason: string;
}

/**
 * CF-XMULT pattern: n_strict ≥ 5 paired-cards required for empirical
 * promotion. Below that, the row stays "sibling_provisional" — the gate
 * that prevents T3 collision-win on thin calibration.
 */
export const MIN_EMPIRICAL_N = 5;

export function analyzeTier(
  perCard: ReadonlyArray<PerCardBuckets>,
  tierKey: string,
): TierDensity {
  let totalSales = 0;
  let distinctCards = 0;
  for (const card of perCard) {
    const prices = card.tiers.get(tierKey) ?? [];
    if (prices.length > 0) {
      distinctCards += 1;
      totalSales += prices.length;
    }
  }
  const baseStrict = pairedRatiosStrict(perCard, tierKey, "base-auto").length;
  const baseRelaxed = pairedRatiosRelaxed(perCard, tierKey, "base-auto").length;
  const refStrict = pairedRatiosStrict(perCard, tierKey, "ref-499").length;
  const refRelaxed = pairedRatiosRelaxed(perCard, tierKey, "ref-499").length;
  return {
    tierKey,
    totalSales,
    distinctCards,
    baseAuto: { strictN: baseStrict, relaxedN: baseRelaxed },
    ref499: { strictN: refStrict, relaxedN: refRelaxed },
  };
}

export function computeTierPremium(
  perCard: ReadonlyArray<PerCardBuckets>,
  tierKey: string,
  basis: PairedBasis,
): TierPremiumCandidate {
  const strict = pairedRatiosStrict(perCard, tierKey, basis);
  const relaxed = pairedRatiosRelaxed(perCard, tierKey, basis);
  const strictRatios = strict.map((p) => p.ratio);
  const relaxedRatios = relaxed.map((p) => p.ratio);

  // Centerpoint: strict median when strict has signal; else relaxed median.
  // (The CF-XMULT precedent: when strict n=2 and relaxed n=16 converge,
  // center on convergence; here we default to strict-when-present which
  // is the conservative choice. The gate decision below is the
  // load-bearing question — value freshness is secondary to honest
  // provenance.)
  const centerpoint =
    strict.length >= 2 ? median(strictRatios) :
    relaxed.length >= 1 ? median(relaxedRatios) :
    null;

  // Range: relaxed IQR (p25–p75). Honest spread per CF-XMULT (A4) pattern.
  const p25 = percentile(relaxedRatios, 0.25);
  const p75 = percentile(relaxedRatios, 0.75);
  const range: [number, number] | null =
    p25 !== null && p75 !== null ? [p25, p75] : null;

  return {
    tierKey,
    basis,
    centerpoint,
    range,
    nStrict: strict.length,
    nRelaxed: relaxed.length,
    pairedStrict: strict,
    pairedRelaxed: relaxed,
  };
}

/**
 * n-gated provenance. CF-XMULT lock: n_strict ≥ 5 → "empirical"; else
 * "sibling_provisional". This is the gate, not a heuristic — it directly
 * controls whether T3 collision-win is unlocked downstream.
 */
export function assignProvenance(nStrict: number): TierProvenanceVerdict {
  if (nStrict >= MIN_EMPIRICAL_N) {
    return {
      provenance: "empirical",
      reason: `n_strict=${nStrict} clears the ≥${MIN_EMPIRICAL_N} threshold`,
    };
  }
  return {
    provenance: "sibling_provisional",
    reason: `n_strict=${nStrict} below ≥${MIN_EMPIRICAL_N} threshold; held provisional`,
  };
}

/**
 * Lossy Ref-relative derivation from a base-relative premium. CF-CAT-RECON
 * called this out: derivation between axes propagates noise, and the
 * engine writes each axis independently from its own paired data — this
 * helper exists for the narrow case where mechanism1 needs a Ref-relative
 * value AND the base-relative axis has the only viable n.
 *
 * `refOverBase` is the cross-card median of (Ref/499 / base-auto) paired
 * ratios — the "Refractor /499's own base-relative premium" — i.e. the
 * unit anchor's position on the base axis. For 2026 Bowman CPA this was
 * ~1.54× (CF-X2-ANCHOR). When unavailable, returns null.
 */
export function deriveRefRelativeFromBase(
  baseRelative: number,
  refOverBase: number | null,
): number | null {
  if (refOverBase === null || refOverBase <= 0) return null;
  return baseRelative / refOverBase;
}

/**
 * Top-level analysis: for a list of tier keys, produce density + premium +
 * provenance verdicts on the base-relative axis (primary). Ref/499 is
 * computed alongside for the worksheet's "derived where mechanism1 needs
 * it" surface.
 */
export interface TierAnalysisResult {
  tierKey: string;
  density: TierDensity;
  baseRelative: TierPremiumCandidate;
  refRelative: TierPremiumCandidate;
  provenance: TierProvenanceVerdict;
  firmNow: boolean;
}

export function analyzeAllTiers(
  perCard: ReadonlyArray<PerCardBuckets>,
  tierKeys: ReadonlyArray<string>,
): TierAnalysisResult[] {
  return tierKeys.map((tierKey) => {
    const density = analyzeTier(perCard, tierKey);
    const baseRelative = computeTierPremium(perCard, tierKey, "base-auto");
    const refRelative = computeTierPremium(perCard, tierKey, "ref-499");
    // Provenance is gated on the BASE-RELATIVE n (primary axis per
    // CF-CAT-RECON). Ref-relative provenance is derived independently
    // only when emitted to a worksheet row.
    const provenance = assignProvenance(baseRelative.nStrict);
    const firmNow = provenance.provenance === "empirical";
    return {
      tierKey,
      density,
      baseRelative,
      refRelative,
      provenance,
      firmNow,
    };
  });
}

/** Discover every tier key present across the corpus. */
export function discoverTierKeys(
  perCard: ReadonlyArray<PerCardBuckets>,
): string[] {
  const keys = new Set<string>();
  for (const card of perCard) for (const k of card.tiers.keys()) keys.add(k);
  return [...keys].sort();
}
