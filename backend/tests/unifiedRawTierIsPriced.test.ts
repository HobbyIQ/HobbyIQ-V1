// CF-RAW-IS-A-TIER (D4 "one valuation path", PR 4 — 2026-08-29).
//
// Every portfolio / fmv caller passes `grade: gCo ? { company, value } : null`,
// so a raw holding reached computeUnifiedPrice as `grade: null` — and the
// top-level fill was gated on `opts.grade?.company`, so it priced nothing:
// raw holdings fell through to the legacy engine while their graded siblings
// took the unified early exit. Two valuation paths, split by whether the card
// was slabbed. The raw pool is an exact-identity pool like any other tier.
//
// The distinction that must survive: `grade: undefined` is a curve-only call
// (the card page) and still prices nothing at the top level.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The stub honours the query's @cutoff so the window cascade is real: a
// 60d query sees only sales newer than 60 days, as Cosmos would return.
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
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
const sale = (price: number, d: number, grade: { c: string; v: number } | null) => ({
  price,
  soldAt: daysAgo(d),
  gradeCompany: grade?.c ?? null,
  gradeValue: grade?.v ?? null,
});
const RAW_POOL = Array.from({ length: 10 }, (_, i) => sale(40 + i, 30 - i * 3, null));
const PSA10_POOL = Array.from({ length: 10 }, (_, i) => sale(400 + i * 10, 30 - i * 3, { c: "PSA", v: 10 }));

beforeEach(() => { h.rows = []; });

describe("computeUnifiedPrice — the Raw tier is priced at the top level", () => {
  it("grade: null with a raw pool prices from the Raw tier, an exact-pool rung", async () => {
    h.rows = [...RAW_POOL, ...PSA10_POOL];
    const u = await computeUnifiedPrice("card-raw", { grade: null });
    const raw = u.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(u.marketValue).toBe(raw.marketValue);
    expect(u.predictedPrice).toBe(raw.predictedPrice);
    expect(u.fmv).toBe(raw.weightedMedian);
    expect(u.rungLabel).toBe(raw.rungLabel);
    expect(u.rungLabel).toMatch(/^exact-pool-/);
    // Not the graded pool — a raw card is not priced off its PSA 10 sales.
    expect(u.marketValue).toBeLessThan(u.gradeCurve.find((e) => e.grade === "PSA 10")!.marketValue as number);
  });

  it("a grade with no company means the same thing as null: Raw", async () => {
    h.rows = [...RAW_POOL];
    const u = await computeUnifiedPrice("card-raw", { grade: { company: null, value: null } });
    expect(u.marketValue).not.toBeNull();
    expect(u.rungLabel).toMatch(/^exact-pool-/);
  });

  it("grade: undefined is still a curve-only call — nothing priced at the top level", async () => {
    h.rows = [...RAW_POOL, ...PSA10_POOL];
    const u = await computeUnifiedPrice("card-curve");
    expect(u.gradeCurve.length).toBe(2);
    expect(u.fmv).toBeNull();
    expect(u.marketValue).toBeNull();
    expect(u.rungLabel).toBe("no-basis");
  });

  it("the density cascade measures the Raw tier when Raw is requested", async () => {
    // Raw sales are all older than 60d; the 60d window has 5+ PSA 10 sales
    // but zero Raw — a raw request must widen past it, not stop there.
    h.rows = [
      ...Array.from({ length: 6 }, (_, i) => sale(40 + i, 80 - i * 3, null)),
      ...Array.from({ length: 6 }, (_, i) => sale(400 + i, 10 - i, { c: "PSA", v: 10 })),
    ];
    const u = await computeUnifiedPrice("card-old-raw", { grade: null });
    expect(u.windowDays).toBeGreaterThan(60);
    expect(u.rungLabel).toMatch(/^exact-pool-/);
  });

  it("a raw request with no raw pool is a cross-grade fallback, divided back out of the graded premium", async () => {
    h.rows = [...PSA10_POOL];
    const u = await computeUnifiedPrice("card-no-raw", { grade: null, cardYear: 2024 });
    const psa10 = u.gradeCurve.find((e) => e.grade === "PSA 10")!;
    expect(u.rungLabel).toBe("cross-grade-fallback");
    expect(u.marketValue).not.toBeNull();
    // Symmetric with the graded direction: the PSA 10 pool rescaled DOWN to
    // raw, never handed over as-is.
    expect(u.marketValue as number).toBeLessThan(psa10.marketValue as number);
  });

  it("the graded direction is unchanged: a PSA 10 request with only raw sales is rescaled UP and labelled cross-grade", async () => {
    h.rows = [...RAW_POOL];
    const u = await computeUnifiedPrice("card-e", { grade: { company: "PSA", value: 10 }, cardYear: 2024 });
    const raw = u.gradeCurve.find((e) => e.grade === "Raw")!;
    expect(u.rungLabel).toBe("cross-grade-fallback");
    expect(u.marketValue as number).toBeGreaterThan(raw.marketValue as number);
  });
});
