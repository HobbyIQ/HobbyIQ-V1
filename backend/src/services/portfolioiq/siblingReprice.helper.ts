// CF-SIBLING-FALLBACK-WIRE-IN (Drew, 2026-07-28).
//
// Pure helper that maps a successful sibling-fallback result to the
// per-grade FMV the reprice path should stamp on a target holding.
//
// The sibling fallback returns Raw + PSA 10 explicitly. For grades in
// between (PSA 9, BGS 8.5, etc.) we don't have a defensible multiplier
// here without touching GRADE_CALIBRATION — and Drew's memory is
// explicit about the empirical-only doctrine. So this helper returns
// null for "other" grades, leaving the holding to fall through to the
// existing skip persist. Honest silence over an inferred number.
//
// D4 PR 5 (2026-08-29): the same rule now covers the PARALLEL axis —
// the sibling service returns null when no measured premium exists, so
// nothing here ever sees a floor-lifted number, and the basis note names
// the measurement (sample size, matched set) instead of a floor.

import type { SiblingFallbackResult } from "../compiq/siblingCardPriceFallback.service.js";

export type SiblingRepriceGradeMatch =
  | { grade: "raw"; price: number }
  | { grade: "psa-10"; price: number }
  | null;

/**
 * Given a sibling-fallback result and a target holding's grade
 * (gradeCompany + gradeValue), return the sibling-derived FMV that
 * applies at that grade — or null when the sibling result can't be
 * used at this grade tier.
 *
 * Match rules:
 *   - Raw (no gradeCompany, or gradeCompany falsy) → estimatedRawPrice
 *   - PSA 10 exactly → estimatedPSA10Price
 *   - Anything else → null (skip; caller falls back to Missing)
 */
export function mapSiblingToRepriceFmv(
  sibling: Pick<SiblingFallbackResult, "estimatedRawPrice" | "estimatedPSA10Price">,
  gradeCompany: string | null | undefined,
  gradeValue: number | null | undefined,
): SiblingRepriceGradeMatch {
  const isRaw = !gradeCompany || gradeCompany.trim() === "";
  if (isRaw) {
    if (typeof sibling.estimatedRawPrice === "number" && sibling.estimatedRawPrice > 0) {
      return { grade: "raw", price: sibling.estimatedRawPrice };
    }
    return null;
  }
  const isPsa10 = gradeCompany.toUpperCase() === "PSA" && gradeValue === 10;
  if (isPsa10) {
    if (typeof sibling.estimatedPSA10Price === "number" && sibling.estimatedPSA10Price > 0) {
      return { grade: "psa-10", price: sibling.estimatedPSA10Price };
    }
    return null;
  }
  return null;
}

/**
 * Format the estimateBasis string persisted on the holding so it's
 * self-describing when a KQL query surfaces "why is this card estimated
 * from a sibling?" — which sibling, which measured premium, and how many
 * paired observations stand behind it.
 */
export function siblingEstimateBasis(
  sibling: Pick<
    SiblingFallbackResult,
    | "siblingCardId"
    | "parallelPremium"
    | "premiumSampleSize"
    | "premiumMatchedSet"
    | "premiumUsedProxy"
  >,
): string {
  const proxy = sibling.premiumUsedProxy ? " proxy" : "";
  return `sibling: ${sibling.siblingCardId} × ${sibling.parallelPremium.toFixed(2)}× parallel (empirical n=${sibling.premiumSampleSize}, ${sibling.premiumMatchedSet}${proxy})`;
}
