// CF-GRADE-CALIBRATION (Drew, 2026-07-20 refresh). GRADE_CALIBRATION
// regenerated against ch_daily_sales via a per-year-partitioned query
// (backend/scripts/_grade-calibrate-json.mjs +
// _grade-calibrate-per-year.mjs) to catch the ~76% of baseball rows
// the initial 14-family script missed (Topps Heritage, Topps Finest,
// Topps Pristine, Topps Allen & Ginter, Topps Stadium Club, and the
// large families that had 429'd on unbounded GROUP BY: bowman, topps,
// topps-chrome, topps-heritage, panini-prizm, panini-donruss).
//
// Coverage: 19 families × 51 (family, grader) entries — up from
// 6 families × 15 entries prior. Baseball pool coverage: ~24% → ~98%.
//
// Read at rung 5 of canonicalFmv.service.ts (and via lookupGradeRatio
// from observedGradeCurve.service.ts). Returns null when the
// (family, grader) pair isn't covered; caller emits
// `grade_multiplier_uncovered` telemetry.

export interface GradeCalibrationEntry {
  medianRatio: number;
  p25: number;
  p75: number;
  sampleSize: number;
}

export const GRADE_CALIBRATION: Record<string, Record<string, GradeCalibrationEntry>> = {
  "bowman": {
    "BGS":  { "medianRatio": 2.26,  "p25": 1.48,  "p75": 4.30,  "sampleSize": 40 },
    "CGC":  { "medianRatio": 5.14,  "p25": 1.99,  "p75": 8.10,  "sampleSize": 71 },
    "PSA":  { "medianRatio": 4.07,  "p25": 2.28,  "p75": 8.66,  "sampleSize": 2065 },
    "SGC":  { "medianRatio": 3.73,  "p25": 1.87,  "p75": 6.37,  "sampleSize": 160 }
  },
  "bowman-chrome": {
    "BGS":  { "medianRatio": 2.28,  "p25": 1.48,  "p75": 3.82,  "sampleSize": 48 },
    "CGC":  { "medianRatio": 2.88,  "p25": 1.36,  "p75": 8.01,  "sampleSize": 31 },
    "PSA":  { "medianRatio": 3.46,  "p25": 2.15,  "p75": 7.02,  "sampleSize": 1016 },
    "SGC":  { "medianRatio": 2.19,  "p25": 1.56,  "p75": 4.23,  "sampleSize": 60 }
  },
  "bowman-chrome-draft": {
    "BGS":  { "medianRatio": 2.26,  "p25": 1.50,  "p75": 2.85,  "sampleSize": 11 },
    "PSA":  { "medianRatio": 5.32,  "p25": 2.81,  "p75": 7.35,  "sampleSize": 59 }
  },
  "bowman-sterling": {
    "PSA":  { "medianRatio": 3.00,  "p25": 1.95,  "p75": 6.30,  "sampleSize": 15 }
  },
  "panini-donruss": {
    "PSA":  { "medianRatio": 3.81,  "p25": 1.97,  "p75": 7.40,  "sampleSize": 133 },
    "SGC":  { "medianRatio": 2.92,  "p25": 1.54,  "p75": 12.63, "sampleSize": 8 }
  },
  "panini-mosaic": {
    "PSA":  { "medianRatio": 10.55, "p25": 6.27,  "p75": 29.59, "sampleSize": 10 }
  },
  "panini-optic": {
    "PSA":  { "medianRatio": 2.84,  "p25": 2.17,  "p75": 6.54,  "sampleSize": 58 }
  },
  "panini-prizm": {
    "CGC":  { "medianRatio": 4.29,  "p25": 2.21,  "p75": 6.79,  "sampleSize": 7 },
    "PSA":  { "medianRatio": 4.37,  "p25": 2.36,  "p75": 8.31,  "sampleSize": 211 }
  },
  "panini-select": {
    "PSA":  { "medianRatio": 7.96,  "p25": 4.34,  "p75": 13.38, "sampleSize": 34 }
  },
  "topps": {
    "BGS":  { "medianRatio": 3.14,  "p25": 2.01,  "p75": 5.56,  "sampleSize": 98 },
    "CGC":  { "medianRatio": 5.40,  "p25": 2.45,  "p75": 8.95,  "sampleSize": 229 },
    "PSA":  { "medianRatio": 6.44,  "p25": 3.04,  "p75": 11.73, "sampleSize": 2824 },
    "SGC":  { "medianRatio": 3.79,  "p25": 2.27,  "p75": 6.33,  "sampleSize": 270 },
    "TAG":  { "medianRatio": 3.26,  "p25": 2.05,  "p75": 9.62,  "sampleSize": 5 }
  },
  "topps-allen-ginter": {
    "CGC":  { "medianRatio": 9.55,  "p25": 3.03,  "p75": 12.71, "sampleSize": 15 },
    "PSA":  { "medianRatio": 12.39, "p25": 8.03,  "p75": 16.76, "sampleSize": 73 }
  },
  "topps-chrome": {
    "BGS":  { "medianRatio": 3.07,  "p25": 1.95,  "p75": 4.14,  "sampleSize": 25 },
    "CGC":  { "medianRatio": 6.01,  "p25": 2.91,  "p75": 8.82,  "sampleSize": 58 },
    "PSA":  { "medianRatio": 5.98,  "p25": 3.15,  "p75": 10.78, "sampleSize": 1017 },
    "SGC":  { "medianRatio": 3.95,  "p25": 2.66,  "p75": 6.14,  "sampleSize": 100 }
  },
  "topps-chrome-update": {
    "CGC":  { "medianRatio": 5.12,  "p25": 2.47,  "p75": 7.71,  "sampleSize": 20 },
    "PSA":  { "medianRatio": 6.90,  "p25": 3.67,  "p75": 11.80, "sampleSize": 235 },
    "SGC":  { "medianRatio": 2.77,  "p25": 1.83,  "p75": 4.48,  "sampleSize": 19 }
  },
  "topps-finest": {
    "BGS":  { "medianRatio": 3.01,  "p25": 2.49,  "p75": 4.77,  "sampleSize": 8 },
    "PSA":  { "medianRatio": 6.15,  "p25": 2.74,  "p75": 12.16, "sampleSize": 222 },
    "SGC":  { "medianRatio": 2.79,  "p25": 1.55,  "p75": 6.61,  "sampleSize": 10 }
  },
  "topps-heritage": {
    "CGC":  { "medianRatio": 3.30,  "p25": 2.47,  "p75": 8.80,  "sampleSize": 9 },
    "PSA":  { "medianRatio": 6.10,  "p25": 3.01,  "p75": 13.30, "sampleSize": 188 },
    "SGC":  { "medianRatio": 2.25,  "p25": 1.82,  "p75": 4.32,  "sampleSize": 11 }
  },
  "topps-pristine": {
    "PSA":  { "medianRatio": 5.80,  "p25": 2.57,  "p75": 7.19,  "sampleSize": 30 }
  },
  "topps-stadium-club": {
    "BGS":  { "medianRatio": 5.02,  "p25": 2.95,  "p75": 9.22,  "sampleSize": 6 },
    "CGC":  { "medianRatio": 3.97,  "p25": 1.34,  "p75": 5.94,  "sampleSize": 6 },
    "PSA":  { "medianRatio": 8.99,  "p25": 3.66,  "p75": 21.91, "sampleSize": 155 },
    "SGC":  { "medianRatio": 2.81,  "p25": 2.27,  "p75": 8.86,  "sampleSize": 12 }
  },
  "topps-update": {
    "BGS":  { "medianRatio": 3.13,  "p25": 2.67,  "p75": 3.56,  "sampleSize": 17 },
    "CGC":  { "medianRatio": 5.62,  "p25": 1.90,  "p75": 10.25, "sampleSize": 35 },
    "PSA":  { "medianRatio": 6.37,  "p25": 3.21,  "p75": 10.92, "sampleSize": 323 },
    "SGC":  { "medianRatio": 2.81,  "p25": 1.79,  "p75": 5.67,  "sampleSize": 39 }
  },
  "upper-deck": {
    "BGS":  { "medianRatio": 7.01,  "p25": 4.53,  "p75": 10.18, "sampleSize": 34 },
    "CGC":  { "medianRatio": 4.62,  "p25": 3.22,  "p75": 6.48,  "sampleSize": 25 },
    "PSA":  { "medianRatio": 17.38, "p25": 10.28, "p75": 24.09, "sampleSize": 343 },
    "SGC":  { "medianRatio": 5.12,  "p25": 3.32,  "p75": 9.10,  "sampleSize": 30 }
  }
};

