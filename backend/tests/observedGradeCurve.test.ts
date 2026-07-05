// CF-OBSERVED-GRADE-CURVE (2026-07-04) — pins HobbyIQ's own per-grade
// observed-sales aggregation. This is our engine's answer, computed
// from raw sales — vendor-agnostic aggregation with the fetch source
// isolated for future swap (CH /cards/comps → eBay Browse).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the CH client's getCardSales — the ONE swap point. Everything
// else in observedGradeCurve.service is vendor-neutral math.
// getSalesStatsByPlayer is mocked so the trajectory pass has a signal
// source; defaults to null → trajectory skips silently.
vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  getCardSales: vi.fn(),
  getSalesStatsByPlayer: vi.fn(async () => null),
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
    // Helper: 6 complete weekly buckets ending 0-7d ago, with a given
    // rate profile. Rate is applied so latest = prior_4wk_mean × (1+rate).
    function makeBuckets(rate: number) {
      const priorAvg = 100;
      const latestAvg = 100 * (1 + rate);
      const b = (endDaysAgo: number, avg: number) => ({
        start: new Date(FAKE_NOW.getTime() - (endDaysAgo + 7) * 24 * 3600 * 1000).toISOString(),
        end:   new Date(FAKE_NOW.getTime() - endDaysAgo * 24 * 3600 * 1000).toISOString(),
        count: 10, total_amount: avg * 10, average_sale: avg, partial: false,
      });
      return [
        b(35, priorAvg),
        b(28, priorAvg),
        b(21, priorAvg),
        b(14, priorAvg),
        b(7, priorAvg),  // 4-week prior window ends here
        b(0, latestAvg), // latest complete week
      ];
    }

    it("hot player: Market Value > value, Predicted > Market Value, all on one curve", async () => {
      const { getCardSales, getSalesStatsByPlayer } = await import(
        "../src/services/compiq/cardhedge.client.js"
      );
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
      // Rate = +8% weekly (capped at ±10%)
      vi.mocked(getSalesStatsByPlayer).mockResolvedValueOnce({
        interval: "week", periods: 6,
        results: [{ player: "Josh", buckets: makeBuckets(0.08) }],
      } as any);

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
      const { getCardSales, getSalesStatsByPlayer } = await import(
        "../src/services/compiq/cardhedge.client.js"
      );
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
      vi.mocked(getSalesStatsByPlayer).mockResolvedValueOnce({
        interval: "week", periods: 6,
        results: [{ player: "Cold", buckets: makeBuckets(-0.05) }],
      } as any);

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
      const { getCardSales, getSalesStatsByPlayer } = await import(
        "../src/services/compiq/cardhedge.client.js"
      );
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
      vi.mocked(getSalesStatsByPlayer).mockResolvedValueOnce({
        interval: "week", periods: 6,
        results: [{ player: "Hot", buckets: makeBuckets(0.10) }],
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Hot" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Capped at 6 weeks × 10%/wk = +60% → $160 (not 25.7 × 10% = 257%)
      expect(raw.trendAdjustedValue).toBeCloseTo(160, 0);
      expect(raw.trendAdjustmentPct).toBeCloseTo(60, 0);
    });

    it("fresh comp (<14d) skips trajectory — value is honest, no adjustment", async () => {
      const { getCardSales, getSalesStatsByPlayer } = await import(
        "../src/services/compiq/cardhedge.client.js"
      );
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
      vi.mocked(getSalesStatsByPlayer).mockResolvedValueOnce({
        interval: "week", periods: 6,
        results: [{ player: "Fresh", buckets: makeBuckets(0.10) }],
      } as any);

      const { buildObservedGradeCurve } = await import(
        "../src/services/compiq/observedGradeCurve.service.js"
      );
      const curve = await buildObservedGradeCurve("c1", { playerName: "Fresh" });
      const raw = curve.entries.find((e) => e.grade === "Raw")!;
      // Fresh — trajectory skips, all trajectory fields stay null
      expect(raw.value).toBe(100);
      expect(raw.trendAdjustedValue).toBeNull();
      expect(raw.predictedPriceAt30d).toBeNull();
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
