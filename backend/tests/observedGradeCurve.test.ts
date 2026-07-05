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

// Deterministic "now" so recency-based confidence tests are stable.
const FAKE_NOW = new Date("2026-07-04T12:00:00.000Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
});

function daysAgo(n: number): string {
  return new Date(FAKE_NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
}

describe("CF-OBSERVED-GRADE-CURVE — buildObservedGradeCurve", () => {
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
    // Canonical grades: Raw + top-tier (PSA 10, BGS 10 Pristine, BGS 9.5,
    // SGC 10, CGC 10) + 9-tier (PSA 9, BGS 9, SGC 9, CGC 9) = 10 grades.
    expect(curve.entries).toHaveLength(10);
    const grades = curve.entries.map((e) => e.grade);
    expect(grades).toEqual([
      "Raw",
      "PSA 10",
      "PSA 9",
      "BGS 10",
      "BGS 9.5",
      "BGS 9",
      "SGC 10",
      "SGC 9",
      "CGC 10",
      "CGC 9",
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

    // Bins: 1→0.20, 2→0.35, 4→0.50, 9→0.70, 19→0.85, 20→1.00
    expect(await confidenceForN(1)).toBeCloseTo(0.20, 2);
    expect(await confidenceForN(3)).toBeCloseTo(0.50, 2);
    expect(await confidenceForN(5)).toBeCloseTo(0.70, 2);
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
    // Base for n=5 is 0.70; dampened by 0.7 → 0.49
    expect(raw.confidenceScore).toBeCloseTo(0.49, 2);
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

    it("Raw observed + PSA10 empty → PSA10 fills as estimated Raw×8", async () => {
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

    it("CF-BETTER-ESTIMATED-GRADE-MATH: reference-price is preferred over Raw × multiplier when caller provides it", async () => {
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

    it("CF-BETTER-ESTIMATED-GRADE-MATH: Raw × multiplier is used when no reference-price map is provided", async () => {
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

    it("BGS 10 Pristine estimates at Raw×20 (rarest tier gets highest multiplier)", async () => {
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

    it("all four 9-tier grades (PSA/BGS/SGC/CGC) fall back to Raw×3", async () => {
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
      // Predicted 30d = Market Value × (1 + 0.08 × 30/7) — same rate applied
      // for +34.29% more, so Predicted > Market Value
      expect(raw.predictedPriceAt30d).toBeGreaterThan(raw.trendAdjustedValue!);
      expect(raw.predictedPricePct).toBeCloseTo(34.29, 0);
      // Ranges are ±15% around predictedPriceAt30d
      expect(raw.predictedPriceRangeLow).toBeCloseTo(raw.predictedPriceAt30d! * 0.85, 1);
      expect(raw.predictedPriceRangeHigh).toBeCloseTo(raw.predictedPriceAt30d! * 1.15, 1);
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
      // Fresh — Market Value stays observed (trendAdjustedValue null),
      // but Predicted STILL projects forward 30d off the observed value.
      expect(raw.value).toBe(100);
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.trendAdjustmentPct).toBeNull();
      // Predicted = 100 × (1 + 0.10 × 30/7) = 100 × 1.428 = 142.86
      expect(raw.predictedPriceAt30d).toBeCloseTo(142.86, 1);
      expect(raw.predictedPricePct).toBeCloseTo(42.86, 1);
      // Range is ±15% around Predicted
      expect(raw.predictedPriceRangeLow).toBeCloseTo(142.86 * 0.85, 1);
      expect(raw.predictedPriceRangeHigh).toBeCloseTo(142.86 * 1.15, 1);
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

    it("CF-MATCHED-COHORT: falls back to raw momentumRatio when matched-cohort is null", async () => {
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
      // No matched-cohort cached; raw momentum says +8%
      vi.mocked(getPlayerTrendSnapshot).mockResolvedValueOnce(
        makeSnapshot(0.08, "NoCohort", /* useMatchedCohort */ false) as any,
      );

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "NoCohort" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      expect(raw.trendAdjustmentPct).toBeGreaterThan(30);
      expect(raw.trendAdjustmentPct).toBeLessThan(40);
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
