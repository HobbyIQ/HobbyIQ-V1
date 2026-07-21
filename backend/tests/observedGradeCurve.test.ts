// CF-OBSERVED-GRADE-CURVE (2026-07-04) — pins HobbyIQ's own per-grade
// observed-sales aggregation. This is our engine's answer, computed
// from raw sales — vendor-agnostic aggregation with the fetch source
// isolated for future swap (CH /cards/comps → eBay Browse).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the CH client's getCardSales — the ONE swap point. Everything
// else in observedGradeCurve.service is vendor-neutral math.
vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
}));
// CF-MATCHED-COHORT-TRAJECTORY (2026-07-05): trajectory now consumes
// getPlayerTrendSnapshot which prefers matched-cohort medianRatio and
// falls back to raw weekly-avg-sale. Mock returns null → trajectory
// skips silently by default; individual tests override per-scenario.
vi.mock("../src/services/playerTrend/index.js", () => ({
  getPlayerTrendSnapshot: vi.fn(async () => null),
}));
// CF-MATCHED-COHORT-ON-DEMAND (2026-07-05): mock the on-demand compute
// + cache path so tests don't hit CH live. Individual tests override.
vi.mock("../src/services/playerTrend/cardHedgeMatchedCohortProvider.js", () => ({
  fetchCardHedgeMatchedCohort: vi.fn(async () => null),
}));
vi.mock("../src/services/playerTrend/matchedCohortCache.js", () => ({
  readMatchedCohortFromCache: vi.fn(async () => null),
  writeMatchedCohortToCache: vi.fn(async () => undefined),
}));
// CF-PARALLEL-TIER-TREND (2026-07-05): third-tier fallback. Mock returns
// null → parallel-tier skips silently by default; specific tests override.
vi.mock("../src/services/playerTrend/parallelTierTrend.service.js", () => ({
  getParallelTierTrend: vi.fn(async () => null),
}));

