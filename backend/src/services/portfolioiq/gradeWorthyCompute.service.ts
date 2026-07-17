// CF-GRADE-WORTHY (Drew, 2026-07-17). Pure math for the grade-worthy
// analysis. No IO — takes numbers, returns a recommendation per grader
// tier and an overall verdict.
//
// v1 simplifications (call out explicitly on the client):
//  - Assumes graded outcome = target tier. No probability distribution
//    across (PSA 10 / 9 / 8) grade results. Future: probability-weighted
//    expectation from user-declared or auto-scored condition.
//  - Uses grader premium's meanPrice as the graded-side anchor (in local
//    comp store this is derived from the observed sales; not FMV per
//    [[no-medians-project-next-sale]] — descriptive-only, sufficient
//    for a grade/no-grade recommendation.)
//  - Grading cost is the LOWEST tier cost per grader that meets the
//    target grade's card-value cap. Callers pass the full catalog and
//    we pick.
//  - Opportunity-cost of capital during the 60-90d grading turnaround
//    is NOT modeled in v1. Momentum direction is used as a coarse
//    proxy: if the player-level trend is "down" and expected gain is
//    small, we downgrade the recommendation.

import type {
  GradeWorthyInputs,
  GradeWorthyAnalysis,
  GradeWorthyTier,
  GraderPremiumInput,
} from "../../types/gradeWorthy.types.js";

const MIN_SAMPLE_SIZE = 3;                 // graded n < 3 → insufficient
const MIN_ABSOLUTE_GAIN = 50;              // $ minimum to be grade-worthy
const MIN_ROI_FOR_GRADE_NOW = 0.5;         // 50% ROI on (raw + grading cost) → strong signal
const MIN_ROI_FOR_WORTHY = 0.2;            // 20% ROI → worth considering
const CAUTIOUS_MULTIPLIER_ON_DOWNTREND = 0.75; // squeeze expected gain by 25% when momentum is down

/** Ranks tier keys that are "premium" (grade 9+) so we prefer them for the
 *  best-tier recommendation. Non-premium tiers only qualify if no premium
 *  tier has data. */
const PREMIUM_TIER_RX = /(?:PSA|BGS|SGC|CGC)\s*(?:10|9\.5|9)$/i;

export function analyzeGradeWorthy(inputs: GradeWorthyInputs): GradeWorthyAnalysis {
  const { rawPrice, graderPremiums, gradingCosts, playerMomentumDirection } = inputs;

  if (!Number.isFinite(rawPrice) || rawPrice < 0) {
    return emptyResult(rawPrice, "raw_price_invalid");
  }

  const tierRows: GradeWorthyTier[] = [];

  for (const [graderTier, premium] of Object.entries(graderPremiums)) {
    if (graderTier === "Raw") continue;
    if (!isPremiumTier(graderTier)) continue; // v1: only recommend for high grades
    const cost = pickGradingCost(graderTier, gradingCosts);
    tierRows.push(buildTierRow(rawPrice, graderTier, premium, cost, playerMomentumDirection));
  }

  if (tierRows.length === 0) {
    return emptyResult(rawPrice, "no_graded_comps");
  }

  tierRows.sort((a, b) => b.expectedGain - a.expectedGain);
  const best = tierRows[0];

  const overall = best.recommendation;
  const reason = overall === "grade_now"
    ? `Best tier ${best.graderTier}: expected gain $${best.expectedGain.toFixed(0)} (${(best.expectedRoi * 100).toFixed(0)}% ROI on raw+grading cost)`
    : overall === "grade_worthy_but_wait"
    ? `Best tier ${best.graderTier}: expected gain $${best.expectedGain.toFixed(0)} — consider waiting`
    : overall === "insufficient_data"
    ? "Not enough graded comps to recommend"
    : "Raw value + grading cost currently exceed likely graded return";

  return {
    rawPrice: round(rawPrice, 2),
    bestTier: best,
    allTiers: tierRows,
    overallRecommendation: overall,
    reason,
  };
}

