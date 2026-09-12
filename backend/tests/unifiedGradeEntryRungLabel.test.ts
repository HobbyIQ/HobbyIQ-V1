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
  it("two sales: RULING R25 — too few for a trend, the most recent sale IS the market", async () => {
    h.rows = [sale(100, 3), sale(110, 9)];
    const u = await computeUnifiedPrice("card-a", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.rungLabel).toBe("exact-pool-last-sale");
    expect(u.rungLabel).toBe("exact-pool-last-sale");
    expect(tier.marketValue).toBe(100);
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

describe("RULING R25 (Drew, 2026-09-12) — 2 or 3 sales is too few for a trend, the most recent sale IS the market", () => {
  it("(a) a 2-sale pool: most recent sale, rung exact-pool-last-sale, low confidence", async () => {
    h.rows = [sale(40, 30), sale(60, 5)];
    const u = await computeUnifiedPrice("card-r25-2", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.sampleCount).toBe(2);
    expect(tier.rungLabel).toBe("exact-pool-last-sale");
    expect(u.rungLabel).toBe("exact-pool-last-sale");
    // Most recent sale (5d ago, $60) stands — not the median/mean of $40+$60.
    expect(tier.marketValue).toBe(60);
    expect(tier.predictedPrice).toBe(60);
    // Low confidence: computeConfidence-shaped tiering grades n=2 below n=3.
    expect(tier.confidence).toBeGreaterThan(0);
    expect(tier.confidence).toBeLessThan(0.5);
  });

  it("(b) a 3-sale pool with a clear median != last sale: the last sale wins, not the median", async () => {
    // Sorted by price: 20, 50, 100 -> plain median is 50. Newest by date is
    // the $20 sale (3 days ago). R25 says the newest sale stands even though
    // it is nowhere near the pool's median — there is no trend to read at
    // n=3, so the median is not a legitimate alternative answer.
    h.rows = [sale(100, 40), sale(50, 20), sale(20, 3)];
    const u = await computeUnifiedPrice("card-r25-3", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.sampleCount).toBe(3);
    expect(tier.plainMedian).toBe(50);
    expect(tier.rungLabel).toBe("exact-pool-last-sale");
    expect(tier.marketValue).toBe(20);
    expect(tier.marketValue).not.toBe(tier.plainMedian);
    expect(u.rungLabel).toBe("exact-pool-last-sale");
  });

  it("(c) n >= 4 is unchanged: the projection/leading-edge rungs still fire exactly as before R25", async () => {
    // 5 sales, all within days of each other -> leading edge (unaffected by
    // R25, which only narrows the n < 4 thin rung).
    h.rows = [sale(100, 1), sale(104, 2), sale(98, 3), sale(101, 4), sale(97, 5)];
    const u = await computeUnifiedPrice("card-r25-4", { grade: PSA10 });
    const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier.sampleCount).toBe(5);
    expect(tier.rungLabel).toBe("exact-pool-leading-edge");
    // 10 dated sales -> the regression/projection doctrine rung.
    h.rows = Array.from({ length: 10 }, (_, i) => sale(100 + i * 2, 40 - i * 4));
    const u2 = await computeUnifiedPrice("card-r25-10", { grade: PSA10 });
    const tier2 = u2.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(tier2.sampleCount).toBe(10);
    expect(tier2.rungLabel).toBe("exact-pool-projection");
  });

  it("(d) no dated 2/3-sale pool can emit exact-pool-weighted-median any more", async () => {
    const twoOrThreeSalePools = [
      [sale(40, 30), sale(60, 5)],
      [sale(40, 30), sale(60, 5), sale(50, 15)],
      [sale(0.15, 60), sale(0.88, 12)],
      [sale(729, 10), sale(250, 148)],
    ];
    for (const rows of twoOrThreeSalePools) {
      h.rows = rows;
      const u = await computeUnifiedPrice(`card-r25-grep-${rows.length}-${rows[0].price}`, { grade: PSA10 });
      const tier = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
      expect(tier.rungLabel, JSON.stringify(rows)).not.toBe("exact-pool-weighted-median");
      expect(tier.rungLabel, JSON.stringify(rows)).toBe("exact-pool-last-sale");
    }
  });

  // (e) The Chipper Jones shape: Drew's live case. A 3-sale RAW pool where
  // one row is a PSA 9 sale mislabelled into the raw tier by a since-fixed
  // grading bug (CF-A-GRADED-SALE-NEVER-ENTERS-THE-RAW-TIER) would have
  // dragged a weighted median up toward $40; the fix for THAT bug keeps a
  // graded row out of the raw tier entirely (a graded sale never enters the
  // raw tier), and R25 additionally guarantees that even if a contaminant
  // reached the pool, the raw FMV would be the raw tier's own most recent
  // sale — never an average across the 3. Modeled here as the raw tier
  // reading only its own (correctly excluded) rows: $20 own-purchase raw,
  // and $2-5 commons, newest first.
  it("(e) Chipper Jones shape: 3-sale raw pool ($20 own-purchase + 2 commons) prices to the most recent raw sale, not a $2 average", async () => {
    h.rows = [
      sale(20, 30, null),  // own purchase, raw, oldest
      sale(5, 15, null),   // common raw sale
      sale(2, 3, null),    // common raw sale, most recent
    ];
    const u = await computeUnifiedPrice("card-chipper-raw", { grade: null });
    const tier = u.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(tier.sampleCount).toBe(3);
    expect(tier.rungLabel).toBe("exact-pool-last-sale");
    // Expected raw FMV = the most recent raw sale ($2, 3d ago) — not a
    // $2/$5/$20 blend, and specifically not a number a mislabelled PSA-9
    // sale could have dragged upward the way the live Chipper bug did.
    expect(tier.marketValue).toBe(2);
    expect(u.marketValue).toBe(2);
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
