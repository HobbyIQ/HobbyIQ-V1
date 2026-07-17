// CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Pinning tests for the
// grade-worthy push gate.

import { describe, it, expect } from "vitest";
import {
  shouldFireGradeWorthyPush,
  _MIN_EXPECTED_GAIN_USD,
} from "../src/services/portfolioiq/gradeWorthyPushCompute.service.js";
import type {
  GradeWorthyAnalysis,
  GradeWorthyTier,
} from "../src/types/gradeWorthy.types.js";

function tier(overrides: Partial<GradeWorthyTier> = {}): GradeWorthyTier {
  return {
    graderTier: "PSA 10",
    gradedMedianPrice: 500,
    gradedSampleSize: 12,
    gradingCostAssumed: 25,
    expectedGain: 250,
    expectedRoi: 1.9,
    recommendation: "grade_now",
    reason: "PSA 10 clearing 50% ROI",
    ...overrides,
  };
}

function analysis(overrides: Partial<GradeWorthyAnalysis> = {}): GradeWorthyAnalysis {
  const best = overrides.bestTier === undefined ? tier() : overrides.bestTier;
  const overall = overrides.overallRecommendation
    ?? (best ? best.recommendation : "insufficient_data");
  return {
    rawPrice: 225,
    bestTier: best,
    allTiers: overrides.allTiers ?? (best ? [best] : []),
    overallRecommendation: overall,
    reason: overrides.reason ?? "test analysis",
  };
}

describe("shouldFireGradeWorthyPush — thresholds pinned", () => {
  it("pins the $200 minimum expected-gain floor", () => {
    expect(_MIN_EXPECTED_GAIN_USD).toBe(200);
  });
});

describe("shouldFireGradeWorthyPush — happy path", () => {
  it("fires when expectedGain >= $200 AND best tier is grade_now", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: 250, recommendation: "grade_now" }),
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(true);
    expect(verdict.tier).not.toBeNull();
    expect(verdict.tier!.graderTier).toBe("PSA 10");
    expect(verdict.reason).toMatch(/grade_now/);
  });

  it("fires at exactly the $200 floor (>=, not >)", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: 200, recommendation: "grade_now" }),
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(true);
  });
});

describe("shouldFireGradeWorthyPush — gates", () => {
  it("does NOT fire when expectedGain is below the $200 floor", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: 150, recommendation: "grade_now" }),
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toMatch(/\$150/);
    expect(verdict.reason).toMatch(/\$200/);
  });

  it("does NOT fire when overall recommendation is grade_worthy_but_wait", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: 500, recommendation: "grade_now" }),
      overallRecommendation: "grade_worthy_but_wait",
    }));
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toMatch(/grade_worthy_but_wait/);
  });

  it("does NOT fire when overall recommendation is not_worth", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: 500, recommendation: "not_worth" }),
      overallRecommendation: "not_worth",
    }));
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toMatch(/not_worth/);
  });

  it("does NOT fire when best tier's own recommendation is not grade_now", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      // Contrived: overall grade_now but best-tier row disagrees. Gate is
      // AND-of-both to avoid firing on a stale/mismatched state.
      bestTier: tier({ expectedGain: 500, recommendation: "grade_worthy_but_wait" }),
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(false);
  });

  it("does NOT fire when analysis has no best tier at all", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: null,
      overallRecommendation: "insufficient_data",
      allTiers: [],
    }));
    expect(verdict.fire).toBe(false);
    expect(verdict.tier).toBeNull();
    expect(verdict.reason).toMatch(/no best tier/);
  });

  it("does NOT fire when expectedGain is not finite", () => {
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: tier({ expectedGain: NaN, recommendation: "grade_now" }),
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toMatch(/finite/);
  });
});

describe("shouldFireGradeWorthyPush — verdict payload", () => {
  it("carries the best tier through on a fire so notify can build the push body", () => {
    const t = tier({
      graderTier: "BGS 9.5",
      expectedGain: 320,
      recommendation: "grade_now",
    });
    const verdict = shouldFireGradeWorthyPush(analysis({
      bestTier: t,
      overallRecommendation: "grade_now",
    }));
    expect(verdict.fire).toBe(true);
    expect(verdict.tier).toBe(t);
    expect(verdict.tier!.graderTier).toBe("BGS 9.5");
    expect(verdict.tier!.expectedGain).toBe(320);
  });
});
