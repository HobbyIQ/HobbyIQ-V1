// CF-CARDSIGHT-UUID-NATIVE (Drew, 2026-07-13, PR #412) — verifies the
// Cardsight-direct UUID routing. Both surfaces:
//   - dispatcher.dispatchSearch: merges Cardsight-native hits (UUID +
//     full parallels[]) with CH-routed hits
//   - /api/compiq/price-by-id: UUID cardIds route to Cardsight-direct
//     pricing (real records + engine math), bypassing CH's garbage
//     echo for unknown UUIDs
//
// The pattern iOS depends on: pick a parallel from the picker, hit
// /price-by-id with cardId + parallelId, see the Cardsight-direct
// pricing for that specific variant.

import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import { priceByCardsightUuid } from "../src/services/compiq/cardsightUuidPriceRouter.js";
import * as slim from "../src/services/compiq/cardsightSlim.client.js";

const HARTMAN_HIT = {
  id: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
  name: "Eric Hartman",
  number: "CPA-EHA",
  releaseName: "Bowman",
  setName: "Chrome Prospects Autographs",
  year: 2026,
};

const HARTMAN_DETAIL = {
  id: "befe9bcc-e7e8-458c-9cd8-ce831848b9a1",
  name: "Eric Hartman",
  number: "CPA-EHA",
  releaseName: "Bowman",
  setName: "Chrome Prospects Autographs",
  year: 2026,
  parallels: [
    { id: "334908f4-bf5f-4ed5-98c7-75113561ab55", name: "Blue Refractor", numberedTo: 150 },
    { id: "b83de312-609d-4d58-af41-c8766a81835f", name: "Blue X-Fractor", numberedTo: 150 },
    { id: "8d2a3915-56b7-49a1-9851-86d9b1342152", name: "Speckle Refractor", numberedTo: 299 },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchCardsightUuidNativeCandidates", () => {
  // CF-EXPLODE-CARDSIGHT-PARALLELS (Drew, 2026-07-13, PR #413): each
  // parent now explodes into N candidates (one per parallel). The
  // per-parallel emission is exhaustively tested in
  // explodeCardsightParallels.test.ts; this test guards the parent-to-
  // multiple-candidates contract at the top of the pipeline.
  it("emits N candidates per parent card (one per parallel)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([HARTMAN_HIT] as any);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    expect(candidates).toHaveLength(3);   // HARTMAN_DETAIL has 3 parallels
    expect(candidates.every((c) => c.player === "Eric Hartman")).toBe(true);
    expect(candidates.every((c) => c.cardNumber === "CPA-EHA")).toBe(true);
    expect(candidates.every((c) => c.isAuto === true)).toBe(true);
    const names = candidates.map((c) => c.parallel).sort();
    expect(names).toContain("Blue Refractor");
    expect(names).toContain("Blue X-Fractor");
  });

  it("no-ops when Cardsight is unconfigured (graceful)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(false);
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    expect(candidates).toEqual([]);
  });

  it("returns empty on search error (never throws)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockRejectedValue(new Error("network"));
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    expect(candidates).toEqual([]);
  });

  it("skips hits whose detail fails (still explodes the parents that succeed)", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "searchCatalog").mockResolvedValue([
      HARTMAN_HIT,
      { ...HARTMAN_HIT, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    ] as any);
    const getDetailSpy = vi.spyOn(slim, "getCardDetail");
    getDetailSpy.mockImplementation(async (id: string) => {
      if (id === HARTMAN_HIT.id) return HARTMAN_DETAIL as any;
      return null;
    });
    const candidates = await fetchCardsightUuidNativeCandidates("eric hartman");
    // 3 parallels from HARTMAN_HIT, 0 from the failed detail
    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.candidateId.startsWith("cardsight:befe9bcc-"))).toBe(true);
  });
});

