// CF-GRADE-CALIBRATION (Drew, 2026-07-20). Human-maintained code lives
// in this file; auto-generated data (GRADE_CALIBRATION +
// GRADE_CALIBRATION_BY_SPORT) lives in gradeCalibrationData.ts and is
// regenerated weekly by the Grade Calibration Refresh workflow.
//
// This split lets the workflow rewrite data without clobbering the
// classifier / lookup logic below. Consumers should import from this
// module (not the data module directly) so both surfaces travel
// together.
//
// Read at rung 5 of canonicalFmv.service.ts + at the empirical path
// in observedGradeCurve.service.ts. Returns null when the
// (family, grader) pair isn't covered — caller emits
// `grade_multiplier_uncovered` telemetry.

import {
  GRADE_CALIBRATION,
  GRADE_CALIBRATION_BY_SPORT,
  type GradeCalibrationEntry,
  type GradeCalibrationTierEntry,
} from "./gradeCalibrationData.js";

export { GRADE_CALIBRATION, GRADE_CALIBRATION_BY_SPORT };
export type { GradeCalibrationEntry, GradeCalibrationTierEntry };

/** Lookup helper. Returns null when the (family, grader) is uncovered.
 *  When `sport` is provided, prefers sport-specific calibration; falls
 *  back to the baseline table (currently baseball-derived). */
export function lookupGradeRatio(
  family: string,
  grader: string,
  sport?: string | null,
): number | null {
  if (sport) {
    const sportEntry = GRADE_CALIBRATION_BY_SPORT[sport]?.[family]?.[grader];
    if (sportEntry) return sportEntry.medianRatio;
    // No sport-specific entry — for non-baseball sports we intentionally
    // FALL THROUGH to the baseline table so the app still returns a
    // number. Downstream telemetry can track "sport uncovered" as a
    // signal to prioritize regenerating per-sport calibration.
  }
  const entry = GRADE_CALIBRATION[family]?.[grader];
  return entry ? entry.medianRatio : null;
}

// CF-GRADE-CALIBRATE-PER-TIER (Drew, 2026-07-22). Empirical per-tier
// lookup used by observedGradeCurve when it wants a specific grade
// multiplier (e.g. PSA 9 vs the company-level median). Returns null
// when the specific tier isn't covered so the caller can fall back to
// company-level × subTierScaling. Prefers sport-specific data with
// baseline fallback, mirroring lookupGradeRatio.
export function lookupGradeRatioByTier(
  family: string,
  grader: string,
  gradeValue: number,
  sport?: string | null,
): number | null {
  const tierKey = String(gradeValue);
  if (sport) {
    const sportEntry = GRADE_CALIBRATION_BY_SPORT[sport]?.[family]?.[grader];
    const sportTier = sportEntry?.byTier?.[tierKey];
    if (sportTier) return sportTier.medianRatio;
  }
  const baselineEntry = GRADE_CALIBRATION[family]?.[grader];
  const baselineTier = baselineEntry?.byTier?.[tierKey];
  if (baselineTier) return baselineTier.medianRatio;
  // Try the "other" fallback family — it aggregates every named family
  // and typically has broader tier coverage.
  const otherEntry = GRADE_CALIBRATION["other"]?.[grader];
  const otherTier = otherEntry?.byTier?.[tierKey];
  if (otherTier) return otherTier.medianRatio;
  return null;
}

/** Product-family classifier matching the calibration script. Any set
 *  string maps to a canonical family key or "other".
 *  Order matters: more-specific tokens must come BEFORE generic ones
 *  (e.g. "topps chrome update" before "topps chrome" before "topps"). */
export function classifyFamily(setName: string | null | undefined): string {
  const s = String(setName ?? "").toLowerCase();
  if (s.includes("bowman chrome draft") || s.includes("bowman draft chrome")) return "bowman-chrome-draft";
  if (s.includes("bowman chrome")) return "bowman-chrome";
  if (s.includes("bowman sterling")) return "bowman-sterling";
  if (s.includes("bowman")) return "bowman";
  if (s.includes("topps chrome update")) return "topps-chrome-update";
  if (s.includes("topps chrome")) return "topps-chrome";
  if (s.includes("topps update")) return "topps-update";
  if (s.includes("topps heritage")) return "topps-heritage";
  if (s.includes("topps finest")) return "topps-finest";
  if (s.includes("topps pristine")) return "topps-pristine";
  if (s.includes("allen & ginter") || s.includes("allen and ginter")) return "topps-allen-ginter";
  if (s.includes("topps stadium club") || s.includes("stadium club")) return "topps-stadium-club";
  if (s.includes("topps")) return "topps";
  if (s.includes("prizm")) return "panini-prizm";
  if (s.includes("select")) return "panini-select";
  if (s.includes("mosaic")) return "panini-mosaic";
  if (s.includes("donruss")) return "panini-donruss";
  if (s.includes("optic")) return "panini-optic";
  // CF-FB-BB-BRANDS (Drew, 2026-07-20). Extended for FB/BB-specific
  // product lines uncovered by baseball-only classifier.
  if (s.includes("hoops")) return "panini-hoops";
  if (s.includes("contenders")) return "panini-contenders";
  if (s.includes("national treasures")) return "panini-national-treasures";
  if (s.includes("immaculate")) return "panini-immaculate";
  if (s.includes("flawless")) return "panini-flawless";
  if (s.includes("chronicles")) return "panini-chronicles";
  if (s.includes("obsidian")) return "panini-obsidian";
  if (s.includes("phoenix")) return "panini-phoenix";
  if (s.includes("spectra")) return "panini-spectra";
  if (s.includes("absolute")) return "panini-absolute";
  if (s.includes("score")) return "panini-score";
  if (s.includes("prestige")) return "panini-prestige";
  if (s.includes("certified")) return "panini-certified";
  if (s.includes("playoff")) return "panini-playoff";
  if (s.includes("revolution")) return "panini-revolution";
  if (s.includes("upper deck")) return "upper-deck";
  return "other";
}
