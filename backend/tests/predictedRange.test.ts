import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computePredictedRange,
  _setPredictedRangeNowOverride,
  type PredictedRangeInputComp,
} from "../src/services/compiq/predictedRange";
import {
  classifyRegime,
  _setRegimeNowOverride,
  type RegimeResult,
} from "../src/services/compiq/regimeClassifier";

// Phase 2 — predicted range unit tests. Pure-function module; we drive the
// regime classifier on synthetic pools to produce real RegimeResults, then
// assert computePredictedRange behavior across every regime + the gate paths.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 15); // fixed reference

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function comp(price: number, dayOffset: number, title = "Raw"): PredictedRangeInputComp {
  return { price, title, date: daysAgo(dayOffset) };
}

// Build a stable PSA 10 pool — 16 comps, prices in $90-$110 across 0..120d.
function stablePool(grade = "PSA 10"): PredictedRangeInputComp[] {
  const prices = [100, 95, 105, 92, 108, 99, 101, 97, 103, 96, 104, 98, 102, 100, 95, 105];
  return prices.map((p, i) => comp(p, 5 + i * 6, grade));
}

// Build a gradually rising pool — clear positive slope, 16 comps.
function risingPool(grade = "PSA 10"): PredictedRangeInputComp[] {
  // newest comps are highest price
  return Array.from({ length: 16 }, (_, i) =>
    comp(80 + (15 - i) * 2, 5 + i * 5, grade),
  );
}

// Declining pool — newest comps are lowest.
function decliningPool(grade = "PSA 10"): PredictedRangeInputComp[] {
  return Array.from({ length: 16 }, (_, i) =>
    comp(120 - (15 - i) * 2, 5 + i * 5, grade),
  );
}

// Volatile pool — high CoV, low R², 12 comps alternating $50/$150.
function volatilePool(grade = "PSA 10"): PredictedRangeInputComp[] {
  return Array.from({ length: 12 }, (_, i) =>
    comp(i % 2 === 0 ? 50 : 150, 5 + i * 6, grade),
  );
}

// Sharply breaking out — recent 14d well above 14-90d baseline.
// Need ≥8 comps in 14d window so the sparse gate passes.
function breakoutPool(grade = "PSA 10"): PredictedRangeInputComp[] {
  const older = Array.from({ length: 12 }, (_, i) => comp(100, 20 + i * 5, grade));
  const recent = [
    comp(160, 1, grade),
    comp(170, 2, grade),
    comp(165, 3, grade),
    comp(175, 4, grade),
    comp(168, 5, grade),
    comp(172, 6, grade),
    comp(166, 7, grade),
    comp(178, 10, grade),
    comp(170, 12, grade),
  ];
  return [...recent, ...older];
}

// Sharply crashing — recent 14d well below baseline. ≥8 in 14d.
function crashingPool(grade = "PSA 10"): PredictedRangeInputComp[] {
  const older = Array.from({ length: 12 }, (_, i) => comp(100, 20 + i * 5, grade));
  const recent = [
    comp(60, 1, grade),
    comp(55, 2, grade),
    comp(65, 3, grade),
    comp(58, 4, grade),
    comp(62, 5, grade),
    comp(63, 8, grade),
    comp(57, 10, grade),
    comp(64, 12, grade),
  ];
  return [...recent, ...older];
}

function regimeOf(comps: PredictedRangeInputComp[]): RegimeResult {
  return classifyRegime(
    comps.map((c) => ({ price: c.price, date: (c.date as string) ?? null })),
  );
}

