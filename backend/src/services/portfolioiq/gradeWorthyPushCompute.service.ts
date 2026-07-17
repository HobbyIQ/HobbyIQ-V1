// CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Pure math for the
// grade-worthy push gate. Given a holding's grade-worthy analysis,
// decide whether it warrants a push notification.
//
// v1 gate (simplification): fire when
//   analysis.bestTier.expectedGain >= _MIN_EXPECTED_GAIN_USD
//   AND analysis.bestTier.recommendation === "grade_now"
//
// A future v2 will add dedup against a "last-week fired events" store
// and week-over-week +30% delta gating. Both require history the store
// doesn't yet have — the v1 rule stays fully deterministic on a single
// snapshot, which is safe under nightly re-runs (an idempotent push
// will surface the same holding until the user acts, which is the
// desired "still grade-worthy" behavior at launch).
//
// No IO — takes a GradeWorthyAnalysis, returns a fire/skip verdict.

import type { GradeWorthyAnalysis, GradeWorthyTier } from "../../types/gradeWorthy.types.js";

/** Minimum expectedGain (USD) to fire a push. Pinned by test. */
export const _MIN_EXPECTED_GAIN_USD = 200;

export interface GradeWorthyPushVerdict {
  fire: boolean;
  reason: string;
  tier: GradeWorthyTier | null;
}

/**
 * Given a holding's grade-worthy analysis, return whether a push
 * should fire. Skips already-graded / insufficient-data / not-worth
 * cases. Only `recommendation === "grade_now"` at the best tier
 * qualifies, AND the expectedGain must clear the USD floor.
 */
export function shouldFireGradeWorthyPush(
  analysis: GradeWorthyAnalysis,
): GradeWorthyPushVerdict {
  const best = analysis.bestTier;
  if (!best) {
    return {
      fire: false,
      reason: "no best tier available",
      tier: null,
    };
  }
  if (analysis.overallRecommendation !== "grade_now") {
    return {
      fire: false,
      reason: `overall recommendation is ${analysis.overallRecommendation}`,
      tier: best,
    };
  }
  if (best.recommendation !== "grade_now") {
    return {
      fire: false,
      reason: `best tier recommendation is ${best.recommendation}`,
      tier: best,
    };
  }
  if (!Number.isFinite(best.expectedGain)) {
    return {
      fire: false,
      reason: "expectedGain not finite",
      tier: best,
    };
  }
  if (best.expectedGain < _MIN_EXPECTED_GAIN_USD) {
    return {
      fire: false,
      reason: `expectedGain $${best.expectedGain.toFixed(0)} < $${_MIN_EXPECTED_GAIN_USD} floor`,
      tier: best,
    };
  }
  return {
    fire: true,
    reason: `expectedGain $${best.expectedGain.toFixed(0)} at ${best.graderTier} — grade_now`,
    tier: best,
  };
}
