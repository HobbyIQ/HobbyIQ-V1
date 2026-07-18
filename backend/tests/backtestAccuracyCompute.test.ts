// CF-BACKTEST-ACCURACY (Drew, 2026-07-17). Pinning tests for the
// predicted-vs-actual accuracy math.

import { describe, it, expect } from "vitest";
import { computeBacktestAccuracy, type PredictionActualPair } from "../src/services/backtest/backtestAccuracyCompute.service.js";

function pair(pred: number, actual: number, i = 0): PredictionActualPair {
  return {
    cardId: `card-${i}`,
    snapshotDate: "2026-07-01",
    predictedPrice: pred,
    actualSalePrice: actual,
    actualSaleDate: "2026-07-15",
    daysBetween: 14,
  };
}

describe("computeBacktestAccuracy — verdict gates", () => {
  it("under 20 pairs → insufficient_sample", () => {
    const pairs = Array.from({ length: 10 }, (_, i) => pair(100, 100, i));
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.verdict).toBe("insufficient_sample");
    expect(r.matchedPairs).toBe(10);
    expect(r.medianAbsPctError).toBeNull();
  });

  it("70%+ within-20% → trustworthy", () => {
    // 25 pairs, 20 within ±20%, 5 outside
    const pairs = [
      ...Array.from({ length: 20 }, (_, i) => pair(100, 105, i)),   // 5% error
      ...Array.from({ length: 5 }, (_, i) => pair(100, 150, i)),    // 50% error
    ];
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.matchedPairs).toBe(25);
    expect(r.verdict).toBe("trustworthy");
    expect(r.hitRateWithin20Pct).toBeCloseTo(20 / 25, 3);
  });

  it("Below 70% within-20% → developing", () => {
    // Only 15 out of 25 pairs within ±20%
    const pairs = [
      ...Array.from({ length: 15 }, (_, i) => pair(100, 105, i)),   // 5% error
      ...Array.from({ length: 10 }, (_, i) => pair(100, 150, i)),   // 50% error
    ];
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.verdict).toBe("developing");
    expect(r.hitRateWithin20Pct).toBeCloseTo(15 / 25, 3);
  });
});

describe("computeBacktestAccuracy — metrics", () => {
  it("median absolute error", () => {
    const pairs = Array.from({ length: 25 }, (_, i) => pair(100, 100 + i));  // errors 0..24%
    const r = computeBacktestAccuracy(pairs, 30);
    // median of |0..24|% = 12%
    expect(r.medianAbsPctError).toBeCloseTo(0.12, 2);
  });

  it("hitRateWithin10 and hitRateWithin20 counts", () => {
    // 20 pairs: 10 exact, 5 at 15%, 5 at 25%
    const pairs = [
      ...Array.from({ length: 10 }, (_, i) => pair(100, 100, i)),
      ...Array.from({ length: 5 }, (_, i) => pair(100, 115, i)),
      ...Array.from({ length: 5 }, (_, i) => pair(100, 125, i)),
    ];
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.matchedPairs).toBe(20);
    // 10 exact within 10%: 10/20 = 0.5
    expect(r.hitRateWithin10Pct).toBeCloseTo(0.5, 3);
    // 10 exact + 5 at 15% = 15/20 = 0.75 within 20%
    expect(r.hitRateWithin20Pct).toBeCloseTo(0.75, 3);
  });

  it("overShoot vs underShoot: engine bias detection", () => {
    // 20 pairs all with predicted > actual → engine too bullish
    const pairs = Array.from({ length: 20 }, (_, i) => pair(120, 100, i));
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.overShootShare).toBe(1.0);
    expect(r.underShootShare).toBe(0);
  });

  it("Mixed: engine unbiased", () => {
    const pairs = [
      ...Array.from({ length: 10 }, (_, i) => pair(100, 110, i)),   // predicted low
      ...Array.from({ length: 10 }, (_, i) => pair(100, 90, i)),    // predicted high
    ];
    const r = computeBacktestAccuracy(pairs, 30);
    expect(r.overShootShare).toBeCloseTo(0.5, 3);
    expect(r.underShootShare).toBeCloseTo(0.5, 3);
  });

  it("Zero predicted / zero actual pairs filtered out", () => {
    const clean = Array.from({ length: 20 }, (_, i) => pair(100, 100, i));
    const dirty = [
      pair(0, 100, 100),
      pair(100, 0, 101),
      pair(-50, 100, 102),
    ];
    const r = computeBacktestAccuracy([...clean, ...dirty], 30);
    expect(r.matchedPairs).toBe(20);   // only clean 20 counted
  });
});
