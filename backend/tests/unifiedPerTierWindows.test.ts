// CF-ONE-VALUATION-PATH (D16, 2026-08-30) — per-tier windows in the unified
// engine.
//
// The D14 probe found the grade curve and hobbyiq-fmv reading ONE exact pool
// to two numbers: the curve's overlay asked the engine for a fixed 180d
// window while the headline asked for the density cascade (60 → 90 → 180 on
// the requested tier). `perTierWindows` runs that same cascade for EVERY tier
// from one 180d read, so a tier's curve entry is the number that tier gets as
// a headline — by construction, which is what these tests pin.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The stub honours @cutoff so the cascade is real: a 60d query sees only
// sales newer than 60 days, as Cosmos would return.
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, queries: [] as number[] }));
vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: (spec: { parameters?: Array<{ name: string; value: unknown }> }) => ({
              fetchAll: async () => {
                const cutoff = spec?.parameters?.find((p) => p.name === "@cutoff")?.value;
                h.queries.push(typeof cutoff === "string" ? Math.round((Date.now() - Date.parse(cutoff)) / 86_400_000) : -1);
                const rows = typeof cutoff === "string"
                  ? h.rows.filter((r) => String(r.soldAt) >= cutoff)
                  : h.rows;
                return { resources: rows };
              },
            }),
          },
        }),
      };
    }
  }
  return { CosmosClient };
});
process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://unit.test/;AccountKey=dW5pdA==;";

import { computeUnifiedPrice } from "../src/services/compiq/unifiedPricing.service.js";

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sale = (price: number, d: number, grade: { c: string; v: number } | null, extra: Record<string, unknown> = {}) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null,
  gradeValue: grade?.v ?? null,
  source: "tca-ebay",
  ...extra,
});
// A dense PSA 10 (8 sales in the last 30d) beside a sparse Raw (3 sales,
// 70-120 days old) and a PSA 9 that only reaches the cascade's floor at 90d.
const PSA10_DENSE = Array.from({ length: 8 }, (_, i) => sale(400 + i * 5, 28 - i * 3, { c: "PSA", v: 10 }));
const RAW_SPARSE = [sale(40, 70, null), sale(44, 95, null), sale(42, 120, null)];
const PSA9_MID = Array.from({ length: 5 }, (_, i) => sale(200 + i, 85 - i * 4, { c: "PSA", v: 9 }));

beforeEach(() => { h.rows = []; h.queries = []; });

describe("computeUnifiedPrice — perTierWindows", () => {
  it("one 180d read; each tier at the window the cascade would have chosen for it", async () => {
    h.rows = [...PSA10_DENSE, ...RAW_SPARSE, ...PSA9_MID];
    const u = await computeUnifiedPrice("card-x", { hobbyiqCardId: "hiq:x", perTierWindows: true });
    expect(h.queries).toEqual([180]);
    const tier = (g: string) => u.gradeCurve.find((e) => e.grade === g)!;
    // PSA 10 has 8 sales inside 60d -> priced from them (the regression rung).
    expect(tier("PSA 10").sampleCount).toBe(8);
    expect(tier("PSA 10").rungLabel).toBe("exact-pool-projection");
    // Raw never reaches 5 in 60 / 90 and has 3 at 180 -> all three, at 180d.
    expect(tier("Raw").sampleCount).toBe(3);
    expect(tier("Raw").rungLabel).toBe("exact-pool-weighted-median");
    // PSA 9 has 5 sales inside 90d and fewer inside 60d -> the 90d rows.
    expect(tier("PSA 9").sampleCount).toBe(5);
  });

  it("the requested tier's headline equals its curve entry — for Raw and for PSA 10 — and the cascade's own answer", async () => {
    h.rows = [...PSA10_DENSE, ...RAW_SPARSE, ...PSA9_MID];
    for (const grade of [null, { company: "PSA", value: 10 }, { company: "PSA", value: 9 }]) {
      const label = grade ? `${grade.company} ${grade.value}` : "Raw";
      const perTier = await computeUnifiedPrice("card-x", { hobbyiqCardId: "hiq:x", grade, perTierWindows: true });
      const cascade = await computeUnifiedPrice("card-x", { hobbyiqCardId: "hiq:x", grade });
      const entry = perTier.gradeCurve.find((e) => e.grade === label)!;
      // headline(T) == curve[T]
      expect(perTier.marketValue).toBe(entry.marketValue);
      expect(perTier.predictedPrice).toBe(entry.predictedPrice);
      expect(perTier.fmv).toBe(entry.weightedMedian);
      expect(perTier.rungLabel).toBe(entry.rungLabel);
      // ... and both equal what the cascade gives the same tier as a headline.
      expect(perTier.marketValue).toBe(cascade.marketValue);
      expect(perTier.windowDays).toBe(cascade.windowDays);
      expect(perTier.rungLabel).toBe(cascade.rungLabel);
      expect(perTier.totalSampleCount).toBe(cascade.totalSampleCount);
    }
  });

  it("the cascade still runs its sequential queries when perTierWindows is off (unchanged)", async () => {
    h.rows = [...RAW_SPARSE];
    const u = await computeUnifiedPrice("card-x", { grade: null });
    expect(h.queries).toEqual([60, 90, 180]);
    expect(u.windowDays).toBe(180);
  });

  it("the self-comp rule is applied per window, as the cascade applied it per query", async () => {
    // 4 raw sales in 60d, one of them the user's own; 3 others -> the rule
    // drops the self-comp at 60d (others >= 3). At 180d there are 5 others.
    h.rows = [
      sale(50, 5, null, { contributorUserId: "u1" }),
      sale(52, 10, null), sale(48, 20, null), sale(51, 30, null),
      sale(47, 100, null), sale(49, 150, null),
    ];
    const perTier = await computeUnifiedPrice("card-x", { grade: null, perTierWindows: true, excludeContributorUserId: "u1" });
    const cascade = await computeUnifiedPrice("card-x", { grade: null, excludeContributorUserId: "u1" });
    expect(perTier.windowDays).toBe(cascade.windowDays);
    expect(perTier.totalSampleCount).toBe(cascade.totalSampleCount);
    expect(perTier.marketValue).toBe(cascade.marketValue);
    const raw = perTier.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(raw.sales!.some((s) => s.price === 50)).toBe(false);
  });

  it("each tier carries its own sales, newest first, so a wire's comp list is the rows that priced it", async () => {
    h.rows = [...PSA10_DENSE, ...RAW_SPARSE];
    const u = await computeUnifiedPrice("card-x", { perTierWindows: true });
    const raw = u.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(raw.sales!.map((s) => s.price)).toEqual([40, 44, 42]);
    expect(raw.sales![0].source).toBe("tca-ebay");
    const psa10 = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(psa10.sales!.length).toBe(8);
    expect(Date.parse(psa10.sales![0].soldAt)).toBeGreaterThan(Date.parse(psa10.sales![7].soldAt));
  });
});
