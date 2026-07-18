// CF-GRADE-FAILURE-RATE (Drew, 2026-07-17). Pinning tests for the
// grade-worthy failure-rate estimator. Verifies EV math, verdict
// logic, and the verbatim caveat contract.

import { describe, it, expect } from "vitest";
import {
  computeGradeFailureRate,
  FAILURE_RATE_CAVEAT,
} from "../src/services/portfolioiq/gradeFailureRatePricing.js";

describe("computeGradeFailureRate — caveat contract", () => {
  it("verbatim caveat must appear on every result", () => {
    expect(FAILURE_RATE_CAVEAT).toBe("Based on market OUTCOMES, not a submission guarantee.");
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.3, "PSA 9": 0.5, "PSA 8": 0.2 },
      tierPrices: { "PSA 10": 400, "PSA 9": 150, "PSA 8": 80 },
      totalGradedSamples: 100,
    });
    expect(r.caveat).toBe(FAILURE_RATE_CAVEAT);
  });

  it("caveat present even on insufficient_data", () => {
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: {}, tierPrices: {},
      totalGradedSamples: 5,
    });
    expect(r.verdict).toBe("insufficient_data");
    expect(r.caveat).toBe(FAILURE_RATE_CAVEAT);
  });
});

describe("computeGradeFailureRate — EV math", () => {
  it("Hartman-family scenario: high PSA 10 share drives worth_the_gamble", () => {
    // 30% PSA 10 at $400, 50% PSA 9 at $150, 20% PSA 8 at $80
    // EV = 0.3×400 + 0.5×150 + 0.2×80 = 120 + 75 + 16 = 211
    // Net EV = 211 - 25 grading cost = 186
    // Raw = 100 → net EV lift = 86%
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.3, "PSA 9": 0.5, "PSA 8": 0.2 },
      tierPrices: { "PSA 10": 400, "PSA 9": 150, "PSA 8": 80 },
      totalGradedSamples: 100,
    });
    expect(r.expectedNetValue).toBeCloseTo(186, 1);
    expect(r.verdict).toBe("worth_the_gamble");
    // Gain vs hold: PSA 10 (400-25=375 > 100) and PSA 9 (150-25=125 > 100) → 0.8
    expect(r.probabilityGainVsHold).toBeCloseTo(0.8, 3);
    // Loss: PSA 8 (80-25=55 < 100) → 0.2
    expect(r.probabilityLoss).toBeCloseTo(0.2, 3);
  });

  it("Low PSA 10 share drives loss_probable", () => {
    // 5% PSA 10 at $400, 15% PSA 9 at $150, 80% PSA 8 at $60
    // EV = 0.05×400 + 0.15×150 + 0.80×60 = 20 + 22.5 + 48 = 90.5
    // Net EV = 90.5 - 25 = 65.5
    // Loss prob: PSA 9 (125 > 100 no); PSA 8 (35 < 100 yes) → 0.80
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.05, "PSA 9": 0.15, "PSA 8": 0.80 },
      tierPrices: { "PSA 10": 400, "PSA 9": 150, "PSA 8": 60 },
      totalGradedSamples: 100,
    });
    expect(r.probabilityLoss).toBeCloseTo(0.80, 2);
    expect(r.verdict).toBe("loss_probable");
  });

  it("Modest EV lift (<30%) → risky", () => {
    // EV net just barely above raw
    // Shares: 20% PSA 10 at 200, 60% PSA 9 at 130, 20% PSA 8 at 90
    // EV = 40 + 78 + 18 = 136 - 25 = 111 → 11% lift
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.2, "PSA 9": 0.6, "PSA 8": 0.2 },
      tierPrices: { "PSA 10": 200, "PSA 9": 130, "PSA 8": 90 },
      totalGradedSamples: 100,
    });
    expect(r.expectedNetValue).toBeCloseTo(111, 1);
    // Loss prob: PSA 8 (90-25=65 < 100) → 0.2 — under 50% threshold
    // EV lift 11% — under 30% threshold → risky
    expect(r.verdict).toBe("risky");
  });
});

describe("computeGradeFailureRate — verdict gates", () => {
  it("Under 20 samples → insufficient_data", () => {
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 1.0 },
      tierPrices: { "PSA 10": 500 },
      totalGradedSamples: 15,
    });
    expect(r.verdict).toBe("insufficient_data");
    expect(r.expectedNetValue).toBe(0);
  });

  it("Missing tier price → skipped from EV, doesn't crash", () => {
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.5, "PSA 9": 0.5 },
      tierPrices: { "PSA 10": 400 },   // no PSA 9 price
      totalGradedSamples: 40,
    });
    // Only PSA 10 contributes: 0.5 × 400 - 25 = 175
    expect(r.expectedNetValue).toBeCloseTo(175, 1);
    // Only PSA 10 counted for gain vs hold
    expect(r.probabilityGainVsHold).toBeCloseTo(0.5, 3);
  });

  it("Zero raw price → insufficient_data", () => {
    const r = computeGradeFailureRate({
      rawPrice: 0, gradingCost: 25,
      tierShares: { "PSA 10": 1.0 },
      tierPrices: { "PSA 10": 500 },
      totalGradedSamples: 100,
    });
    expect(r.verdict).toBe("insufficient_data");
  });
});

describe("computeGradeFailureRate — best/worst tier identification", () => {
  it("bestTier is the highest-share tier", () => {
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.2, "PSA 9": 0.5, "PSA 8": 0.3 },
      tierPrices: { "PSA 10": 400, "PSA 9": 150, "PSA 8": 80 },
      totalGradedSamples: 100,
    });
    expect(r.bestTier).toBe("PSA 9");   // highest share, not highest price
    expect(r.probabilityTopGrade).toBeCloseTo(0.5, 3);
  });

  it("worstOutcomeTier is the lowest-price tier", () => {
    const r = computeGradeFailureRate({
      rawPrice: 100, gradingCost: 25,
      tierShares: { "PSA 10": 0.3, "PSA 9": 0.5, "PSA 8": 0.2 },
      tierPrices: { "PSA 10": 400, "PSA 9": 150, "PSA 8": 80 },
      totalGradedSamples: 100,
    });
    expect(r.worstOutcomeTier).toBe("PSA 8");
  });
});
