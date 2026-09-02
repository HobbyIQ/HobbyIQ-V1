// CF-GRADE-ARB (Drew, 2026-09-02). Pinning tests for the grade-arb
// arithmetic, the no-basis refusal, and the disclosure.
//
// Every expected number below is computed BY HAND from the fixture
// curve in the comment above it. If a change moves one of these, it has
// moved a dollar figure a user would act on.

import { describe, it, expect } from "vitest";
import {
  computeGradeArb,
  tierHasEmpiricalBasis,
  basisSentenceFor,
  resolveGradingCostUsd,
  GRADE_ARB_DISCLOSURE,
  DEFAULT_GRADING_COST_USD,
} from "../src/services/portfolioiq/gradeArbCompute.service.js";
import type { ObservedGradeEntry } from "../src/services/compiq/observedGradeCurve.service.js";

/** A curve entry with every key present, overridable per test. */
function entry(over: Partial<ObservedGradeEntry> & { grade: string }): ObservedGradeEntry {
  return {
    grade: over.grade,
    grader: over.grader ?? (String(over.grade).split(" ")[0] || "Raw"),
    sampleCount: 0,
    weightedMedianPrice: null,
    plainMedianPrice: null,
    priceRangeLow: null,
    priceRangeHigh: null,
    newestSaleDate: null,
    oldestSaleDate: null,
    confidenceScore: 0,
    value: null,
    valueSource: "unavailable",
    rungLabel: null,
    estimatedMultiplier: null,
    estimatedFrom: null,
    daysSinceNewestSale: null,
    newestSalePrice: null,
    trendAdjustedValue: null,
    trendAdjustmentPct: null,
    predictedPriceAt30d: null,
    predictedPricePct: null,
    predictedPriceRangeLow: null,
    predictedPriceRangeHigh: null,
    predictedHorizonDays: 7,
    recommendation: null,
    salesHistory: [],
    referencePrice: null,
    referenceDivergencePct: null,
    referenceAnomaly: false,
    ...over,
  } as ObservedGradeEntry;
}

const observed = (grade: string, value: number, n: number) =>
  entry({
    grade,
    value,
    sampleCount: n,
    valueSource: "observed",
    rungLabel: "exact-pool-projection",
    confidenceScore: 0.8,
  });