// CF-GRADE-CALIBRATION-SPORT (Drew, 2026-07-20). Per-sport grade
// calibration overlays. The default GRADE_CALIBRATION table above is
// implicitly baseball (generated from ch_daily_sales when the corpus
// was baseball-only). Football + basketball generally have DIFFERENT
// grade-uplift ratios — PSA 10 basketball rookies fetch 5-10× raw
// while baseball prospects sit at 3-4×. When per-sport calibration
// tables are populated (via a per-sport calibrate-grade-multipliers.mjs
// re-run once the football + basketball backfills finish),
// lookupGradeRatio prefers the sport-specific table and falls back to
// the baseline (baseball) table when a specific tier isn't covered.
//
// Right now GRADE_CALIBRATION_BY_SPORT is stubbed empty — the shape
// is ready for the per-sport regeneration output. Callers that pass
// sport get sport-correct answers when data is available and safe
// fallback to the baseline otherwise.

export const GRADE_CALIBRATION_BY_SPORT: Record<string, Record<string, Record<string, GradeCalibrationEntry>>> = {
  // Populated by scripts/calibrate-grade-multipliers.mjs --sport=X
  // when re-run per-sport. Empty until football + basketball
  // backfills finish + the calibration script gets a --sport flag.
  baseball: {},   // reserved; baseline GRADE_CALIBRATION is the
                  // baseball-implicit source of truth today
  football: {},
  basketball: {},
  hockey: {},
};

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
  if (s.includes("upper deck")) return "upper-deck";
  return "other";
}
