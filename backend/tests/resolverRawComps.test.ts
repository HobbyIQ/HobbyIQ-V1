// CF-RESOLVER-RAW-COMPS (Drew, 2026-07-13) — verifies the Cardsight vendor
// source emits per-record raw + graded sales through the resolver, so
// downstream engine paths (graded projection, prediction, market read) can
// operate on real data instead of vendor-derived aggregates.
//
// Guards the vendor-agnostic engine layer contract:
//   - vendor plugins produce the atomic sales records
//   - engine consumes pooled records + does its own math
//   - vendor-derived FMV / prediction / confidence is NEVER read downstream

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cardsightVendorSource } from "../src/services/compiq/cardsightVendorSource.js";
import * as slim from "../src/services/compiq/cardsightSlim.client.js";

const FAKE_HIT = {
  id: "cs-abc",
  name: "Eric Hartman",
  player: "Eric Hartman",
  year: "2026",
  setName: "2026 Bowman Baseball",
  number: "CPA-EHA",
  variant: "Blue Refractor",
};

function stubConfigured() {
  vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
}
function stubSearch(hits: any[]) {
  vi.spyOn(slim, "searchCatalog").mockResolvedValue(hits as any);
}
function stubPricing(pricing: any) {
  vi.spyOn(slim, "getPricing").mockResolvedValue(pricing as any);
}
function stubDetail(parallels: any[] | null) {
  vi.spyOn(slim, "getCardDetail").mockResolvedValue(
    parallels === null ? null : ({ id: "cs-abc", parallels } as any),
  );
}

const baseQuery = {
  playerName: "Eric Hartman",
  cardYear: 2026,
  setName: "2026 Bowman Baseball",
  cardNumber: "CPA-EHA",
} as const;

beforeEach(() => {
  stubConfigured();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cardsightVendorSource — per-record raw + graded comps", () => {
  it("emits every raw sale as a ResolverComp", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: {
        count: 3,
        records: [
          { price: 100, date: "2026-07-01" },
          { price: 120, date: "2026-07-02" },
          { price: 90, date: "2026-06-30" },
        ],
      },
      graded: [],
      meta: { total_records: 3, last_sale_date: "2026-07-02" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res).not.toBeNull();
    expect(res!.rawComps).toHaveLength(3);
    expect(res!.rawComps![0]).toEqual({ saleDate: "2026-07-01", price: 100 });
    expect(res!.rawComps![1]).toEqual({ saleDate: "2026-07-02", price: 120 });
    expect(res!.gradedComps).toHaveLength(0);
  });

  it("emits one graded ResolverComp per sale record (NOT per grade bucket)", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              count: 2,
              records: [
                { price: 500, date: "2026-07-05" },
                { price: 550, date: "2026-07-06" },
              ],
            },
            {
              grade_value: "9",
              count: 1,
              records: [{ price: 300, date: "2026-07-04" }],
            },
          ],
        },
      ],
      meta: { total_records: 3, last_sale_date: "2026-07-06" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res).not.toBeNull();
    expect(res!.gradedComps).toHaveLength(3);
    const psa10 = res!.gradedComps!.filter(
      (c) => c.gradeCompany === "PSA" && c.gradeValue === 10,
    );
    const psa9 = res!.gradedComps!.filter(
      (c) => c.gradeCompany === "PSA" && c.gradeValue === 9,
    );
    expect(psa10).toHaveLength(2);
    expect(psa9).toHaveLength(1);
    expect(psa10[0].price).toBe(500);
  });

  it("normalizes grade company casing/variants to canonical uppercase", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "psa",
          grades: [{ grade_value: "10", count: 1, records: [{ price: 100, date: "2026-07-01" }] }],
        },
        {
          company_name: "Beckett",
          grades: [{ grade_value: "9.5", count: 1, records: [{ price: 80, date: "2026-07-02" }] }],
        },
        {
          company_name: "SGC",
          grades: [{ grade_value: "10", count: 1, records: [{ price: 70, date: "2026-07-03" }] }],
        },
      ],
      meta: { total_records: 3, last_sale_date: "2026-07-03" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    const companies = new Set(res!.gradedComps!.map((c) => c.gradeCompany));
    expect(companies.has("PSA")).toBe(true);
    expect(companies.has("BGS")).toBe(true);   // "Beckett" → "BGS"
    expect(companies.has("SGC")).toBe(true);
  });

  it("drops records with non-positive prices (defensive boundary)", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: {
        count: 4,
        records: [
          { price: 100, date: "2026-07-01" },
          { price: 0, date: "2026-07-02" },       // dropped
          { price: -50, date: "2026-07-03" },     // dropped
          { price: 90, date: "2026-07-04" },
        ],
      },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              count: 2,
              records: [
                { price: 500, date: "2026-07-05" },
                { price: 0, date: "2026-07-06" },   // dropped
              ],
            },
          ],
        },
      ],
      meta: { total_records: 6, last_sale_date: "2026-07-06" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res!.rawComps).toHaveLength(2);
    expect(res!.gradedComps).toHaveLength(1);
  });

  it("drops graded records with unrecognized company (no engine ?-tier)", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "TAG",   // unrecognized
          grades: [{ grade_value: "10", count: 1, records: [{ price: 100, date: "2026-07-01" }] }],
        },
        {
          company_name: "PSA",
          grades: [{ grade_value: "10", count: 1, records: [{ price: 200, date: "2026-07-01" }] }],
        },
      ],
      meta: { total_records: 2, last_sale_date: "2026-07-01" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res!.gradedComps).toHaveLength(1);
    expect(res!.gradedComps![0].gradeCompany).toBe("PSA");
  });

  it("drops graded records where grade_value can't parse to a positive number", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", count: 1, records: [{ price: 500, date: "2026-07-01" }] },
            { grade_value: "invalid", count: 1, records: [{ price: 400, date: "2026-07-02" }] },
            { grade_value: "-2", count: 1, records: [{ price: 300, date: "2026-07-03" }] },
          ],
        },
      ],
      meta: { total_records: 3, last_sale_date: "2026-07-03" },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res!.gradedComps).toHaveLength(1);
    expect(res!.gradedComps![0].gradeValue).toBe(10);
  });

  it("returns empty arrays (not undefined) when Cardsight has no pricing", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res!.rawComps).toEqual([]);
    expect(res!.gradedComps).toEqual([]);
  });

  it("emits empty arrays (not vendor records) when notFound", async () => {
    stubSearch([FAKE_HIT]);
    stubPricing({
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
      notFound: true,
    });
    const res = await cardsightVendorSource.resolveCard(baseQuery);
    expect(res!.rawComps).toEqual([]);
    expect(res!.gradedComps).toEqual([]);
  });
});
