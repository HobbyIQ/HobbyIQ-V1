// CF-GRADE-FAILURE-RATE (Drew, 2026-07-17). Pure math for the
// grade-worthy failure-rate estimator. Given (rawPrice, gradingCost,
// tierShares, tierPrices), compute:
//
//   • expectedNetValue        Σ(tierPrice × tierShare) − gradingCost
//   • probabilityTopGrade     tierShares[best available]
//   • probabilityGainVsHold   Σ tierShares for tiers where
//                              (tierPrice − gradingCost) > rawPrice
//   • probabilityLoss         Σ tierShares for tiers where
//                              (tierPrice − gradingCost) < rawPrice
//   • verdict                 worth_the_gamble | risky | loss_probable
//                              | insufficient_data
//
// IMPORTANT interpretation caveat (must appear verbatim on iOS):
//   "Based on market OUTCOMES, not a submission guarantee."
// The tierShares represent the distribution of GRADED SALES (not
// submission outcomes), so this is a directional proxy, not a
// prediction. iOS renders the caveat text below the failure-rate block.
// Source of caveat rule: project memory (grade-worthy failure-rate
// block MUST carry the verbatim caveat).

export const FAILURE_RATE_CAVEAT =
  "Based on market OUTCOMES, not a submission guarantee.";

export interface GradeFailureRateInputs {
  rawPrice: number;
  gradingCost: number;
  /** Distribution of graded sales by tier, e.g. {"PSA 10": 0.28, "PSA 9": 0.42}.
   *  Should sum to ~1.0. Any tier missing from this map contributes 0 to EV
   *  (we don't extrapolate what we haven't observed). */
  tierShares: Record<string, number>;
  /** Per-tier median observed price, e.g. {"PSA 10": 800, "PSA 9": 220}.
   *  Any tier missing here is skipped in EV (no price → no contribution). */
  tierPrices: Record<string, number>;
  /** Total graded sample size behind the shares — feeds the confidence
   *  gate. Below 20 → insufficient_data verdict. */
  totalGradedSamples: number;
}

export type FailureRateVerdict =
  | "worth_the_gamble"
  | "risky"
  | "loss_probable"
  | "insufficient_data";

export interface GradeFailureRateResult {
  expectedNetValue: number;
  probabilityTopGrade: number;    // 0..1
  probabilityGainVsHold: number;  // 0..1
  probabilityLoss: number;        // 0..1
  verdict: FailureRateVerdict;
  bestTier: string | null;
  worstOutcomeTier: string | null;
  caveat: string;                  // verbatim FAILURE_RATE_CAVEAT
}

const MIN_SAMPLES_FOR_VERDICT = 20;
const WORTH_GAMBLE_MIN_EV_PCT_OVER_RAW = 0.30;   // EV must beat raw by 30%
const LOSS_PROBABILITY_THRESHOLD = 0.50;         // 50%+ chance of net loss → loss_probable

export function computeGradeFailureRate(
  inp: GradeFailureRateInputs,
): GradeFailureRateResult {
  const rawPrice = inp.rawPrice;
  const gradingCost = inp.gradingCost;

  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return insufficient("raw price missing");
  }
  if (!Number.isFinite(gradingCost) || gradingCost < 0) {
    return insufficient("grading cost missing");
  }
  if (inp.totalGradedSamples < MIN_SAMPLES_FOR_VERDICT) {
    return insufficient("insufficient graded samples in family");
  }

  const tiers = Object.keys(inp.tierShares);
  if (tiers.length === 0) return insufficient("no tier shares");

  // Compute EV, top grade, gain/loss probability.
  //
  // EV_gross = Σ(tierPrice × tierShare) — expected sale price weighted
  // by observed graded-sale distribution.
  // EV_net = EV_gross - gradingCost — grading is a one-time fixed cost
  // paid regardless of outcome, not per-tier.
  let expectedGross = 0;
  let probGainVsHold = 0;
  let probLoss = 0;
  let bestTier: string | null = null;
  let bestTierShare = -1;
  let worstOutcomeTier: string | null = null;
  let worstOutcomePrice = Number.POSITIVE_INFINITY;

  for (const tier of tiers) {
    const share = inp.tierShares[tier];
    const price = inp.tierPrices[tier];
    if (!Number.isFinite(share) || share <= 0) continue;
    if (!Number.isFinite(price) || price < 0) continue;

    expectedGross += share * price;

    const netAtTier = price - gradingCost;
    if (netAtTier > rawPrice) probGainVsHold += share;
    else if (netAtTier < rawPrice) probLoss += share;

    if (share > bestTierShare) {
      bestTier = tier;
      bestTierShare = share;
    }
    if (price < worstOutcomePrice) {
      worstOutcomeTier = tier;
      worstOutcomePrice = price;
    }
  }
  const expectedNet = expectedGross - gradingCost;

  // Verdict logic
  const evLiftPct = rawPrice > 0 ? (expectedNet - rawPrice) / rawPrice : 0;
  const verdict: FailureRateVerdict =
    probLoss >= LOSS_PROBABILITY_THRESHOLD ? "loss_probable" :
    evLiftPct >= WORTH_GAMBLE_MIN_EV_PCT_OVER_RAW ? "worth_the_gamble" :
    "risky";

  return {
    expectedNetValue: round2(expectedNet),
    probabilityTopGrade: round4(bestTierShare > 0 ? inp.tierShares[bestTier!] : 0),
    probabilityGainVsHold: round4(probGainVsHold),
    probabilityLoss: round4(probLoss),
    verdict,
    bestTier,
    worstOutcomeTier,
    caveat: FAILURE_RATE_CAVEAT,
  };
}

function insufficient(_reason: string): GradeFailureRateResult {
  return {
    expectedNetValue: 0,
    probabilityTopGrade: 0,
    probabilityGainVsHold: 0,
    probabilityLoss: 0,
    verdict: "insufficient_data",
    bestTier: null,
    worstOutcomeTier: null,
    caveat: FAILURE_RATE_CAVEAT,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

export const _MIN_SAMPLES_FOR_VERDICT = MIN_SAMPLES_FOR_VERDICT;
export const _WORTH_GAMBLE_MIN_EV_PCT_OVER_RAW = WORTH_GAMBLE_MIN_EV_PCT_OVER_RAW;
export const _LOSS_PROBABILITY_THRESHOLD = LOSS_PROBABILITY_THRESHOLD;
