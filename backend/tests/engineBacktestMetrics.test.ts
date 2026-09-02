// CF-ENGINE-BACKTEST (#1651). The metrics behind the published accuracy
// number, pinned on hand-computable fixtures.
//
// What is pinned:
//   1. error is measured against the ACTUAL sale, not the prediction — the
//      difference that decides what "within 10%" means to a reader;
//   2. the hit-rate bands and the signed/absolute split;
//   3. the bias is visible separately from the spread;
//   4. the slices partition the sample (no point counted twice or lost);
//   5. the #1647 comparison names the right two cohorts, and refuses a
//      verdict below the sample floor [MUTATION: drop the floor -> red];
//   6. a slice with a wild outlier keeps a sane median (robustness is the
//      reason the headline is a median and not a mean).
import { describe, it, expect } from "vitest";
import {
  buildEngineBacktestReport,
  computeDistribution,
  freshnessBandFor,
  priceBandFor,
  isScorable,
  MIN_POINTS_FOR_SLICE,
  SPECULATION_RUNG,
  type EvaluationPoint,
} from "../src/services/backtest/engineBacktestMetrics.service.js";

const pt = (over: Partial<EvaluationPoint> = {}): EvaluationPoint => ({
  cardId: "hiq:baseball:1987:donruss:36:base:no-auto",
  asOf: "2026-07-01T00:00:00.000Z",
  predicted: 100,
  actual: 100,
  actualSoldAt: "2026-07-03T00:00:00.000Z",
  daysAhead: 2,
  rung: "exact-pool-projection",
  sport: "baseball",
  compsUsed: 8,
  poolAgeDays: 3,
  confidence: 0.8,
  ...over,
});

describe("error is measured against the actual sale", () => {
  it("a prediction of 120 against a sale of 100 is a 20% error, not 16.7%", () => {
    // The distinction that matters: 20/100 (against the actual) vs 20/120
    // (against the prediction). A reader hearing "within 20%" means the
    // former, and only the former resists being gamed by predicting high.
    const d = computeDistribution([pt({ predicted: 120, actual: 100 })]);
    expect(d.medianAbsPctError).toBeCloseTo(0.20, 6);
    expect(d.medianSignedPctError).toBeCloseTo(0.20, 6);
    expect(d.overShootShare).toBe(1);
  });

  it("an under-shoot is signed negative and shares the same denominator", () => {
    const d = computeDistribution([pt({ predicted: 80, actual: 100 })]);
    expect(d.medianAbsPctError).toBeCloseTo(0.20, 6);
    expect(d.medianSignedPctError).toBeCloseTo(-0.20, 6);
    expect(d.overShootShare).toBe(0);
  });

  it("separates bias from spread", () => {
    // Four points, every one 25% off, two high and two low. The SPREAD is
    // 25%; the BIAS is zero. An engine like this is noisy but unbiased, and
    // the report has to be able to say that — one number could not.
    const d = computeDistribution([
      pt({ predicted: 125, actual: 100 }),
      pt({ predicted: 125, actual: 100 }),
      pt({ predicted: 75, actual: 100 }),
      pt({ predicted: 75, actual: 100 }),
    ]);
    expect(d.medianAbsPctError).toBeCloseTo(0.25, 6);
    expect(d.medianSignedPctError).toBeCloseTo(0, 6);
  });

  it("the hit-rate bands count the right points", () => {
    const d = computeDistribution([
      pt({ predicted: 105, actual: 100 }),   // 5%   -> in 10, 25, 50
      pt({ predicted: 120, actual: 100 }),   // 20%  ->     in 25, 50
      pt({ predicted: 140, actual: 100 }),   // 40%  ->         in 50
      pt({ predicted: 300, actual: 100 }),   // 200% -> in none
    ]);
    expect(d.n).toBe(4);
    expect(d.within10Pct).toBeCloseTo(0.25, 6);
    expect(d.within25Pct).toBeCloseTo(0.50, 6);
    expect(d.within50Pct).toBeCloseTo(0.75, 6);
  });

  it("the median survives an outlier that would wreck a mean", () => {
    // Nine good points and one catastrophe. This is why the headline is a
    // median: one mis-identified pool should not be able to move the
    // published number.
    const points = [
      ...Array.from({ length: 9 }, () => pt({ predicted: 102, actual: 100 })),
      pt({ predicted: 100000, actual: 100 }),
    ];
    const d = computeDistribution(points);
    expect(d.medianAbsPctError).toBeCloseTo(0.02, 6);
    expect(d.meanAbsPctError as number).toBeGreaterThan(50);
  });

  it("drops points that cannot be scored", () => {
    expect(isScorable(pt({ predicted: 0 }))).toBe(false);
    expect(isScorable(pt({ actual: 0 }))).toBe(false);
    expect(isScorable(pt({ predicted: Number.NaN }))).toBe(false);
    expect(computeDistribution([pt({ predicted: 0 }), pt()]).n).toBe(1);
  });
});

