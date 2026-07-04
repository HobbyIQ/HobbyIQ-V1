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