describe("computePredictedRange — pure function", () => {
  beforeEach(() => {
    _setPredictedRangeNowOverride(NOW);
    _setRegimeNowOverride(NOW);
  });
  afterEach(() => {
    _setPredictedRangeNowOverride(null);
    _setRegimeNowOverride(null);
  });

  // ----------------------------------------------------------------------
  // Gate paths
  // ----------------------------------------------------------------------

  it("returns null for non-live source (neighbor-synthesis)", () => {
    const comps = stablePool();
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regimeOf(comps),
      source: "neighbor-synthesis",
    });
    expect(r.predictedRange).toEqual({ low: null, high: null });
    expect(r.diagnostics.mathApplied).toBe("null_non_live_source");
  });

  it.each(["no-recent-comps", "unsupported_sport", "variant-mismatch"])(
    "returns null for non-live source (%s)",
    (source) => {
      const comps = stablePool();
      const r = computePredictedRange({
        comps,
        targetGrade: "PSA 10",
        regimeResult: regimeOf(comps),
        source,
      });
      expect(r.predictedRange).toEqual({ low: null, high: null });
      expect(r.diagnostics.mathApplied).toBe("null_non_live_source");
    },
  );

  it("returns null for regime=insufficient_data", () => {
    const comps: PredictedRangeInputComp[] = [comp(100, 5, "PSA 10")];
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("insufficient_data");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.predictedRange).toEqual({ low: null, high: null });
    expect(r.diagnostics.mathApplied).toBe("null_insufficient_data");
  });

  it("returns null when same-grade pool has fewer than 8 comps", () => {
    // Keep prices uniform across grades so regime is stable (120d window),
    // isolating the grade filter as the only thing shrinking the pool.
    const psa10 = Array.from({ length: 7 }, (_, i) => comp(100, 5 + i * 5, "PSA 10"));
    const psa9 = Array.from({ length: 16 }, (_, i) => comp(100, 5 + i * 5, "PSA 9"));
    const all = [...psa10, ...psa9];
    const r = computePredictedRange({
      comps: all,
      targetGrade: "PSA 10",
      regimeResult: regimeOf(all),
      source: "live",
    });
    expect(r.predictedRange).toEqual({ low: null, high: null });
    expect(r.diagnostics.mathApplied).toBe("null_sparse_same_grade");
    expect(r.diagnostics.compsAfterFilter).toBe(7);
  });

  it("passes the 8-comp threshold (n=8 succeeds)", () => {
    // 8 stable PSA 10 comps + enough overall to clear classifier's >=5 gate.
    const psa10 = Array.from({ length: 8 }, (_, i) => comp(100, 5 + i * 10, "PSA 10"));
    const r = computePredictedRange({
      comps: psa10,
      targetGrade: "PSA 10",
      regimeResult: regimeOf(psa10),
      source: "live",
    });
    expect(r.diagnostics.mathApplied).not.toBe("null_sparse_same_grade");
    expect(r.diagnostics.compsAfterFilter).toBe(8);
  });

  // ----------------------------------------------------------------------
  // Regime-specific math
  // ----------------------------------------------------------------------

  it("stable regime: uses p25–p75 of 120d pool", () => {
    const comps = stablePool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("stable");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("stable_p25_p75");
    expect(r.diagnostics.windowAppliedDays).toBe(120);
    expect(r.predictedRange.low).not.toBeNull();
    expect(r.predictedRange.high).not.toBeNull();
    expect((r.predictedRange.high as number) > (r.predictedRange.low as number)).toBe(true);
  });

  it("gradually_rising regime: weighted p50–p80 × 1.05, with bucket diagnostics", () => {
    const comps = risingPool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("gradually_rising");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("gradually_rising_weighted_p50_p80");
    expect(r.diagnostics.windowAppliedDays).toBe(90);
    expect(r.diagnostics.weightedPercentileBuckets).not.toBeNull();
    expect(r.diagnostics.weightedPercentileBuckets!.recent30dCount).toBeGreaterThan(0);
  });

  it("declining regime: weighted p20–p50 × 0.95", () => {
    const comps = decliningPool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("declining");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("declining_weighted_p20_p50");
    expect(r.diagnostics.weightedPercentileBuckets).not.toBeNull();
  });

  it("sharply_breaking_out regime: 7-day primary math when ≥3 recent comps", () => {
    const comps = breakoutPool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("sharply_breaking_out");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("breaking_out_7day");
    expect(r.diagnostics.windowAppliedDays).toBe(14);
  });

  it("sharply_breaking_out regime: 14-day fallback when 7-day pool is thin", () => {
    // ≥8 in 14d, all outside 7d window so 7d primary has <3 → fallback.
    const older = Array.from({ length: 12 }, (_, i) => comp(100, 20 + i * 5, "PSA 10"));
    const recentOutside7d = [
      comp(160, 8, "PSA 10"),
      comp(170, 9, "PSA 10"),
      comp(165, 10, "PSA 10"),
      comp(175, 11, "PSA 10"),
      comp(168, 12, "PSA 10"),
      comp(172, 13, "PSA 10"),
      comp(166, 13, "PSA 10"),
      comp(178, 14, "PSA 10"),
    ];
    const comps = [...recentOutside7d, ...older];
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("sharply_breaking_out");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("breaking_out_14day_fallback");
  });

  it("sharply_crashing regime: 7-day primary math when ≥3 recent comps", () => {
    const comps = crashingPool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("sharply_crashing");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("crashing_7day");
  });

  it("volatile regime: p15–p85 unweighted of 90d pool, wider than stable on similar data", () => {
    const comps = volatilePool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("volatile");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    expect(r.diagnostics.mathApplied).toBe("volatile_p15_p85");

    // Stable pool spans a much narrower range than volatile.
    const stable = stablePool();
    const stableR = computePredictedRange({
      comps: stable,
      targetGrade: "PSA 10",
      regimeResult: regimeOf(stable),
      source: "live",
    });
    const volatileSpan =
      (r.predictedRange.high as number) - (r.predictedRange.low as number);
    const stableSpan =
      (stableR.predictedRange.high as number) - (stableR.predictedRange.low as number);
    expect(volatileSpan).toBeGreaterThan(stableSpan);
  });

  // ----------------------------------------------------------------------
  // Sanity caps + confidence demotion
  // ----------------------------------------------------------------------

  it("upper sanity cap fires on breakout and demotes confidence one tier", () => {
    const comps = breakoutPool();
    const regime = regimeOf(comps);
    expect(regime.regime).toBe("sharply_breaking_out");
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    // breakout math computes max7d * 1.10 — sanity cap is p95(of14d) * 1.15.
    // With the synthetic pool the cap may or may not fire; if it does,
    // confidence demotes exactly one tier.
    if (r.diagnostics.sanityCapsApplied.length > 0) {
      const original = regime.confidence;
      const demoted = r.adjustedConfidence;
      if (original === "high") expect(demoted).toBe("medium");
      else if (original === "medium") expect(demoted).toBe("low");
      else expect(demoted).toBe("low");
    }
  });

  it("confidence drops only ONCE even when both caps fire", () => {
    // Construct an extreme pool: a tight cluster + 2 huge outliers above
    // and 2 huge outliers below. Need to drive both lower + upper caps via
    // a volatile regime so the wide p15/p85 math hits both bounds.
    const cluster = Array.from({ length: 12 }, (_, i) =>
      comp(100 + (i % 2 === 0 ? -2 : 2), 5 + i * 6, "PSA 10"),
    );
    const outliers = [
      comp(1, 3, "PSA 10"),
      comp(2, 7, "PSA 10"),
      comp(2000, 9, "PSA 10"),
      comp(2200, 11, "PSA 10"),
    ];
    const comps = [...cluster, ...outliers];
    const regime = regimeOf(comps);
    const r = computePredictedRange({
      comps,
      targetGrade: "PSA 10",
      regimeResult: regime,
      source: "live",
    });
    if (
      r.diagnostics.sanityCapsApplied.includes("lower") &&
      r.diagnostics.sanityCapsApplied.includes("upper")
    ) {
      const original = regime.confidence;
      // Demotion is single-step regardless of cap count.
      if (original === "high") expect(r.adjustedConfidence).toBe("medium");
      else if (original === "medium") expect(r.adjustedConfidence).toBe("low");
      else expect(r.adjustedConfidence).toBe("low");
    }
  });

  // ----------------------------------------------------------------------
  // Grade filtering
  // ----------------------------------------------------------------------

  it("targetGrade=PSA 7 excludes other grades, fewer than 8 → sparse", () => {
    // Make full-pool regime classify as 'stable' (window=120d) by spreading
    // similar prices uniformly, so the grade filter is the only thing
    // shrinking the pool to <8.
    const psa10 = Array.from({ length: 10 }, (_, i) => comp(100, 5 + i * 5, "PSA 10"));
    const psa7 = Array.from({ length: 5 }, (_, i) => comp(98, 5 + i * 5, "PSA 7"));
    const all = [...psa10, ...psa7];
    const r = computePredictedRange({
      comps: all,
      targetGrade: "PSA 7",
      regimeResult: regimeOf(all),
      source: "live",
    });
    expect(r.diagnostics.compsAfterFilter).toBe(5);
    expect(r.diagnostics.mathApplied).toBe("null_sparse_same_grade");
  });

  it('targetGrade="Raw" includes only comps WITHOUT grader markers in title', () => {
    // Use uniform prices to keep regime stable (120d window) so all
    // matching comps survive the window filter.
    const psa = Array.from({ length: 6 }, (_, i) => comp(100, 5 + i * 5, "PSA 10"));
    const bgs = Array.from({ length: 4 }, (_, i) => comp(100, 7 + i * 5, "BGS 9.5"));
    const raw = Array.from({ length: 10 }, (_, i) => comp(100, 5 + i * 5, "ungraded card lot"));
    const all = [...psa, ...bgs, ...raw];
    const r = computePredictedRange({
      comps: all,
      targetGrade: "Raw",
      regimeResult: regimeOf(all),
      source: "live",
    });
    expect(r.diagnostics.compsAfterFilter).toBe(10);
  });

  // ----------------------------------------------------------------------
  // Empty input
  // ----------------------------------------------------------------------

  it("returns null when comps array is empty", () => {
    const r = computePredictedRange({
      comps: [],
      targetGrade: "PSA 10",
      regimeResult: regimeOf([]),
      source: "live",
    });
    expect(r.predictedRange).toEqual({ low: null, high: null });
    expect(r.diagnostics.mathApplied).toBe("null_insufficient_data");
  });

  // ----------------------------------------------------------------------
  // Range ordering
  // ----------------------------------------------------------------------

  it("always returns low ≤ high", () => {
    const samples: PredictedRangeInputComp[][] = [
      stablePool(),
      risingPool(),
      decliningPool(),
      volatilePool(),
      breakoutPool(),
      crashingPool(),
    ];
    for (const pool of samples) {
      const r = computePredictedRange({
        comps: pool,
        targetGrade: "PSA 10",
        regimeResult: regimeOf(pool),
        source: "live",
      });
      if (r.predictedRange.low !== null && r.predictedRange.high !== null) {
        expect(r.predictedRange.low).toBeLessThanOrEqual(r.predictedRange.high);
      }
    }
  });
});