function buildTierRow(
  rawPrice: number,
  graderTier: string,
  premium: GraderPremiumInput,
  gradingCost: number,
  momentum: "up" | "flat" | "down" | undefined,
): GradeWorthyTier {
  const gradedPrice = premium.meanPrice;
  const rawExpectedGain = gradedPrice - rawPrice - gradingCost;
  const expectedGain = momentum === "down"
    ? rawExpectedGain * CAUTIOUS_MULTIPLIER_ON_DOWNTREND
    : rawExpectedGain;
  const denom = rawPrice + gradingCost;
  const expectedRoi = denom > 0 ? expectedGain / denom : 0;

  let recommendation: GradeWorthyTier["recommendation"];
  let reason: string;

  if (premium.n < MIN_SAMPLE_SIZE) {
    recommendation = "insufficient_data";
    reason = `Only ${premium.n} graded comps in past window (need ≥${MIN_SAMPLE_SIZE})`;
  } else if (expectedGain < MIN_ABSOLUTE_GAIN) {
    recommendation = "not_worth";
    reason = `Expected gain $${round(expectedGain, 0)} < $${MIN_ABSOLUTE_GAIN} minimum`;
  } else if (expectedRoi >= MIN_ROI_FOR_GRADE_NOW && momentum !== "down") {
    recommendation = "grade_now";
    reason = `${(expectedRoi * 100).toFixed(0)}% ROI on cost basis — strong signal`;
  } else if (expectedRoi >= MIN_ROI_FOR_WORTHY) {
    recommendation = momentum === "down"
      ? "grade_worthy_but_wait"
      : "grade_now";
    reason = momentum === "down"
      ? `${(expectedRoi * 100).toFixed(0)}% ROI but player momentum down — wait for reversal`
      : `${(expectedRoi * 100).toFixed(0)}% ROI on cost basis`;
  } else {
    recommendation = "not_worth";
    reason = `Only ${(expectedRoi * 100).toFixed(0)}% ROI — below ${(MIN_ROI_FOR_WORTHY * 100).toFixed(0)}% threshold`;
  }

  return {
    graderTier,
    gradedMedianPrice: round(gradedPrice, 2),
    gradedSampleSize: premium.n,
    gradingCostAssumed: round(gradingCost, 2),
    expectedGain: round(expectedGain, 2),
    expectedRoi: round(expectedRoi, 3),
    recommendation,
    reason,
  };
}

/** Pick the applicable grading cost for a given tier. If the catalog has
 *  a company-specific key ("psa-value"), prefer it; else use "default";
 *  else fall back to $50. */
function pickGradingCost(graderTier: string, catalog: Record<string, number>): number {
  const grader = graderTier.split(/\s+/)[0].toLowerCase(); // "psa", "bgs", etc
  const preferredKeys = [
    `${grader}-value`,
    `${grader}-regular`,
    `${grader}-standard`,
    `${grader}`,
    "default",
  ];
  for (const k of preferredKeys) {
    if (typeof catalog[k] === "number" && catalog[k] > 0) return catalog[k];
  }
  return 50;
}

function isPremiumTier(tier: string): boolean {
  return PREMIUM_TIER_RX.test(tier);
}

function emptyResult(rawPrice: number, code: string): GradeWorthyAnalysis {
  const reasonByCode: Record<string, string> = {
    raw_price_invalid: "Raw price is not available or invalid",
    no_graded_comps: "No graded (PSA 9+, BGS 9+, etc) comparable sales on file",
  };
  return {
    rawPrice: Number.isFinite(rawPrice) ? round(rawPrice, 2) : 0,
    bestTier: null,
    allTiers: [],
    overallRecommendation: "insufficient_data",
    reason: reasonByCode[code] ?? "Insufficient data",
  };
}

function round(x: number, digits: number): number {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

// Test surfaces.
export const _MIN_SAMPLE_SIZE = MIN_SAMPLE_SIZE;
export const _MIN_ABSOLUTE_GAIN = MIN_ABSOLUTE_GAIN;
export const _MIN_ROI_FOR_GRADE_NOW = MIN_ROI_FOR_GRADE_NOW;
export const _MIN_ROI_FOR_WORTHY = MIN_ROI_FOR_WORTHY;
export const _CAUTIOUS_MULTIPLIER_ON_DOWNTREND = CAUTIOUS_MULTIPLIER_ON_DOWNTREND;
