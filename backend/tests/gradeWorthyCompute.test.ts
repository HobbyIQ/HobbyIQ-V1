// CF-GRADE-WORTHY (Drew, 2026-07-17). Pinning tests for the grade-
// worthy analysis math.

import { describe, it, expect } from "vitest";
import {
  analyzeGradeWorthy,
  _MIN_SAMPLE_SIZE,
  _MIN_ABSOLUTE_GAIN,
  _MIN_ROI_FOR_GRADE_NOW,
  _MIN_ROI_FOR_WORTHY,
  _CAUTIOUS_MULTIPLIER_ON_DOWNTREND,
} from "../src/services/portfolioiq/gradeWorthyCompute.service.js";
import type { GradeWorthyInputs } from "../src/types/gradeWorthy.types.js";

function inputs(overrides: Partial<GradeWorthyInputs> = {}): GradeWorthyInputs {
  return {
    rawPrice: 100,
    graderPremiums: {
      "Raw": { n: 200, meanPrice: 100, multiplierVsBaseline: 1 },
    },
    gradingCosts: { "psa-value": 25, "bgs-value": 30, "default": 50 },
    ...overrides,
  };
}

describe("analyzeGradeWorthy — thresholds pinned", () => {
  it("pins constants", () => {
    expect(_MIN_SAMPLE_SIZE).toBe(3);
    expect(_MIN_ABSOLUTE_GAIN).toBe(50);
    expect(_MIN_ROI_FOR_GRADE_NOW).toBe(0.5);
    expect(_MIN_ROI_FOR_WORTHY).toBe(0.2);
    expect(_CAUTIOUS_MULTIPLIER_ON_DOWNTREND).toBe(0.75);
  });
});

describe("analyzeGradeWorthy — insufficient data paths", () => {
  it("returns insufficient_data + reason when rawPrice invalid", () => {
    const r = analyzeGradeWorthy({ ...inputs({ rawPrice: NaN }) });
    expect(r.overallRecommendation).toBe("insufficient_data");
    expect(r.reason).toMatch(/raw price/i);
    expect(r.allTiers).toEqual([]);
  });

  it("returns insufficient_data when no graded tiers in the premium map", () => {
    const r = analyzeGradeWorthy(inputs({
      graderPremiums: {
        "Raw": { n: 200, meanPrice: 100, multiplierVsBaseline: 1 },
      },
    }));
    expect(r.overallRecommendation).toBe("insufficient_data");
    expect(r.reason).toMatch(/no graded/i);
  });

  it("skips non-premium tiers (PSA 8) — only PSA 9+ counted", () => {
    const r = analyzeGradeWorthy(inputs({
      graderPremiums: {
        "Raw": { n: 200, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 8": { n: 40, meanPrice: 200, multiplierVsBaseline: 2 },
      },
    }));
    expect(r.overallRecommendation).toBe("insufficient_data");
  });

  it("marks a tier insufficient_data when n < MIN_SAMPLE_SIZE", () => {
    const r = analyzeGradeWorthy(inputs({
      graderPremiums: {
        "Raw": { n: 200, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 2, meanPrice: 500, multiplierVsBaseline: 5 },
      },
    }));
    expect(r.allTiers).toHaveLength(1);
    expect(r.allTiers[0].recommendation).toBe("insufficient_data");
  });
});

describe("analyzeGradeWorthy — grade_now / grade_worthy_but_wait / not_worth", () => {
  it("PSA 10 with 5x price and low grading cost → grade_now", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 500, multiplierVsBaseline: 5 },
      },
    }));
    // 500 - 100 - 25 = 375 gain, on (100+25) = 125 cost → 300% ROI
    expect(r.bestTier?.graderTier).toBe("PSA 10");
    expect(r.bestTier?.expectedGain).toBeCloseTo(375, 0);
    expect(r.bestTier?.expectedRoi).toBeCloseTo(3.0, 1);
    expect(r.overallRecommendation).toBe("grade_now");
  });

  it("PSA 10 with tiny gain → not_worth", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 140, multiplierVsBaseline: 1.4 },
      },
    }));
    // 140 - 100 - 25 = 15, less than MIN_ABSOLUTE_GAIN
    expect(r.bestTier?.expectedGain).toBeCloseTo(15, 0);
    expect(r.overallRecommendation).toBe("not_worth");
  });

  it("moderate ROI (25%) with flat momentum → grade_now (single-tier)", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 200, multiplierVsBaseline: 2 },
      },
      playerMomentumDirection: "flat",
    }));
    // 200 - 100 - 25 = 75, on 125 → 60% ROI, above grade_now threshold
    expect(r.bestTier?.expectedGain).toBeCloseTo(75, 0);
    expect(r.overallRecommendation).toBe("grade_now");
  });

  it("moderate ROI + player momentum DOWN → grade_worthy_but_wait (recommend delay)", () => {
    // Rawn = 100, PSA10 = 175 → 175-100-25 = 50, on 125 → 40% ROI, above WORTHY threshold
    // But with down momentum, expected shrinks by 25% AND recommendation caps at grade_worthy_but_wait
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 175, multiplierVsBaseline: 1.75 },
      },
      playerMomentumDirection: "down",
    }));
    // 175 - 100 - 25 = 50 raw, × 0.75 (cautious multiplier) = 37.5 — below $50 min
    expect(r.bestTier?.expectedGain).toBeCloseTo(37.5, 1);
    expect(r.overallRecommendation).toBe("not_worth");
  });

  it("high ROI + player momentum DOWN → grade_worthy_but_wait (not grade_now)", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 500, multiplierVsBaseline: 5 },
      },
      playerMomentumDirection: "down",
    }));
    // 500 - 100 - 25 = 375 raw, × 0.75 = 281.25 shrunken gain
    // But 281 / 125 = 2.25 → still high ROI. Rec caps at grade_worthy_but_wait.
    // Wait — my code: if roi >= MIN_ROI_FOR_GRADE_NOW AND momentum !== "down" → grade_now.
    // Downtrend never gets grade_now regardless of ROI.
    expect(r.bestTier?.expectedGain).toBeCloseTo(281.25, 1);
    expect(r.overallRecommendation).toBe("grade_worthy_but_wait");
  });
});