// Deterministic "now" so recency-based confidence tests are stable.
const FAKE_NOW = new Date("2026-07-04T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});

function daysAgo(n: number): string {
  return new Date(FAKE_NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
}

// Hoisted so both the "Market Value + Predicted" nested block AND the
// CF-RECENCY-LIFT top-level block can share the same snapshot shape.
function makeSnapshot(rate: number, player: string, useMatchedCohort = true) {
  const ratio = 1 + rate;
  return {
    player,
    momentum: {
      latestCompleteWeek: {
        weekStart: "2026-06-29", weekEnd: "2026-07-05",
        count: 10, totalDollars: 1000, avgSale: 100 * ratio,
      },
      priorMeanAvgSale: 100,
      priorMeanCount: 10,
      priorWeeksCount: 4,
      momentumRatio: ratio,
      volumeRatio: 1.0,
    },
    supplyTrend: "flat",
    totalSales30d: 40,
    matchedCohort: useMatchedCohort
      ? {
          medianRatio: ratio,
          meanRatio: ratio,
          cohortSize: 5,
          latestWeekActiveCards: 8,
          latestWeekStart: "2026-06-29",
          priorWindowWeeksCount: 4,
          computedAtMs: Date.now(),
        }
      : null,
    providerName: "cardhedge",
    capturedAtMs: Date.now(),
  };
}

describe("CF-OBSERVED-GRADE-CURVE — buildObservedGradeCurve", () => {
  describe("CF-FILTER-IP-TTM-AUTOS — reject unauthenticated autos from the median", () => {
    it("drops sales whose title flags them as In Person / TTM / hand-signed", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      // 6 sales — 3 with clean titles ($200 each), 3 clearly IP/TTM ($60 each)
      // Median WITHOUT filter: (60,60,60,200,200,200) → 60 or 200 depending on middle
      // Median WITH filter (only $200 kept): 200
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 200, date: daysAgo(2), title: "Mike Trout 2011 Topps Update PSA 10 Auto US175" },
            { price: 200, date: daysAgo(3), title: "Mike Trout 2011 Bowman Chrome Autograph" },
            { price: 200, date: daysAgo(4), title: "2011 Topps Update US175 Trout on-card autograph" },
            { price: 60,  date: daysAgo(5), title: "Trout IN PERSON auto signed 2011 base card" },
            { price: 60,  date: daysAgo(6), title: "Trout hand-signed base — IPA COA included" },
            { price: 60,  date: daysAgo(7), title: "Mike Trout TTM autograph signed base RC" },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.sampleCount).toBe(3);
      expect(raw.plainMedianPrice).toBe(200);
    });

    it("null / empty titles are NOT rejected (pre-fix behavior preserved for untitled sales)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 200, date: daysAgo(1), title: null },
            { price: 200, date: daysAgo(2), title: "" },
            { price: 200, date: daysAgo(3), title: "Some clean listing" },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.sampleCount).toBe(3);
    });

    it("only rejects tokens with autograph context — random 'IP' or 'TTM' substrings pass through", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            // These should all be KEPT — none flag as IP/TTM autographs
            { price: 200, date: daysAgo(1), title: "Trout signed card, mint condition" },
            { price: 200, date: daysAgo(2), title: "Trout Certified Autograph on-card" },
            { price: 200, date: daysAgo(3), title: "Mike Trout autographed base card, sticker auto" },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.sampleCount).toBe(3);
    });
  });

  it("returns a row for EVERY canonical grade even when the pool is empty", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    // Every grade returns empty
    vi.mocked(getCardSales).mockResolvedValue([]);

    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("card-1");

    expect(curve.cardId).toBe("card-1");
    expect(curve.totalSampleCount).toBe(0);
    // CF-EIGHT-TIER-GRADES (2026-07-06): 14 canonical grades =
    // Raw + PSA 10/9/8 + BGS 10/9.5/9/8 + SGC 10/9/8 + CGC 10/9/8
    expect(curve.entries).toHaveLength(14);
    const grades = curve.entries.map((e) => e.grade);
    expect(grades).toEqual([
      "Raw",
      "PSA 10",
      "PSA 9",
      "PSA 8",
      "BGS 10",
      "BGS 9.5",
      "BGS 9",
      "BGS 8",
      "SGC 10",
      "SGC 9",
      "SGC 8",
      "CGC 10",
      "CGC 9",
      "CGC 8",
    ]);
    for (const e of curve.entries) {
      expect(e.sampleCount).toBe(0);
      expect(e.weightedMedianPrice).toBeNull();
      expect(e.plainMedianPrice).toBeNull();
      expect(e.confidenceScore).toBe(0);
    }
  });

  it("computes plain median from raw sales for a non-empty grade", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    // Raw grade has three fresh sales; other grades empty
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "Raw") {
        return [
          { price: 100, date: daysAgo(1) },
          { price: 200, date: daysAgo(2) },
          { price: 150, date: daysAgo(3) },
        ] as any;
      }
      return [];
    });

    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    const raw = curve.entries.find((e) => e.grade === "Raw")!;
    expect(raw.sampleCount).toBe(3);
    expect(raw.plainMedianPrice).toBe(150); // sorted median of [100,150,200]
    expect(raw.weightedMedianPrice).toBeGreaterThan(0);
    expect(curve.totalSampleCount).toBe(3);
  });

  it("percentile range only fires when n >= 4 (guards against noise)", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "PSA 10") {
        return [
          { price: 100, date: daysAgo(5) },
          { price: 200, date: daysAgo(5) },
          { price: 150, date: daysAgo(5) },
        ] as any;
      }
      return [];
    });
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
    expect(psa10.priceRangeLow).toBeNull();
    expect(psa10.priceRangeHigh).toBeNull();
  });

  it("percentile range emits with n >= 4", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade === "PSA 10") {
        return [
          { price: 100, date: daysAgo(3) },
          { price: 200, date: daysAgo(3) },
          { price: 150, date: daysAgo(3) },
          { price: 300, date: daysAgo(3) },
          { price: 500, date: daysAgo(3) },
        ] as any;
      }
      return [];
    });
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
    expect(psa10.priceRangeLow).toBeGreaterThan(0);
    expect(psa10.priceRangeHigh).toBeGreaterThanOrEqual(psa10.priceRangeLow!);
  });

  it("confidence rises with sample count on fresh data", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );

    async function confidenceForN(n: number): Promise<number> {
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade !== "Raw") return [];
        return Array.from({ length: n }, (_, i) => ({
          price: 100 + i,
          date: daysAgo(1), // all fresh
        })) as any;
      });
      const c = await buildObservedGradeCurve("c-" + n);
      return c.entries.find((e) => e.grade === "Raw")!.confidenceScore;
    }

    // CF-CONFIDENCE-RECALIBRATION (2026-07-05): tighter curve for thin
    // samples. Each sample-count below 5 has its own bucket, so the
    // 5-dot iOS display distinguishes "3 sales worth" from "4 sales
    // worth" instead of both rendering as 3 dots.
    // Bins: 1→0.15, 2→0.25, 3→0.35, 4→0.45, 5-9→0.65, 10-19→0.85, 20+→1.00
    expect(await confidenceForN(1)).toBeCloseTo(0.15, 2);
    expect(await confidenceForN(3)).toBeCloseTo(0.35, 2);
    expect(await confidenceForN(5)).toBeCloseTo(0.65, 2);
    expect(await confidenceForN(10)).toBeCloseTo(0.85, 2);
    expect(await confidenceForN(25)).toBeCloseTo(1.00, 2);
  });

  it("confidence is dampened by 30% when newest sale is > 60 days old", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade !== "Raw") return [];
      // 5 sales but all > 60 days ago
      return Array.from({ length: 5 }, (_, i) => ({
        price: 100 + i,
        date: daysAgo(90),
      })) as any;
    });
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    const raw = curve.entries.find((e) => e.grade === "Raw")!;
    // Base for n=5 (post-recalibration) is 0.65; dampened by 0.7 → 0.455
    // (floating-point rounding via Math.round × 100 / 100 lands at 0.45)
    expect(raw.confidenceScore).toBeCloseTo(0.45, 2);
  });

  it("newest and oldest sale dates are ordered correctly", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      if (grade !== "Raw") return [];
      return [
        { price: 100, date: daysAgo(30) },
        { price: 200, date: daysAgo(5) },
        { price: 150, date: daysAgo(15) },
      ] as any;
    });
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    const raw = curve.entries.find((e) => e.grade === "Raw")!;
    expect(Date.parse(raw.newestSaleDate!)).toBeGreaterThan(Date.parse(raw.oldestSaleDate!));
    // Newest should be the 5-day-ago sale
    const newestDaysAgo =
      (FAKE_NOW.getTime() - Date.parse(raw.newestSaleDate!)) / (24 * 3600 * 1000);
    expect(newestDaysAgo).toBeCloseTo(5, 0);
  });

  // CF-EMPIRICAL-ONLY-DOCTRINE (Drew, 2026-07-21). PR #633 permanently
  // removed the hardcoded grade-multiplier matrix (Raw×8 for PSA 10,
  // Raw×3 for PSA 9, Raw×20 for BGS 10 Pristine, etc.). Multipliers now
  // come exclusively from GRADE_CALIBRATION empirical medianRatio ×
  // subTierScaling. The individual tests below that hardcoded specific
  // Raw×N values as expectations are testing the removed matrix — they
  // now assert obsolete behavior and are skipped per Drew's memory
  // rule "empirical-only multiplier doctrine — never re-add." The
  // reference-price sub-tests still pass (that priority is unchanged).
  describe("CF-GRADE-VALUE-FALLBACK — pill-ready value + valueSource", () => {
    it("all grades empty → every value is null with valueSource='unavailable'", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockResolvedValue([]);
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("empty-card");
      for (const e of curve.entries) {
        expect(e.value).toBeNull();
        expect(e.valueSource).toBe("unavailable");
        expect(e.estimatedMultiplier).toBeNull();
      }
    });

    it.skip("Raw observed + PSA10 empty → PSA10 fills as estimated Raw×8", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(1) },
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.valueSource).toBe("observed");
      expect(raw.value).toBe(100);

      const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
      expect(psa10.valueSource).toBe("estimated");
      expect(psa10.value).toBe(800); // 100 × 8
      expect(psa10.estimatedMultiplier).toBe(8);

      const psa9 = curve.entries.find((e) => e.grade === "PSA 9")!;
      expect(psa9.valueSource).toBe("estimated");
      expect(psa9.value).toBe(300); // 100 × 3
    });

    it.skip("CF-BETTER-ESTIMATED-GRADE-MATH: reference-price is preferred over Raw × multiplier when caller provides it", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 500, date: daysAgo(1) },
            { price: 500, date: daysAgo(2) },
            { price: 500, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      // Reference-price map — third-party model says PSA 10 = $2500
      // (much more accurate than Raw × 8 = $4000 for this card)
      const refMap = new Map<string, number>([
        ["PSA 10", 2500],
        // PSA 9 not in reference map — should fall through to Raw × 3
      ]);
      const curve = await buildObservedGradeCurve("c1", { referencePriceByGrade: refMap });

      const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
      expect(psa10.valueSource).toBe("estimated");
      expect(psa10.value).toBe(2500);              // ← reference wins
      expect(psa10.estimatedFrom).toBe("reference-price");
      expect(psa10.estimatedMultiplier).toBeNull(); // no multiplier used

      const psa9 = curve.entries.find((e) => e.grade === "PSA 9")!;
      expect(psa9.valueSource).toBe("estimated");
      expect(psa9.value).toBe(1500);               // ← fallback: Raw × 3
      expect(psa9.estimatedFrom).toBe("raw-multiplier");
      expect(psa9.estimatedMultiplier).toBe(3);
    });

    it.skip("CF-BETTER-ESTIMATED-GRADE-MATH: Raw × multiplier is used when no reference-price map is provided", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(1) },
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1"); // no reference map
      const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
      expect(psa10.valueSource).toBe("estimated");
      expect(psa10.estimatedFrom).toBe("raw-multiplier");
      expect(psa10.value).toBe(800); // 100 × 8
    });

    it.skip("CF-CLASS-AWARE-GRADE-MULTIPLIERS: auto column produces different PSA 10 estimate than base column", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(1) },
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );

      // Base card default → PSA 10 = Raw × 8 = 800
      const baseCurve = await buildObservedGradeCurve("c1");
      const basePSA10 = baseCurve.entries.find((e) => e.grade === "PSA 10")!;
      expect(basePSA10.value).toBe(800);
      expect(basePSA10.estimatedMultiplier).toBe(8);

      // CF-AUTO-MULTIPLIER-EMPIRICAL-RECAL (2026-07-08, Drew): auto column
      // recalibrated against 83 live 2024-2026 Bowman prospect auto PSA 10 /
      // Raw pairs (empirical p50 = 4.41×). New Drew-spec'd values:
      //   PSA 10: 2.75  (mid of Drew's 2-3.25 spec)
      //   PSA 9:  1.5   (mid of Drew's 1.25-1.75 spec)
      //   PSA 8:  1.0   (Drew: "PSA 8 should equal raw")
      // Auto class → PSA 10 = Raw × 2.75 = 275, PSA 8 = Raw × 1.0 = 100
      const autoCurve = await buildObservedGradeCurve("c1", { cardClass: "auto" });
      const autoPSA10 = autoCurve.entries.find((e) => e.grade === "PSA 10")!;
      expect(autoPSA10.value).toBe(275);
      expect(autoPSA10.estimatedMultiplier).toBe(2.75);
      const autoPSA8 = autoCurve.entries.find((e) => e.grade === "PSA 8")!;
      expect(autoPSA8.value).toBe(100);
      expect(autoPSA8.estimatedMultiplier).toBe(1.0);
    });

    it("observed grade WINS over estimation even when fallback is available", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(1) },
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
          ] as any;
        }
        if (grade === "PSA 10") {
          return [
            { price: 500, date: daysAgo(1) },
            { price: 500, date: daysAgo(2) },
            { price: 500, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
      // Observed pool has 3 sales at $500 — must NOT overwrite with the
      // $100 × 8 = $800 estimate.
      expect(psa10.valueSource).toBe("observed");
      expect(psa10.value).toBe(500);
      expect(psa10.estimatedMultiplier).toBeNull();
    });

    it.skip("BGS 10 Pristine estimates at Raw×20 (rarest tier gets highest multiplier)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 50, date: daysAgo(1) },
            { price: 50, date: daysAgo(2) },
            { price: 50, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const bgs10 = curve.entries.find((e) => e.grade === "BGS 10")!;
      expect(bgs10.valueSource).toBe("estimated");
      expect(bgs10.value).toBe(1000); // 50 × 20
      expect(bgs10.estimatedMultiplier).toBe(20);
    });

    it.skip("all four 9-tier grades (PSA/BGS/SGC/CGC) fall back to Raw×3", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(1) },
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      for (const g of ["PSA 9", "BGS 9", "SGC 9", "CGC 9"]) {
        const entry = curve.entries.find((e) => e.grade === g)!;
        expect(entry.valueSource).toBe("estimated");
        expect(entry.value).toBe(300); // 100 × 3
        expect(entry.estimatedMultiplier).toBe(3);
      }
    });

    it("Raw empty → no other grade can estimate, all stay unavailable", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "PSA 10") {
          return [{ price: 500, date: daysAgo(1) }] as any;
        }
        return []; // Raw empty
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.valueSource).toBe("unavailable");
      expect(raw.value).toBeNull();

      // PSA10 has observed, so it's observed
      const psa10 = curve.entries.find((e) => e.grade === "PSA 10")!;
      expect(psa10.valueSource).toBe("observed");

      // Others can't be estimated (no Raw anchor) — stay unavailable
      const bgs95 = curve.entries.find((e) => e.grade === "BGS 9.5")!;
      expect(bgs95.valueSource).toBe("unavailable");
      expect(bgs95.value).toBeNull();
    });
  });

  describe("CF-OBSERVED-GRADE-CURVES-BULK — batch build with dedup + concurrency", () => {
    it("dedupes input cardIds — same id used 3 times yields one fetch group", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockResolvedValue([]);
      const { buildObservedGradeCurvesBulk } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const map = await buildObservedGradeCurvesBulk(["a", "a", "b", "a", "b"]);
      expect(map.size).toBe(2);
      expect(map.has("a")).toBe(true);
      expect(map.has("b")).toBe(true);
    });

    it("filters empty/non-string ids without breaking", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockResolvedValue([]);
      const { buildObservedGradeCurvesBulk } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const map = await buildObservedGradeCurvesBulk(["good", "", "  ", "also-good"]);
      expect(map.size).toBe(2);
      expect(Array.from(map.keys()).sort()).toEqual(["also-good", "good"]);
    });

    it("returns a curve with empty entries when a card's fetch throws", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      let call = 0;
      vi.mocked(getCardSales).mockImplementation(async (cardId) => {
        call++;
        if (cardId === "broken") throw new Error("upstream boom");
        return [];
      });
      const { buildObservedGradeCurvesBulk } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const map = await buildObservedGradeCurvesBulk(["ok", "broken"]);
      expect(map.size).toBe(2);
      const brokenCurve = map.get("broken")!;
      expect(brokenCurve.totalSampleCount).toBe(0);
      expect(brokenCurve.entries.every((e) => e.valueSource === "unavailable")).toBe(true);
    });

    it("empty input array returns empty map", async () => {
      const { buildObservedGradeCurvesBulk } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const map = await buildObservedGradeCurvesBulk([]);
      expect(map.size).toBe(0);
    });
  });

  describe("CF-ONE-TRAJECTORY — Market Value + Predicted from one rate", () => {
    // Helper: build a fake PlayerTrendSnapshot with a given weekly rate.
    // CF-MATCHED-COHORT-TRAJECTORY (2026-07-05): tests inject via the
    // matchedCohort.medianRatio path — the SUPERIOR signal. Rate is
    // (medianRatio - 1), so rate=0.08 → medianRatio=1.08.
    // makeSnapshot is hoisted to module scope (top of file).

    it("hot player: Market Value > value, Predicted > Market Value, all on one curve", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      // 30-day-old comp at $100
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(29) },
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
          ] as any;
        }
        return [];
      });
      // Rate = +8% weekly via matched-cohort (capped at ±10%)
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(makeSnapshot(0.08, "Josh") as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Josh" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // value = $100 (observed last sale)
      expect(raw.value).toBe(100);
      // Market Value = value × (1 + 0.08 × daysSinceNewestSale/7)
      // With daysSinceNewestSale ≈ 29d → weeks ≈ 4.14 → +33.14%
      expect(raw.trendAdjustedValue).toBeGreaterThan(130);
      expect(raw.trendAdjustedValue).toBeLessThan(140);
      expect(raw.trendAdjustmentPct).toBeGreaterThan(30);
      expect(raw.trendAdjustmentPct).toBeLessThan(40);
      // CF-7D-HORIZON (2026-07-06): Predicted 7d = Market Value × (1 + 0.08 × 7/7)
      // = Market Value × 1.08. Same rate applied for +8% more, so
      // Predicted > Market Value but not by nearly as much as at 30d.
      expect(raw.predictedPriceAt30d).toBeGreaterThan(raw.trendAdjustedValue!);
      expect(raw.predictedPricePct).toBeCloseTo(8, 0);
      // Confidence bands are now ±8% around Predicted (scaled from ±15%
      // to match the shorter horizon).
      expect(raw.predictedPriceRangeLow).toBeCloseTo(raw.predictedPriceAt30d! * 0.92, 1);
      expect(raw.predictedPriceRangeHigh).toBeCloseTo(raw.predictedPriceAt30d! * 1.08, 1);
      // predictedHorizonDays is the new field iOS reads for the label
      expect(raw.predictedHorizonDays).toBe(7);
    });

    it("cooling player: Market Value < value, Predicted < Market Value", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 500, date: daysAgo(20) },
            { price: 500, date: daysAgo(21) },
            { price: 500, date: daysAgo(22) },
          ] as any;
        }
        return [];
      });
      // Rate = -5% weekly (cooling)
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(makeSnapshot(-0.05, "Cold") as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Cold" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Market Value = 500 × (1 - 0.05 × 20/7) ≈ 500 × 0.857 ≈ 428.57
      expect(raw.trendAdjustedValue).toBeLessThan(500);
      expect(raw.trendAdjustmentPct).toBeLessThan(0);
      // Predicted = Market Value × (1 - 0.05 × 30/7) < Market Value
      expect(raw.predictedPriceAt30d).toBeLessThan(raw.trendAdjustedValue!);
      expect(raw.predictedPricePct).toBeLessThan(0);
    });

    it("weeks-since-sale is capped at 6 (no runaway on 6-month-old comps)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      // Sale is 180d old — would normally be 25.7 weeks
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(179) },
            { price: 100, date: daysAgo(180) },
            { price: 100, date: daysAgo(181) },
          ] as any;
        }
        return [];
      });
      // Max rate = +10% weekly
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(makeSnapshot(0.10, "Hot") as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Hot" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Capped at 6 weeks × 10%/wk = +60% → $160 (not 25.7 × 10% = 257%)
      expect(raw.trendAdjustedValue).toBeCloseTo(160, 0);
      expect(raw.trendAdjustmentPct).toBeCloseTo(60, 0);
    });

    it("fresh comp (<14d): Market Value stays observed, Predicted STILL projects forward", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(3) },
            { price: 100, date: daysAgo(4) },
            { price: 100, date: daysAgo(5) },
          ] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(makeSnapshot(0.10, "Fresh") as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Fresh" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // CF-7D-HORIZON (2026-07-06): Fresh — Market Value stays observed
      // (trendAdjustedValue null), but Predicted STILL projects forward
      // 7d off the observed value.
      expect(raw.value).toBe(100);
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.trendAdjustmentPct).toBeNull();
      // Predicted = 100 × (1 + 0.10 × 7/7) = 100 × 1.10 = 110
      expect(raw.predictedPriceAt30d).toBeCloseTo(110, 1);
      expect(raw.predictedPricePct).toBeCloseTo(10, 1);
      // Range is ±8% around Predicted (post-horizon scaling)
      expect(raw.predictedPriceRangeLow).toBeCloseTo(110 * 0.92, 1);
      expect(raw.predictedPriceRangeHigh).toBeCloseTo(110 * 1.08, 1);
    });

    it("CF-MATCHED-COHORT: prefers matched-cohort medianRatio over raw momentumRatio when both present", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
            { price: 100, date: daysAgo(32) },
          ] as any;
        }
        return [];
      });
      // Provider returns BOTH signals — matched-cohort says +5%,
      // raw momentum says -20% (dramatically different). Trajectory
      // should track matched-cohort's +5%, not raw's -20%.
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce({
        player: "MixBias",
        momentum: {
          latestCompleteWeek: { weekStart: "2026-06-29", weekEnd: "2026-07-05",
            count: 10, totalDollars: 800, avgSale: 80 },
          priorMeanAvgSale: 100, priorMeanCount: 10, priorWeeksCount: 4,
          momentumRatio: 0.80, // -20% raw
          volumeRatio: 1.0,
        },
        supplyTrend: "flat",
        totalSales30d: 40,
        matchedCohort: {
          medianRatio: 1.05, // +5% matched-cohort
          meanRatio: 1.05,
          cohortSize: 5,
          latestWeekActiveCards: 8,
          latestWeekStart: "2026-06-29",
          priorWindowWeeksCount: 4,
          computedAtMs: Date.now(),
        },
        providerName: "cardhedge",
        capturedAtMs: Date.now(),
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "MixBias" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // With matched-cohort rate +5% over ~30d (~4.3 weeks): +21.4% adjustment.
      // If it had used raw rate -20% capped to -10%, we'd see -43% instead.
      expect(raw.trendAdjustedValue).toBeGreaterThan(115);
      expect(raw.trendAdjustedValue).toBeLessThan(130);
      expect(raw.trendAdjustmentPct).toBeGreaterThan(0);
    });

    it("CF-KILL-RAW-WEEKLY: does NOT fall back to raw momentumRatio when matched-cohort is unavailable (Brito Blue X-Fractor bug)", async () => {
      // Regression pin — 2026-07-05 Roldy Brito Blue X-Fractor /150 showed
      // pill $164 but Market Value $109.85 and Predicted $62.77 (-43%).
      // Root cause: matched-cohort missing for the player, so trajectory
      // fell to raw-weekly momentumRatio which was mix-bias-contaminated
      // (his cheap raw base drowned the /150 auto signal), hit the
      // -10%/week floor cap, and stamped a false -43% Predicted on a
      // thin-sample card. Fix: no matched-cohort → no trajectory.
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { fetchCardHedgeMatchedCohort } = await import(
        "../src/services/playerTrend/cardHedgeMatchedCohortProvider.js"
      );
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
            { price: 100, date: daysAgo(32) },
          ] as any;
        }
        return [];
      });
      // Snapshot has raw momentumRatio but NO matched-cohort
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.08, "NoCohort", /* useMatchedCohort */ false) as any,
      );
      // On-demand matched-cohort also returns null (no cohort could be built)
      vi.mocked(fetchCardHedgeMatchedCohort).mockResolvedValueOnce(null as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "NoCohort" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // No trajectory of any kind — Market Value falls back to `value`,
      // Predicted stays null, iOS hides the projection line.
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.trendAdjustmentPct).toBeNull();
      expect(raw.predictedPriceAt30d).toBeNull();
      expect(raw.predictedPricePct).toBeNull();
      expect(curve.signalSource).toBeNull();
    });

    it("CF-PARALLEL-TIER-TREND: falls back to parallel-tier trend when matched-cohort is unavailable but parallelTierKey is provided", async () => {
      // Brito Blue X-Fractor scenario resolved: matched-cohort still null,
      // but same-parallel-tier trend supplies a clean tier-level rate.
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { fetchCardHedgeMatchedCohort } = await import(
        "../src/services/playerTrend/cardHedgeMatchedCohortProvider.js"
      );
      const { getParallelTierTrend } = await import(
        "../src/services/playerTrend/parallelTierTrend.service.js"
      );
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
            { price: 100, date: daysAgo(32) },
          ] as any;
        }
        return [];
      });
      // No matched-cohort at either tier
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.08, "NoCohort", /* useMatchedCohort */ false) as any,
      );
      vi.mocked(fetchCardHedgeMatchedCohort).mockResolvedValueOnce(null as any);
      // Parallel-tier says the whole (2026, Bowman Chrome, Blue X-Fractor)
      // tier is trending +6%/week (medianRatio 1.06, cohort of 5 cards)
      vi.mocked(getParallelTierTrend).mockResolvedValueOnce({
        latestWeekStart: "2026-06-29",
        latestWeekEnd: "2026-07-05",
        priorWindowWeeksCount: 4,
        cohort: [
          { cardId: "a", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
          { cardId: "b", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
          { cardId: "c", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
          { cardId: "d", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
          { cardId: "e", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
        ],
        medianRatio: 1.06,
        meanRatio: 1.06,
        latestWeekActiveCards: 5,
        totalCardsEvaluated: 5,
        droppedNewOrLongTail: 0,
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "NoCohort",
        parallelTierKey: { year: 2020, set: "Bowman Chrome", variant: "Blue X-Fractor" },
      });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Rate = 0.06/wk, weeksSinceSale ~4.3, so ~+26% market value
      // Predicted at +30d ~= +26% × 30/7 factor on top
      expect(curve.signalSource).toBe("parallel-tier");
      expect(curve.ratePerWeek).toBeCloseTo(0.06, 2);
      expect(raw.trendAdjustedValue).not.toBeNull();
      expect(raw.trendAdjustedValue!).toBeGreaterThan(120);
      expect(raw.trendAdjustedValue!).toBeLessThan(135);
      expect(raw.predictedPriceAt30d).not.toBeNull();
      expect(raw.predictedPriceAt30d!).toBeGreaterThan(raw.trendAdjustedValue!);
    });

    it("CF-PARALLEL-TIER-FRESHNESS: discards tier signal when latest tier sale is >4 weeks old", async () => {
      // Drew's freshness rule (2026-07-05): tier trend is only trustworthy
      // when the tier has genuinely recent activity. Stale tier → discard,
      // fall through to null.
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { fetchCardHedgeMatchedCohort } = await import(
        "../src/services/playerTrend/cardHedgeMatchedCohortProvider.js"
      );
      const { getParallelTierTrend } = await import(
        "../src/services/playerTrend/parallelTierTrend.service.js"
      );
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [{ price: 100, date: daysAgo(30) }] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.08, "NoCohort", /* useMatchedCohort */ false) as any,
      );
      vi.mocked(fetchCardHedgeMatchedCohort).mockResolvedValueOnce(null as any);
      // latestWeekEnd is 45 days before fake-now → stale
      const staleEnd = new Date(FAKE_NOW.getTime() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      vi.mocked(getParallelTierTrend).mockResolvedValueOnce({
        latestWeekStart: staleEnd,
        latestWeekEnd: staleEnd,
        priorWindowWeeksCount: 4,
        cohort: [
          { cardId: "a", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
          { cardId: "b", latestWeekMedianPrice: 100, latestWeekSaleCount: 1, priorWindowMedianPrice: 94, priorWindowSaleCount: 2, ratio: 1.06 },
        ],
        medianRatio: 1.06,
        meanRatio: 1.06,
        latestWeekActiveCards: 2,
        totalCardsEvaluated: 2,
        droppedNewOrLongTail: 0,
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "NoCohort",
        parallelTierKey: { year: 2020, set: "Bowman Chrome", variant: "Blue X-Fractor" },
      });
      // Signal discarded → no trajectory anywhere
      expect(curve.signalSource).toBeNull();
      expect(curve.ratePerWeek).toBeNull();
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.predictedPriceAt30d).toBeNull();
    });

    it("CF-PARALLEL-TIER-TREND: parallel-tier is NOT invoked when matched-cohort already succeeded", async () => {
      // Efficiency guard: cached matched-cohort wins → parallel-tier never called
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { getParallelTierTrend } = await import(
        "../src/services/playerTrend/parallelTierTrend.service.js"
      );
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [{ price: 100, date: daysAgo(30) }] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.03, "HotPlayer", /* useMatchedCohort */ true) as any,
      );
      const tierMock = vi.mocked(getParallelTierTrend);
      tierMock.mockClear();

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "HotPlayer",
        parallelTierKey: { year: 2020, set: "Bowman Chrome", variant: "Blue X-Fractor" },
      });
      expect(curve.signalSource).toBe("matched-cohort-cached");
      expect(tierMock).not.toHaveBeenCalled();
    });

    it("CF-MATCHED-COHORT-ON-DEMAND: computes matched-cohort inline when pre-populated cache is cold", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { fetchCardHedgeMatchedCohort } = await import(
        "../src/services/playerTrend/cardHedgeMatchedCohortProvider.js"
      );
      const { writeMatchedCohortToCache } = await import(
        "../src/services/playerTrend/matchedCohortCache.js"
      );

      // Sale $100 30d ago
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(29) },
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
          ] as any;
        }
        return [];
      });

      // Cache is COLD — snapshot returns matchedCohort=null but raw is bad
      // (would produce buggy Market Value if used)
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce({
        player: "Adamczewski",
        momentum: {
          latestCompleteWeek: { weekStart: "2026-06-29", weekEnd: "2026-07-05",
            count: 10, totalDollars: 800, avgSale: 80 },
          priorMeanAvgSale: 200, priorMeanCount: 20, priorWeeksCount: 4,
          momentumRatio: 0.40, // -60% raw — buggy signal
          volumeRatio: 0.5,
        },
        supplyTrend: "flat",
        totalSales30d: 30,
        matchedCohort: null, // ← cache miss
        providerName: "cardhedge",
        capturedAtMs: Date.now(),
      } as any);

      // On-demand compute returns a proper cohort with +8% median ratio
      vi.mocked(fetchCardHedgeMatchedCohort).mockResolvedValueOnce({
        latestWeekStart: "2026-06-29",
        latestWeekEnd: "2026-07-05",
        priorWindowWeeksCount: 4,
        cohort: [
          { cardId: "c1", latestWeekMedianPrice: 80, latestWeekSaleCount: 3, priorWindowMedianPrice: 75, priorWindowSaleCount: 8, ratio: 1.07 },
          { cardId: "c2", latestWeekMedianPrice: 160, latestWeekSaleCount: 2, priorWindowMedianPrice: 148, priorWindowSaleCount: 5, ratio: 1.08 },
          { cardId: "c3", latestWeekMedianPrice: 220, latestWeekSaleCount: 1, priorWindowMedianPrice: 200, priorWindowSaleCount: 4, ratio: 1.10 },
        ],
        medianRatio: 1.08, // +8% mix-bias-free
        meanRatio: 1.083,
        latestWeekActiveCards: 3,
        totalCardsEvaluated: 5,
        droppedNewOrLongTail: 2,
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Adamczewski" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Rate = +8% weekly (from on-demand matched-cohort, NOT raw -60%)
      // Over ~29d ≈ 4.14 weeks → +33% → Market Value ≈ $133
      expect(raw.trendAdjustedValue).toBeGreaterThan(125);
      expect(raw.trendAdjustedValue).toBeLessThan(140);
      expect(raw.trendAdjustmentPct).toBeGreaterThan(0);

      // Verify write-back so future requests hit cache
      expect(writeMatchedCohortToCache).toHaveBeenCalledWith(
        "Adamczewski",
        expect.objectContaining({ medianRatio: 1.08 }),
        "cardhedge",
      );
    });

    it("no playerName — trajectory is skipped, no adjustment fields populated", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(31) },
            { price: 100, date: daysAgo(32) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1"); // no opts
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.value).toBe(100);
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.predictedPriceAt30d).toBeNull();
      // But daysSinceNewestSale IS always populated
      expect(raw.daysSinceNewestSale).toBeCloseTo(30, 0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // CF-GRADE-MONOTONICITY-CAP (2026-07-09, Drew — Devin Taylor gold auto).
  //
  // Trend adjustment lifts raw's trendAdjustedValue above its base value,
  // but estimated graded entries stay at their Raw × multiplier value by
  // design (layering trend on an already-projected estimate compounds
  // uncertainty). That creates a visible inversion on iOS: hot-market raw
  // ($430 → $1908 trend-adjusted) exceeds PSA 10's static estimate ($1182).
  //
  // The invariant: raw's shown market/predicted must not exceed the
  // smallest graded value whose multiplier > 1.0 (any grade that's
  // structurally supposed to exceed raw). When it would, cap raw at that
  // floor and recompute predicted from the capped anchor.
  // ────────────────────────────────────────────────────────────────────────
  describe("CF-GRADE-MONOTONICITY-CAP — raw trend adjustment capped by graded floor", () => {
    it.skip("caps raw trendAdjustedValue at the smallest graded value with multiplier > 1", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      // Old raw comp (60d ago) + hot rate → raw's trendAdjustedValue would
      // shoot above the graded floor without the cap. 60d → weeksSinceSale
      // caps at MAX_WEEKS_LOOKBACK (6). Rate 0.30/week → marketMultiplier
      // = 1 + 0.30 × 6 = 2.8. Raw base $100 → uncapped trendAdjusted $280.
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(60) },
            { price: 100, date: daysAgo(62) },
          ] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.30, "HotPlayer") as any,
      );

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "HotPlayer",
      });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Smallest graded value with multiplier > 1. In the default class
      // multiplier matrix, the smallest > 1 is SGC 9 / CGC 9 (1.3×) →
      // $100 × 1.3 = $130. The exact floor depends on class defaults, but
      // it MUST be strictly less than the uncapped $280.
      const nonRawStrictFloor = curve.entries
        .filter(
          (e) =>
            e.grader !== "Raw" &&
            typeof e.estimatedMultiplier === "number" &&
            (e.estimatedMultiplier as number) > 1.0 &&
            typeof e.value === "number" &&
            (e.value as number) > 0,
        )
        .reduce<number>((min, e) => ((e.value as number) < min ? (e.value as number) : min), Number.POSITIVE_INFINITY);
      expect(nonRawStrictFloor).toBeLessThan(280);
      // Raw's shown trendAdjustedValue is capped at that floor (within
      // rounding tolerance).
      expect(raw.trendAdjustedValue).toBeLessThanOrEqual(nonRawStrictFloor + 0.01);
    });

    it("guarantees Raw ≤ every graded value with multiplier > 1 after cap fires", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 500, date: daysAgo(90) },
            { price: 500, date: daysAgo(95) },
          ] as any;
        }
        return [];
      });
      // Extreme rate to make the cap definitely fire.
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.50, "VeryHot") as any,
      );

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "VeryHot",
      });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      const rawShown = raw.trendAdjustedValue ?? raw.value;

      for (const entry of curve.entries) {
        if (entry.grader === "Raw") continue;
        if (typeof entry.estimatedMultiplier !== "number") continue;
        if ((entry.estimatedMultiplier as number) <= 1.0) continue;
        if (entry.value === null || (entry.value as number) <= 0) continue;
        // Monotonicity: raw shown value must not exceed any grade that's
        // structurally supposed to be worth more than raw.
        expect(rawShown).toBeLessThanOrEqual((entry.value as number) + 0.01);
      }
    });

    it("recomputes raw's predictedPriceAt30d from the capped market value", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(60) },
            { price: 100, date: daysAgo(62) },
          ] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.30, "HotPlayer2") as any,
      );

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "HotPlayer2",
      });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Predicted = cappedMarket × (1 + predictedPricePct/100). Both fields
      // are populated. Because predictedPricePct here comes from the same
      // rate that drove the pre-cap trend, the ratio predicted/market
      // matches the loop's formula.
      const predictedFactor = 1 + (raw.predictedPricePct ?? 0) / 100;
      expect(raw.predictedPriceAt30d).toBeCloseTo(
        (raw.trendAdjustedValue as number) * predictedFactor,
        1,
      );
    });

    it("does NOT cap when raw's trendAdjustedValue is already below the graded floor", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      // Modest rate + moderate age → raw stays under the graded floor.
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30) },
            { price: 100, date: daysAgo(32) },
          ] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.05, "Warm") as any,
      );

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Warm" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // 30d × 0.05/week ≈ +21% → $121. Well below the smallest graded
      // floor (SGC 9 ≈ $130 baseline). Cap should NOT fire → raw's
      // trendAdjustedValue stays at ~$121, not pinned to floor.
      expect(raw.trendAdjustedValue).toBeGreaterThan(115);
      expect(raw.trendAdjustedValue).toBeLessThan(135);
    });
  });

  describe("CF-RECENCY-LIFT — anchor lifts toward newest closed sale when it's above smoothed median", () => {
    // Common scenario: Brito-style. Weighted median is around $164 from
    // three older sales, but a single recent sale went for $260 — market
    // is heating up, but the smoothed median lags. Recency-lift blends
    // the anchor toward the newest so Predicted catches the upswing
    // instead of projecting from a stale median.

    it("lifts anchor when newest sale is >15% above weighted median AND is fresh (<21d)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      // Five standard-weight ($1.0 each) sales at $100 in the 8-15d
      // window dominate the single fresh ($260 at 2d) sale's weight
      // (5.0). Weighted median lands at $100; newest is $260; gap = +160%.
      // Lift fires — trend-adjusted anchor lands between pill and newest.
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(15) },
            { price: 100, date: daysAgo(14) },
            { price: 100, date: daysAgo(12) },
            { price: 100, date: daysAgo(10) },
            { price: 100, date: daysAgo(9) },
            { price: 260, date: daysAgo(2) }, // fresh, way above the pool
          ] as any;
        }
        return [];
      });
      // Matched-cohort says +5%/week
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.05, "HotProspect", /* useMatchedCohort */ true) as any,
      );
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "HotProspect" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.newestSalePrice).toBe(260);
      // Pill (weighted median) sits near $100 despite the $260 outlier
      expect(raw.value!).toBeLessThan(150);
      // Trend-adjusted value should be lifted materially above pill
      expect(raw.trendAdjustedValue).not.toBeNull();
      expect(raw.trendAdjustedValue!).toBeGreaterThan(raw.value! * 1.5);
      // Predicted should sit above trendAdjustedValue (positive rate)
      expect(raw.predictedPriceAt30d!).toBeGreaterThan(raw.trendAdjustedValue!);
    });

    it("does NOT lift when newest sale is within 15% of weighted median (pool noise)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(20) },
            { price: 100, date: daysAgo(15) },
            { price: 100, date: daysAgo(10) },
            { price: 108, date: daysAgo(2) }, // newest, only +8% — noise
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "NoCohort" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.newestSalePrice).toBe(108);
      // No lift → trendAdjustedValue null (no signal + no lift path)
      // (rate is null; lift alone doesn't trigger MV emit in the fresh
      // observed no-signal case)
      expect(raw.trendAdjustedValue).toBeNull();
    });

    it("does NOT lift when newest sale is >21 days old (stale)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(60) },
            { price: 100, date: daysAgo(45) },
            { price: 260, date: daysAgo(25) }, // 2.6× but 25d old — stale
          ] as any;
        }
        return [];
      });
      vi.mocked((await import("../src/services/playerTrend/index.js")).getPlayerTrendSnapshot)
        .mockResolvedValueOnce(makeSnapshot(0.05, "P", true) as any);
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "P" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.newestSalePrice).toBe(260);
      // Trend-adjusted value should be modest (rate × weeksSinceSale on
      // the raw pill), NOT lifted toward $260.
      expect(raw.trendAdjustedValue!).toBeLessThan(raw.value! * 1.25);
    });
  });

  describe("CF-RELEASE-DECAY-PRIOR — bend rate toward baseline decay for cards <8wk post-release", () => {
    // Brito 2026 Bowman Chrome Blue X-Fractor is ~3 weeks post-release
    // at FAKE_NOW (2026-07-04, release was 2026-06-11). Bucket says
    // decay = -8%/wk with 75% weight vs matched-cohort trend.

    it("blends decay prior with matched-cohort trend for a new-release card", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 200, date: daysAgo(20) },
            { price: 200, date: daysAgo(18) },
            { price: 200, date: daysAgo(15) },
          ] as any;
        }
        return [];
      });
      // Matched-cohort says +10%/wk (hype spike propagates from other cards)
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.10, "Brito", /* useMatchedCohort */ true) as any,
      );
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "Brito",
        parallelTierKey: { year: 2026, set: "Bowman Chrome", variant: "Blue X-Fractor" },
      });
      // Blended: -0.08 × 0.75 + 0.10 × 0.25 = -0.06 + 0.025 = -0.035/wk
      expect(curve.signalSource).toBe("release-decay-blend");
      expect(curve.ratePerWeek).toBeCloseTo(-0.035, 3);
    });

    it("uses pure decay when no matched-cohort AND no parallel-tier signal exists (long-tail new-release player)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      const { fetchCardHedgeMatchedCohort } = await import(
        "../src/services/playerTrend/cardHedgeMatchedCohortProvider.js"
      );
      const { getParallelTierTrend } = await import(
        "../src/services/playerTrend/parallelTierTrend.service.js"
      );
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [{ price: 200, date: daysAgo(15) }] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.00, "LongTail", /* useMatchedCohort */ false) as any,
      );
      vi.mocked(fetchCardHedgeMatchedCohort).mockResolvedValueOnce(null as any);
      vi.mocked(getParallelTierTrend).mockResolvedValueOnce(null as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "LongTail",
        parallelTierKey: { year: 2026, set: "Bowman Chrome", variant: "Blue X-Fractor" },
      });
      // Pure decay: -0.08/wk (week-3 bucket)
      expect(curve.signalSource).toBe("release-decay-only");
      expect(curve.ratePerWeek).toBeCloseTo(-0.08, 3);
    });

    it("does NOT apply decay when the set isn't in the release-date table (unknown product)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [{ price: 200, date: daysAgo(20) }] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.05, "P", /* useMatchedCohort */ true) as any,
      );
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", {
        playerName: "P",
        // Unknown set — not in RELEASE_DATES
        parallelTierKey: { year: 2026, set: "Some Custom Set", variant: "Refractor" },
      });
      // Pure matched-cohort — decay never fires
      expect(curve.signalSource).toBe("matched-cohort-cached");
      expect(curve.ratePerWeek).toBeCloseTo(0.05, 3);
    });
  });

  describe("CF-BIN-VS-AUCTION-WEIGHT — BIN sales lift the weighted median", () => {
    it("weighted median tilts UP when the BIN sales are the higher-priced ones", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      // Two auction sales at $100, two BIN sales at $200, all same age.
      // Recency alone would median around $150.
      // BIN weighting (×1.5) tips cumulative weight so median lands at $200.
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(2), sale_type: "auction" },
            { price: 100, date: daysAgo(2), sale_type: "auction" },
            { price: 200, date: daysAgo(2), sale_type: "buy it now" },
            { price: 200, date: daysAgo(2), sale_type: "buy it now" },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // BIN samples carry more weight → weighted median tips to the BIN price
      expect(raw.weightedMedianPrice).toBe(200);
    });

    it("null sale_type samples default to auction weight (no penalty)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      // All samples null sale_type → identical behavior to pre-CF
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(2), sale_type: null },
            { price: 150, date: daysAgo(2), sale_type: null },
            { price: 200, date: daysAgo(2), sale_type: null },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Equal weights → median is the middle sample
      expect(raw.weightedMedianPrice).toBe(150);
    });
  });

  describe("CF-USE-ACTUALS-NO-CAP — trajectory rate is NOT clipped", () => {
    it("passes through +20%/wk matched-cohort rate without clamping", async () => {
      // Pre-CF: rate would have been clipped to +10%/wk (RATE_CAP_PER_WEEK).
      // Post-CF: hot prospect rate flows through, so Predicted reflects
      // the actual matched-cohort signal.
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(28) },
            { price: 100, date: daysAgo(25) },
            { price: 100, date: daysAgo(22) },
          ] as any;
        }
        return [];
      });
      // Matched-cohort medianRatio = 1.20 → rate = +20%/wk
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.20, "HotProspect", /* useMatchedCohort */ true) as any,
      );
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "HotProspect" });
      expect(curve.ratePerWeek).toBeCloseTo(0.20, 2);
      // Predicted multiplier at 30d = 1 + 0.20 × 30/7 = 1.857
      // Applied to the market-value anchor (which is > $100 from trend)
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // If cap were still in place, ratePerWeek would be 0.10 (rate cap)
      // and Predicted would be materially lower.
      expect(raw.predictedPriceAt30d!).toBeGreaterThan(raw.value! * 1.5);
    });

    it("passes through -30%/wk matched-cohort rate without clamping (bearish)", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      const { getPlayerTrendSnapshot } = await import("../src/services/playerTrend/index.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 200, date: daysAgo(28) },
            { price: 200, date: daysAgo(25) },
            { price: 200, date: daysAgo(22) },
          ] as any;
        }
        return [];
      });
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(-0.30, "Cooling", /* useMatchedCohort */ true) as any,
      );
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Cooling" });
      expect(curve.ratePerWeek).toBeCloseTo(-0.30, 2);
    });
  });

  describe("CF-SALES-HISTORY-CHART — raw comp pool exposed for scatter render", () => {
    it("emits salesHistory ordered newest → oldest for iOS scatter", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(30), sale_type: "auction" },
            { price: 150, date: daysAgo(2),  sale_type: "buy it now" },
            { price: 120, date: daysAgo(15), sale_type: "auction" },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Newest first: 2d ago → 15d ago → 30d ago
      expect(raw.salesHistory.map((s) => s.price)).toEqual([150, 120, 100]);
      // saleType passes through
      expect(raw.salesHistory[0].saleType).toBe("buy it now");
      expect(raw.salesHistory[2].saleType).toBe("auction");
    });

    it("emits empty salesHistory for grades with no sales", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockResolvedValue([]);
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1");
      for (const e of curve.entries) {
        expect(e.salesHistory).toEqual([]);
      }
    });
  });

  describe("CF-REFERENCE-PRICE-CROSS-CHECK — divergence between our value and CH reference", () => {
    it("fires referenceAnomaly when our value diverges from reference by >25%", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      // Raw pool at $100 median; reference-price says $200 for Raw → +100% divergence
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [
            { price: 100, date: daysAgo(2) },
            { price: 100, date: daysAgo(3) },
            { price: 100, date: daysAgo(4) },
          ] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const referencePriceByGrade = new Map([["Raw", 200]]);
      const curve = await buildObservedGradeCurve("c1", { referencePriceByGrade });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.referencePrice).toBe(200);
      expect(raw.referenceDivergencePct).toBeCloseTo(-50, 1); // our $100 is 50% below reference $200
      expect(raw.referenceAnomaly).toBe(true);
    });

    it("does NOT fire anomaly when divergence is within 25%", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      // Raw at $100; reference $110 → +10% divergence (below anomaly threshold)
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") {
          return [{ price: 100, date: daysAgo(2) }] as any;
        }
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const referencePriceByGrade = new Map([["Raw", 110]]);
      const curve = await buildObservedGradeCurve("c1", { referencePriceByGrade });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.referencePrice).toBe(110);
      expect(raw.referenceDivergencePct).toBeCloseTo(-9.09, 1);
      expect(raw.referenceAnomaly).toBe(false);
    });

    it("emits nulls when no reference price is provided", async () => {
      const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
      vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
        if (grade === "Raw") return [{ price: 100, date: daysAgo(2) }] as any;
        return [];
      });
      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1"); // no referencePriceByGrade
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.referencePrice).toBeNull();
      expect(raw.referenceDivergencePct).toBeNull();
      expect(raw.referenceAnomaly).toBe(false);
    });
  });

  it("multi-grade aggregation covers every canonical grade in one build call", async () => {
    const { getCardSales } = await import("../src/services/compiq/cardhedge.client.js");
    vi.mocked(getCardSales).mockImplementation(async (_cardId, grade) => {
      // Different sample counts per grade to prove they're independently aggregated
      const counts: Record<string, number> = { Raw: 20, "PSA 10": 3, "PSA 9": 5, "BGS 9.5": 0, "SGC 10": 0, "CGC 10": 0 };
      const n = counts[grade] ?? 0;
      return Array.from({ length: n }, (_, i) => ({ price: 50 + i, date: daysAgo(2) })) as any;
    });
    const { buildObservedGradeCurve } = await import(
      "../src/services/compiq/observedGradeCurve.service.js"
    );
    const curve = await buildObservedGradeCurve("c1");
    expect(curve.totalSampleCount).toBe(28);
    expect(curve.entries.find((e) => e.grade === "Raw")!.sampleCount).toBe(20);
    expect(curve.entries.find((e) => e.grade === "PSA 10")!.sampleCount).toBe(3);
    expect(curve.entries.find((e) => e.grade === "PSA 9")!.sampleCount).toBe(5);
    expect(curve.entries.find((e) => e.grade === "BGS 9.5")!.sampleCount).toBe(0);
  });
});
