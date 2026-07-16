// CF-GEM-RATE-DYNAMIC-MULTIPLIER — pin Drew's formula anchors + top-grade
// classification + confidence gating.

import { describe, it, expect } from "vitest";
import {
  multiplierFromGemRate,
  computeGemRateFromObservations,
  shouldUseGemRateMultiplier,
} from "../src/services/compiq/gemRateSignal.service.js";

describe("multiplierFromGemRate — Drew's anchor points", () => {
  it("50% gem rate → 2-3× (Drew: 2-3)", () => {
    const m = multiplierFromGemRate(0.5);
    expect(m).toBeGreaterThanOrEqual(2.0);
    expect(m).toBeLessThanOrEqual(3.0);
  });

  it("25% gem rate → 3-5× (Drew: 3-5)", () => {
    const m = multiplierFromGemRate(0.25);
    expect(m).toBeGreaterThanOrEqual(3.0);
    expect(m).toBeLessThanOrEqual(5.0);
  });

  it("10% gem rate → 5-9× (Drew: 5-9)", () => {
    const m = multiplierFromGemRate(0.10);
    expect(m).toBeGreaterThanOrEqual(5.0);
    expect(m).toBeLessThanOrEqual(9.0);
  });

  it("5% gem rate → 9-12× (Drew: 10+)", () => {
    const m = multiplierFromGemRate(0.05);
    expect(m).toBeGreaterThanOrEqual(9.0);
    expect(m).toBeLessThanOrEqual(12.0);
  });

  it("Invalid inputs return 1.0 (caller falls back to table)", () => {
    expect(multiplierFromGemRate(0)).toBe(1.0);
    expect(multiplierFromGemRate(-0.1)).toBe(1.0);
    expect(multiplierFromGemRate(1.0)).toBe(1.0);
    expect(multiplierFromGemRate(2.0)).toBe(1.0);
    expect(multiplierFromGemRate(NaN)).toBe(1.0);
  });

  it("Monotonically decreasing in gemRate (scarce → higher multiplier)", () => {
    const at50 = multiplierFromGemRate(0.5);
    const at25 = multiplierFromGemRate(0.25);
    const at10 = multiplierFromGemRate(0.10);
    const at5 = multiplierFromGemRate(0.05);
    expect(at25).toBeGreaterThan(at50);
    expect(at10).toBeGreaterThan(at25);
    expect(at5).toBeGreaterThan(at10);
  });

  it("Clamped at 1.5 minimum + 12.0 maximum", () => {
    expect(multiplierFromGemRate(0.99)).toBeGreaterThanOrEqual(1.5);
    expect(multiplierFromGemRate(0.001)).toBeLessThanOrEqual(12.0);
  });
});

describe("computeGemRateFromObservations", () => {
  it("empty observations → null", () => {
    expect(computeGemRateFromObservations([])).toBeNull();
  });

  it("PSA 10 counts as top grade + BGS 10 counts + SGC 10 counts", () => {
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "PSA 10", price: 210 },
      { grade: "BGS 10", price: 220 },
      { grade: "SGC 10", price: 190 },
      { grade: "PSA 9", price: 100 },
      { grade: "PSA 9", price: 105 },
    ]);
    expect(sig).not.toBeNull();
    // 4 top / 6 total = 0.667
    expect(sig!.totalGradedObserved).toBe(6);
    expect(sig!.topGradeObserved).toBe(4);
    expect(sig!.gemRate).toBeCloseTo(0.667, 2);
    expect(sig!.gemRateBand).toBe(">=50%");
  });

  it("Raw sales excluded from denominator", () => {
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "Raw", price: 40 },
      { grade: "Raw", price: 45 },
    ]);
    expect(sig).not.toBeNull();
    expect(sig!.totalGradedObserved).toBe(1);
    expect(sig!.topGradeObserved).toBe(1);
    expect(sig!.gemRate).toBe(1.0);
  });

  it("Confidence: >=30 observations → high", () => {
    const observations = Array.from({ length: 35 }, (_, i) => ({
      grade: i < 10 ? "PSA 10" : "PSA 9",
      price: 100 + i,
    }));
    const sig = computeGemRateFromObservations(observations);
    expect(sig!.confidence).toBe("high");
  });

  it("Confidence: 10-29 observations → medium", () => {
    const observations = Array.from({ length: 15 }, (_, i) => ({
      grade: i < 5 ? "PSA 10" : "PSA 9",
      price: 100 + i,
    }));
    const sig = computeGemRateFromObservations(observations);
    expect(sig!.confidence).toBe("medium");
  });

  it("Confidence: <10 observations → low", () => {
    const sig = computeGemRateFromObservations([
      { grade: "PSA 10", price: 200 },
      { grade: "PSA 9", price: 100 },
    ]);
    expect(sig!.confidence).toBe("low");
  });

  it("Bands align with Drew's rate cutoffs", () => {
    const big = (top: number, total: number) => {
      const obs = [];
      for (let i = 0; i < top; i++) obs.push({ grade: "PSA 10", price: 200 });
      for (let i = 0; i < total - top; i++) obs.push({ grade: "PSA 9", price: 100 });
      return computeGemRateFromObservations(obs)!;
    };
    expect(big(6, 10).gemRateBand).toBe(">=50%");
    expect(big(3, 10).gemRateBand).toBe("25-50%");
    expect(big(1, 10).gemRateBand).toBe("10-25%");
    expect(big(1, 30).gemRateBand).toBe("<10%");
  });
});

describe("shouldUseGemRateMultiplier — decision gating", () => {
  const highSig = {
    cardId: null,
    totalGradedObserved: 40,
    topGradeObserved: 10,
    gemRate: 0.25,
    gemRateBand: "25-50%" as const,
    confidence: "high" as const,
    computedAt: new Date().toISOString(),
    windowDays: 365,
  };

  it("Top grade + high confidence → use gem rate", () => {
    expect(shouldUseGemRateMultiplier(highSig, "PSA 10")).toBe(true);
    expect(shouldUseGemRateMultiplier(highSig, "BGS 10")).toBe(true);
    expect(shouldUseGemRateMultiplier(highSig, "BGS 10 Black Label")).toBe(true);
    expect(shouldUseGemRateMultiplier(highSig, "BGS 9.5")).toBe(true);
    expect(shouldUseGemRateMultiplier(highSig, "SGC 10")).toBe(true);
  });

  it("Mid-tier grade → do NOT use gem rate (falls back to table)", () => {
    expect(shouldUseGemRateMultiplier(highSig, "PSA 9")).toBe(false);
    expect(shouldUseGemRateMultiplier(highSig, "PSA 8")).toBe(false);
    expect(shouldUseGemRateMultiplier(highSig, "BGS 9")).toBe(false);
    expect(shouldUseGemRateMultiplier(highSig, "SGC 9")).toBe(false);
  });

  it("Low confidence signal → do NOT use", () => {
    const lowSig = { ...highSig, confidence: "low" as const, totalGradedObserved: 3 };
    expect(shouldUseGemRateMultiplier(lowSig, "PSA 10")).toBe(false);
  });

  it("Null signal → do NOT use", () => {
    expect(shouldUseGemRateMultiplier(null, "PSA 10")).toBe(false);
  });
});