describe("banding", () => {
  it("price bands are half-open and cover the line", () => {
    expect(priceBandFor(10)).toBe("under-25");
    expect(priceBandFor(25)).toBe("25-100");
    expect(priceBandFor(99.99)).toBe("25-100");
    expect(priceBandFor(100)).toBe("100-500");
    expect(priceBandFor(50_000)).toBe("2500-plus");
  });

  it("freshness bands split at the 45d staleness line", () => {
    // 45d is STALE_COMP_DAYS — the line the speculation rung lives past. The
    // bands break there so the report can be read against the ladder.
    expect(freshnessBandFor(3)).toBe("0-7d");
    expect(freshnessBandFor(44)).toBe("30-45d");
    expect(freshnessBandFor(45)).toBe("45-90d");
    expect(freshnessBandFor(200)).toBe("180d-plus");
    expect(freshnessBandFor(null)).toBe("no-pool");
  });
});

describe("the report", () => {
  it("slices partition the sample — nothing double-counted, nothing lost", () => {
    const points = [
      ...Array.from({ length: 5 }, () => pt({ sport: "baseball", actual: 50 })),
      ...Array.from({ length: 3 }, () => pt({ sport: "basketball", actual: 300 })),
      ...Array.from({ length: 2 }, () => pt({ sport: null, actual: 5000 })),
    ];
    const r = buildEngineBacktestReport(points);
    expect(r.totalPoints).toBe(10);
    for (const slice of [r.bySport, r.byPriceBand, r.byRung, r.byPoolFreshness]) {
      expect(slice.reduce((s, x) => s + x.n, 0)).toBe(10);
    }
    expect(r.bySport.map((s) => s.key).sort()).toEqual(["baseball", "basketball", "unknown"]);
  });

  it("carries the exclusion counts it was given", () => {
    const r = buildEngineBacktestReport([pt()], { "no-projection": 12, "no-held-out-sale": 4 });
    expect(r.excluded).toEqual({ "no-projection": 12, "no-held-out-sale": 4 });
  });
});

describe("#1647: the speculation rung against the fallback it replaces", () => {
  const specPoints = (n: number, err: number) =>
    Array.from({ length: n }, () => pt({
      rung: SPECULATION_RUNG, predicted: 100 * (1 + err), actual: 100, poolAgeDays: 60,
    }));
  const famPoints = (n: number, err: number) =>
    Array.from({ length: n }, () => pt({
      rung: "family-baseline", predicted: 100 * (1 + err), actual: 100, poolAgeDays: null,
    }));

  it("compares the speculation cohort against the family cohort only", () => {
    const r = buildEngineBacktestReport([
      ...specPoints(40, 0.10),
      ...famPoints(40, 0.40),
      // Exact-pool points must NOT enter either side: they never competed
      // for these cards.
      ...Array.from({ length: 50 }, () => pt({ rung: "exact-pool-projection", predicted: 101, actual: 100 })),
    ]);
    const c = r.speculationVsFallback!;
    expect(c.speculation.n).toBe(40);
    expect(c.familyFallback.n).toBe(40);
    expect(c.speculation.medianAbsPctError).toBeCloseTo(0.10, 6);
    expect(c.familyFallback.medianAbsPctError).toBeCloseTo(0.40, 6);
    // 40% - 10% = 30 percentage points better.
    expect(c.medianAbsPctErrorDelta).toBeCloseTo(0.30, 6);
    expect(c.verdict).toBe("improves");
  });

  it("says so when the rung is WORSE than what it replaced", () => {
    // The test that makes the report worth reading: it must be able to
    // return a bad answer about the change it was built to evaluate.
    const r = buildEngineBacktestReport([...specPoints(40, 0.50), ...famPoints(40, 0.15)]);
    expect(r.speculationVsFallback!.verdict).toBe("regresses");
  });

  it("refuses a verdict below the sample floor", () => {
    const r = buildEngineBacktestReport([
      ...specPoints(MIN_POINTS_FOR_SLICE - 1, 0.10),
      ...famPoints(100, 0.40),
    ]);
    const c = r.speculationVsFallback!;
    expect(c.verdict).toBe("insufficient-sample");
    // The numbers are still reported — the refusal is of the VERDICT, not of
    // the measurement.
    expect(c.speculation.n).toBe(MIN_POINTS_FOR_SLICE - 1);
    expect(c.medianAbsPctErrorDelta).not.toBeNull();
    expect(c.note).toContain("floor");
  });

  it("calls a wash a wash", () => {
    const r = buildEngineBacktestReport([...specPoints(40, 0.20), ...famPoints(40, 0.21)]);
    expect(r.speculationVsFallback!.verdict).toBe("no-material-change");
  });

  it("is null when neither cohort is present", () => {
    const r = buildEngineBacktestReport(Array.from({ length: 10 }, () => pt()));
    expect(r.speculationVsFallback).toBeNull();
  });
});