describe("computeGradeArb — the arithmetic", () => {
  // Fixture curve:  Raw $100 (n=12), PSA 9 $180 (n=8), PSA 10 $520 (n=5).
  // Grading cost held at $25 (the disclosed default).
  //
  // BY HAND:
  //   PSA 10: 520 - 100 - 25 = 395.00 ; 395 / (100+25) = 3.16   -> 316.00%
  //   PSA  9: 180 - 100 - 25 =  55.00 ;  55 / (100+25) = 0.44   ->  44.00%
  const curve = [
    observed("Raw", 100, 12),
    observed("PSA 9", 180, 8),
    observed("PSA 10", 520, 5),
  ];

  it("computes netGain = graded - raw - cost, per tier", () => {
    const r = computeGradeArb({ gradeCurve: curve, isRaw: true, gradingCostUsd: 25 });
    expect(r.available).toBe(true);
    expect(r.rawValue).toBe(100);
    expect(r.gradingCostUsd).toBe(25);

    const psa10 = r.tiers.find((t) => t.tier === "PSA 10")!;
    const psa9 = r.tiers.find((t) => t.tier === "PSA 9")!;

    expect(psa10.gradedValue).toBe(520);
    expect(psa10.netGain).toBe(395);
    expect(psa10.netGainPct).toBe(316);

    expect(psa9.gradedValue).toBe(180);
    expect(psa9.netGain).toBe(55);
    expect(psa9.netGainPct).toBe(44);
  });

  it("carries the curve's confidence and rung onto each tier", () => {
    // confidenceScore is the entry's field name; reading `confidence`
    // would silently emit 0 on every tier.
    const r = computeGradeArb({ gradeCurve: curve, isRaw: true, gradingCostUsd: 25 });
    const psa10 = r.tiers.find((t) => t.tier === "PSA 10")!;
    expect(psa10.confidence).toBe(0.8);
    expect(psa10.rungLabel).toBe("exact-pool-projection");
    expect(psa10.sampleCount).toBe(5);
    expect(psa10.grader).toBe("PSA");
  });

  it("sorts by netGain and picks the best tier", () => {
    const r = computeGradeArb({ gradeCurve: curve, isRaw: true, gradingCostUsd: 25 });
    expect(r.tiers.map((t) => t.tier)).toEqual(["PSA 10", "PSA 9"]);
    expect(r.bestTier?.tier).toBe("PSA 10");
    expect(r.bestTier?.netGain).toBe(395);
  });

  it("moves every number with the grading-cost assumption", () => {
    // Same curve at $60: PSA 10 = 520-100-60 = 360 ; 360/160 = 2.25 -> 225%
    const r = computeGradeArb({ gradeCurve: curve, isRaw: true, gradingCostUsd: 60 });
    const psa10 = r.tiers.find((t) => t.tier === "PSA 10")!;
    expect(psa10.netGain).toBe(360);
    expect(psa10.netGainPct).toBe(225);
  });

  it("reports a negative netGain rather than hiding the tier", () => {
    // Raw $200, PSA 9 $150 -> 150 - 200 - 25 = -75. Grading destroys
    // value here, and saying so IS the product.
    const r = computeGradeArb({
      gradeCurve: [observed("Raw", 200, 10), observed("PSA 9", 150, 6)],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.available).toBe(true);
    expect(r.tiers.find((t) => t.tier === "PSA 9")!.netGain).toBe(-75);
  });

  it("includes BGS only where the pool sampled it", () => {
    const withBgs = [...curve, observed("BGS 9.5", 300, 4)];
    const r = computeGradeArb({ gradeCurve: withBgs, isRaw: true, gradingCostUsd: 25 });
    // 300 - 100 - 25 = 175
    expect(r.tiers.find((t) => t.tier === "BGS 9.5")!.netGain).toBe(175);
    // BGS 9 was never sampled — it must not appear at all.
    expect(r.tiers.some((t) => t.tier === "BGS 9")).toBe(false);
  });
});

describe("computeGradeArb — refusal when there is no empirical basis", () => {
  it("refuses with no output when no graded tier has a basis", () => {
    const r = computeGradeArb({
      gradeCurve: [
        observed("Raw", 100, 12),
        entry({ grade: "PSA 10", valueSource: "unavailable", value: null }),
        entry({ grade: "PSA 9", valueSource: "unavailable", value: null }),
      ],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.available).toBe(false);
    expect(r.refusal).toBe("no-graded-basis");
    expect(r.tiers).toEqual([]);
    expect(r.bestTier).toBeNull();
    expect(r.refusalReason).toBeTruthy();
  });

  it("refuses when the raw baseline itself has no basis", () => {
    const r = computeGradeArb({
      gradeCurve: [
        entry({ grade: "Raw", grader: "Raw", valueSource: "unavailable", value: null }),
        observed("PSA 10", 520, 5),
      ],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.available).toBe(false);
    expect(r.refusal).toBe("no-raw-basis");
    expect(r.tiers).toEqual([]);
  });

  it("refuses on an already-graded holding", () => {
    const r = computeGradeArb({ gradeCurve: [observed("Raw", 100, 12)], isRaw: false });
    expect(r.available).toBe(false);
    expect(r.refusal).toBe("not-raw");
  });

  it("drops only the unavailable tier when another tier is priced", () => {
    const r = computeGradeArb({
      gradeCurve: [
        observed("Raw", 100, 12),
        observed("PSA 9", 180, 8),
        entry({ grade: "PSA 10", valueSource: "unavailable", value: null }),
      ],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.available).toBe(true);
    expect(r.tiers.map((t) => t.tier)).toEqual(["PSA 9"]);
  });

  it("prefers a priced row when the curve carries two rows for a tier", () => {
    // curveFromUnified appends pool tiers the canonical list lacks, so a
    // second row for a label is possible. A blank row appearing first
    // must not refuse a card we can actually price.
    const r = computeGradeArb({
      gradeCurve: [
        entry({ grade: "Raw", grader: "Raw", valueSource: "unavailable", value: null }),
        observed("Raw", 100, 12),
        entry({ grade: "PSA 10", valueSource: "unavailable", value: null }),
        observed("PSA 10", 520, 5),
      ],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.available).toBe(true);
    expect(r.rawValue).toBe(100);
    expect(r.tiers[0].netGain).toBe(395);
  });

  it("treats a zero or null value as no basis regardless of label", () => {
    expect(tierHasEmpiricalBasis(entry({ grade: "PSA 10", value: 0, valueSource: "observed" }))).toBe(false);
    expect(tierHasEmpiricalBasis(entry({ grade: "PSA 10", value: null, valueSource: "observed" }))).toBe(false);
    expect(tierHasEmpiricalBasis(entry({ grade: "PSA 10", value: 10, valueSource: "unavailable" }))).toBe(false);
    expect(tierHasEmpiricalBasis(undefined)).toBe(false);
  });
});

describe("disclosure + basis sentence", () => {
  it("attaches the disclosure to results AND refusals", () => {
    const ok = computeGradeArb({
      gradeCurve: [observed("Raw", 100, 12), observed("PSA 10", 520, 5)],
      isRaw: true,
      gradingCostUsd: 25,
    });
    const refused = computeGradeArb({ gradeCurve: [], isRaw: true });
    expect(ok.disclosure).toBe(GRADE_ARB_DISCLOSURE);
    expect(refused.disclosure).toBe(GRADE_ARB_DISCLOSURE);
  });

  it("states the conditional and that cost is an assumption", () => {
    // The two claims that keep this surface honest.
    expect(GRADE_ARB_DISCLOSURE).toMatch(/do not know this card's condition/i);
    expect(GRADE_ARB_DISCLOSURE).toMatch(/\bIF it graded\b/);
    expect(GRADE_ARB_DISCLOSURE).toMatch(/assumption, not a quote/i);
  });

  it("quotes n, tier and family for an observed tier", () => {
    const s = basisSentenceFor(observed("PSA 10", 520, 5), { family: "bowman-chrome" });
    expect(s).toContain("5 sales");
    expect(s).toContain("PSA 10");
    expect(s).toContain("bowman-chrome");
    expect(s).toContain("exact-pool-projection");
  });

  it("says a single sale in the singular", () => {
    expect(basisSentenceFor(observed("PSA 9", 180, 1))).toContain("1 sale");
  });

  it("names the empirical ratio on an estimated tier and marks it estimated", () => {
    const est = entry({
      grade: "PSA 10",
      value: 480,
      sampleCount: 0,
      valueSource: "estimated",
      rungLabel: "grade-curve-estimate",
      estimatedMultiplier: 4.8,
      estimatedFrom: "Raw",
    });
    const s = basisSentenceFor(est, { family: "topps-chrome" });
    expect(s).toContain("estimated");
    expect(s).toContain("4.8x empirical ratio");
    expect(s).toContain("from its Raw sales");

    const r = computeGradeArb({
      gradeCurve: [observed("Raw", 100, 12), est],
      isRaw: true,
      gradingCostUsd: 25,
    });
    expect(r.tiers[0].valueSource).toBe("estimated");
    // 480 - 100 - 25 = 355
    expect(r.tiers[0].netGain).toBe(355);
  });
});

describe("resolveGradingCostUsd", () => {
  it("defaults to the disclosed default", () => {
    expect(resolveGradingCostUsd({})).toBe(DEFAULT_GRADING_COST_USD);
    expect(DEFAULT_GRADING_COST_USD).toBe(25);
  });

  it("honours a valid override", () => {
    expect(resolveGradingCostUsd({ GRADE_ARB_COST_USD: "40" })).toBe(40);
    expect(resolveGradingCostUsd({ GRADE_ARB_COST_USD: "0" })).toBe(0);
  });

  it("ignores a negative or unparseable override rather than manufacturing profit", () => {
    expect(resolveGradingCostUsd({ GRADE_ARB_COST_USD: "-10" })).toBe(DEFAULT_GRADING_COST_USD);
    expect(resolveGradingCostUsd({ GRADE_ARB_COST_USD: "abc" })).toBe(DEFAULT_GRADING_COST_USD);
    expect(resolveGradingCostUsd({ GRADE_ARB_COST_USD: "  " })).toBe(DEFAULT_GRADING_COST_USD);
  });
});