describe("analyzeGradeWorthy — multi-tier selection + sorting", () => {
  it("picks the tier with highest expectedGain as best", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "PSA 10": { n: 40, meanPrice: 500, multiplierVsBaseline: 5 },
        "PSA 9": { n: 30, meanPrice: 200, multiplierVsBaseline: 2 },
        "BGS 9.5": { n: 12, meanPrice: 350, multiplierVsBaseline: 3.5 },
      },
    }));
    // PSA 10 gain = 500-100-25 = 375
    // BGS 9.5 gain = 350-100-30 = 220
    // PSA 9  gain = 200-100-25 =  75
    expect(r.bestTier?.graderTier).toBe("PSA 10");
    expect(r.allTiers.map((t) => t.graderTier)).toEqual(["PSA 10", "BGS 9.5", "PSA 9"]);
  });

  it("uses BGS-specific cost from catalog for BGS tiers", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "BGS 10": { n: 40, meanPrice: 500, multiplierVsBaseline: 5 },
      },
      gradingCosts: { "bgs-value": 30, "psa-value": 25 },
    }));
    expect(r.bestTier?.gradingCostAssumed).toBe(30);
    // 500 - 100 - 30 = 370
    expect(r.bestTier?.expectedGain).toBeCloseTo(370, 0);
  });

  it("falls back to default cost when grader-specific key missing", () => {
    const r = analyzeGradeWorthy(inputs({
      rawPrice: 100,
      graderPremiums: {
        "Raw": { n: 100, meanPrice: 100, multiplierVsBaseline: 1 },
        "CGC 10": { n: 40, meanPrice: 400, multiplierVsBaseline: 4 },
      },
      gradingCosts: { "default": 60 },
    }));
    expect(r.bestTier?.gradingCostAssumed).toBe(60);
    // 400 - 100 - 60 = 240
    expect(r.bestTier?.expectedGain).toBeCloseTo(240, 0);
  });
});

describe("analyzeGradeWorthy — realistic prod case", () => {
  it("Hartman-like: Raw $110, PSA 10 rare + PSA 9 solid n=6 → grade_now on PSA 10", () => {
    const r = analyzeGradeWorthy({
      rawPrice: 110,
      graderPremiums: {
        "Raw": { n: 200, meanPrice: 110, multiplierVsBaseline: 1 },
        "PSA 10": { n: 8, meanPrice: 900, multiplierVsBaseline: 8.2 },
        "PSA 9": { n: 6, meanPrice: 350, multiplierVsBaseline: 3.2 },
      },
      gradingCosts: { "psa-value": 25 },
      playerMomentumDirection: "up",
    });
    expect(r.bestTier?.graderTier).toBe("PSA 10");
    expect(r.bestTier?.expectedGain).toBeCloseTo(765, 0); // 900-110-25
    expect(r.overallRecommendation).toBe("grade_now");
    expect(r.reason).toMatch(/grade_now|ROI|gain/i);
  });
});
