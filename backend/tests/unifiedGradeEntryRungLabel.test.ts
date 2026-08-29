// CF-RUNG-LABEL (D4 "one valuation path", PR 1 — 2026-08-29).
//
// computeTrendAndPrediction already had three distinct branches — a
// regression fit over the exact pool, the median of the newest three sales,
// and the recency-weighted median as a last resort — and nothing named which
// one produced the number. The label is written by the branch that returned,
// so a consumer reads it; it never parses "median" out of a basis note.
//
// The top-level label is the matched tier's own, EXCEPT when the requested
// grade had no pool entry and the answer was rescaled off another grade's
// pool (CF-UNIFIED-GRADE-FALLBACK-CHAIN). Real sales, wrong grade: that is a
// fallback rung, and the digest must not treat it as the exact pool.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The service reaches Cosmos through `new CosmosClient(conn).database().
// container().items.query().fetchAll()`. Stub exactly that chain and feed
// whatever rows the test sets. The service filters/dedupes in code, so the
// query text is irrelevant here.
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@azure/cosmos", () => {
  class CosmosClient {
    constructor(_conn: unknown) {}
    database() {
      return {
        container: () => ({
          items: {
            query: () => ({ fetchAll: async () => ({ resources: h.rows }) }),
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
const sale = (price: number, d: number, grade: { c: string; v: number } | null = { c: "PSA", v: 10 }) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null,
  gradeValue: grade?.v ?? null,
});
const PSA10 = { company: "PSA", value: 10 };

beforeEach(() => { h.rows = []; });

describe("UnifiedGradeEntry.rungLabel — the branch that produced the tier's number", () => {
  it("two sales: too thin for anything but the weighted median", async () => {
    h.rows = [sale(100, 3), sale(110, 9)];
    const u = await computeUnifiedPrice("card-a", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.rungLabel).toBe("exact-pool-weighted-median");
    expect(u.rungLabel).toBe("exact-pool-weighted-median");
    expect(u.fmv).not.toBeNull();
  });

  it("five recent sales: the leading edge (median of the newest three)", async () => {
    // 4 <= n < 8 skips the fit; all within 14d means no prior window, so the
    // leading edge stands alone.
    h.rows = [sale(100, 1), sale(104, 2), sale(98, 3), sale(101, 4), sale(97, 5)];
    const u = await computeUnifiedPrice("card-b", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.rungLabel).toBe("exact-pool-leading-edge");
    expect(u.rungLabel).toBe("exact-pool-leading-edge");
  });

  it("ten dated sales: the regression fit — the doctrine rung", async () => {
    h.rows = Array.from({ length: 10 }, (_, i) => sale(100 + i * 2, 40 - i * 4));
    const u = await computeUnifiedPrice("card-c", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.rungLabel).toBe("exact-pool-projection");
    expect(u.rungLabel).toBe("exact-pool-projection");
  });

  it("every tier of the curve carries an exact-pool label — the curve IS per-grade exact pools", async () => {
    h.rows = [
      ...Array.from({ length: 10 }, (_, i) => sale(200 + i, 30 - i * 3)),
      sale(50, 2, null), sale(52, 5, null), sale(49, 8, null), sale(51, 11, null),
      sale(80, 4, { c: "PSA", v: 9 }),
    ];
    const u = await computeUnifiedPrice("card-d");
    expect(u.gradeCurve.length).toBe(3);
    for (const e of u.gradeCurve) {
      expect(e.rungLabel, e.grade).toMatch(/^exact-pool-/);
    }
    // A curve-only call (no grade requested) prices nothing at the top level.
    expect(u.fmv).toBeNull();
    expect(u.rungLabel).toBe("no-basis");
  });
});

describe("UnifiedPriceResult.rungLabel — the top-level number's rung", () => {
  it("a grade with no pool entry, rescaled off another grade, is labelled cross-grade-fallback, not exact-pool", async () => {
    // Only Raw sales in the pool; PSA 10 requested. CF-UNIFIED-GRADE-
    // FALLBACK-CHAIN returns the Raw pool rescaled by a grader premium. That
    // is a real number and the right thing to show — but it is not the
    // exact (identity, grade) pool, and the label says so.
    h.rows = Array.from({ length: 10 }, (_, i) => sale(40 + i, 30 - i * 3, null));
    const u = await computeUnifiedPrice("card-e", { grade: PSA10 });
    expect(u.fmv).not.toBeNull();
    expect(u.rungLabel).toBe("cross-grade-fallback");
    // The Raw tier itself is still, correctly, an exact-pool rung.
    expect(u.gradeCurve.find((e) => e.grade === "Raw")!.rungLabel).toBe("exact-pool-projection");
  });

  it("an empty pool is no-basis, with no number", async () => {
    h.rows = [];
    const u = await computeUnifiedPrice("card-f", { grade: PSA10 });
    expect(u.method).toBe("no-basis");
    expect(u.fmv).toBeNull();
    expect(u.rungLabel).toBe("no-basis");
  });
});