describe("priceByCardsightUuid — raw-pool median from real records", () => {
  const rawPricing = {
    raw: {
      count: 5,
      records: [
        { price: 140, date: "2026-07-01" },
        { price: 150, date: "2026-07-05" },
        { price: 160, date: "2026-07-08" },
        { price: 145, date: "2026-07-03" },
        { price: 155, date: "2026-07-06" },
      ],
    },
    graded: [],
    meta: { total_records: 5, last_sale_date: "2026-07-08" },
  };

  it("returns FMV = median of raw prices, with real records surfaced", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(slim, "getPricing").mockResolvedValue(rawPricing as any);
    const r = await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id,
      parallelId: null,
      gradeCompany: null,
      gradeValue: null,
    });
    expect(r).not.toBeNull();
    expect(r.fairMarketValueLive).toBe(150);   // median of 140/145/150/155/160
    expect(r.marketValue).toBe(150);
    expect(r.marketTier.value).toBe(150);
    expect(r.compsUsed).toBe(5);
    expect(r.compsAvailable).toBe(5);
    expect(r.priceSource).toBe("cardsight");
    expect(r.estimateBasis).toBe("5 comp(s) via cardsight");
  });

  it("propagates parallelId to Cardsight's pricing endpoint", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    const pricingSpy = vi.spyOn(slim, "getPricing").mockResolvedValue(rawPricing as any);
    await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id,
      parallelId: "334908f4-bf5f-4ed5-98c7-75113561ab55",
      gradeCompany: null,
      gradeValue: null,
    });
    expect(pricingSpy).toHaveBeenCalledWith(
      HARTMAN_HIT.id,
      { parallelId: "334908f4-bf5f-4ed5-98c7-75113561ab55" },
    );
  });

  it("returns null when Cardsight is unconfigured", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(false);
    const r = await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });
    expect(r).toBeNull();
  });

  it("returns null when the cardId doesn't resolve in Cardsight", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(null);
    const r = await priceByCardsightUuid({
      cardId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      parallelId: null, gradeCompany: null, gradeValue: null,
    });
    expect(r).toBeNull();
  });

  it("emits an empty pricing response when the card exists but has no sales", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: { count: 0, records: [] },
      graded: [],
      meta: { total_records: 0, last_sale_date: null },
      notFound: true,
    } as any);
    const r = await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });
    expect(r).not.toBeNull();
    expect(r.fairMarketValueLive).toBeNull();
    expect(r.compsUsed).toBe(0);
    expect(r.cardIdentity.player).toBe("Eric Hartman");
  });
});

describe("priceByCardsightUuid — graded overlay", () => {
  it("prefers the pinned (gradeCompany, gradeValue) median when it has records", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: {
        count: 2,
        records: [
          { price: 100, date: "2026-07-01" },
          { price: 110, date: "2026-07-02" },
        ],
      },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              count: 3,
              records: [
                { price: 500, date: "2026-07-01" },
                { price: 550, date: "2026-07-02" },
                { price: 600, date: "2026-07-03" },
              ],
            },
          ],
        },
      ],
      meta: { total_records: 5, last_sale_date: "2026-07-03" },
    } as any);
    const r = await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id,
      parallelId: null,
      gradeCompany: "PSA",
      gradeValue: 10,
    });
    expect(r.fairMarketValueLive).toBe(550);   // median of 500/550/600
    expect(r.estimateSource).toBe("graded-bucket");
  });

  it("gradeBreakdown array populated from all graded rows regardless of pinned grade", async () => {
    vi.spyOn(slim, "isCardsightConfigured").mockReturnValue(true);
    vi.spyOn(slim, "getCardDetail").mockResolvedValue(HARTMAN_DETAIL as any);
    vi.spyOn(slim, "getPricing").mockResolvedValue({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            { grade_value: "10", count: 2, records: [{ price: 500, date: "2026-07-01" }, { price: 550, date: "2026-07-02" }] },
            { grade_value: "9",  count: 1, records: [{ price: 300, date: "2026-07-01" }] },
          ],
        },
        {
          company_name: "BGS",
          grades: [
            { grade_value: "10", count: 1, records: [{ price: 400, date: "2026-07-01" }] },
          ],
        },
      ],
      meta: { total_records: 4, last_sale_date: "2026-07-02" },
    } as any);
    const r = await priceByCardsightUuid({
      cardId: HARTMAN_HIT.id, parallelId: null, gradeCompany: null, gradeValue: null,
    });
    expect(r.gradeBreakdown).toHaveLength(3);
    const psa10 = r.gradeBreakdown.find((row: any) => row.grader === "PSA" && row.grade === "10");
    expect(psa10.weightedMedianPrice).toBe(525);
    expect(psa10.compCount).toBe(2);
    expect(r.gradeBreakdown.some((row: any) => row.grader === "BGS")).toBe(true);
  });
});
