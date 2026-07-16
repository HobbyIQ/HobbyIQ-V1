// CF-CH-VENDOR-RAW-COMPS (Drew, 2026-07-13, PR #408) — verifies the
// CardHedge vendor source now emits per-record raw comps + a computed
// FMV via getCardSales, closing the vendor-symmetry gap with Cardsight.
//
// The engine-over-pooled-records architecture requires every vendor plugin
// to be capable of providing atomic sales records so downstream rescue
// paths (grade rescue, trend + prediction) can operate uniformly.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cardhedgeVendorSource } from "../src/services/compiq/cardhedgeVendorSource.js";
import * as chClient from "../src/services/compiq/cardhedge.client.js";

const baseQuery = {
  playerName: "Eric Hartman",
  cardYear: 2026,
  setName: "2026 Bowman Chrome Prospects",
  cardNumber: "CPA-EHA",
} as const;

const CANDIDATE = {
  card_id: "ch-abc",
  player: "Eric Hartman",
  year: 2026,
  set: "2026 Bowman Chrome Prospects Baseball",
  number: "CPA-EHA",
  variant: "Speckle Refractor",
};

function stubSearch(cards: any[]) {
  vi.spyOn(chClient, "searchCards").mockResolvedValue(cards as any);
}
function stubSales(sales: any[]) {
  vi.spyOn(chClient, "getCardSales").mockResolvedValue(sales as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cardhedgeVendorSource — per-record raw comps", () => {
  it("emits every Raw sale as a ResolverComp", async () => {
    stubSearch([CANDIDATE]);
    stubSales([
      { price: 100, date: "2026-07-01", grade: "Raw", source: "cardhedge", sale_type: "auction", title: null, url: null },
      { price: 120, date: "2026-07-02", grade: "Raw", source: "cardhedge", sale_type: "fixed", title: null, url: null },
      { price: 90, date: "2026-06-30", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
    ]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res).not.toBeNull();
    expect(res!.rawComps).toHaveLength(3);
    expect(res!.rawComps![0]).toEqual({
      saleDate: "2026-07-01",
      price: 100,
      saleType: "auction",
    });
    expect(res!.rawComps![2]).toMatchObject({ saleDate: "2026-06-30", price: 90 });
  });

  it("computes FMV as median of raw prices", async () => {
    stubSearch([CANDIDATE]);
    stubSales([
      { price: 100, date: "2026-07-01", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 200, date: "2026-07-02", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 300, date: "2026-07-03", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
    ]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res!.fairMarketValue).toBe(200);
    expect(res!.compCount).toBe(3);
  });

  it("emits null FMV + empty rawComps when CH sales endpoint fails", async () => {
    stubSearch([CANDIDATE]);
    vi.spyOn(chClient, "getCardSales").mockRejectedValue(new Error("network"));
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    // Still returns an identity resolution ("CH knows this card") — just no pricing.
    expect(res).not.toBeNull();
    expect(res!.cardId).toBe("ch-abc");
    expect(res!.rawComps).toEqual([]);
    expect(res!.fairMarketValue).toBeNull();
    expect(res!.compCount).toBe(0);
  });

  it("drops records with non-positive prices at the vendor boundary", async () => {
    stubSearch([CANDIDATE]);
    stubSales([
      { price: 100, date: "2026-07-01", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 0, date: "2026-07-02", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: -50, date: "2026-07-03", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 90, date: "2026-07-04", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
    ]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res!.rawComps).toHaveLength(2);
    expect(res!.rawComps!.map((c) => c.price).sort((a, b) => a - b)).toEqual([90, 100]);
  });

  it("computes freshestSaleDate as the max saleDate across raw comps", async () => {
    stubSearch([CANDIDATE]);
    stubSales([
      { price: 100, date: "2026-06-01", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 110, date: "2026-07-15", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
      { price: 105, date: "2026-06-20", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
    ]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res!.freshestSaleDate).toBe("2026-07-15");
  });

  it("preserves confidence scoring from candidate match quality (unchanged from pre-408)", async () => {
    stubSearch([{
      ...CANDIDATE,
      year: 2026,           // matches query.cardYear
      number: "CPA-EHA",    // matches query.cardNumber
      variant: null,        // query has no parallel → not checked
    }]);
    stubSales([]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    // 2 of 2 checked matched → 1.0 ratio → "high"
    expect(res!.confidence).toBe("high");
  });

  it("returns null when CH search returns no candidates", async () => {
    stubSearch([]);
    stubSales([]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res).toBeNull();
  });

  it("returns null when query has neither playerName nor cardId", async () => {
    stubSearch([CANDIDATE]);
    stubSales([]);
    const res = await cardhedgeVendorSource.resolveCard({});
    expect(res).toBeNull();
  });

  it("gradedComps intentionally NOT emitted from CH vendor (comment: graded stays on primary path)", async () => {
    stubSearch([CANDIDATE]);
    stubSales([
      { price: 100, date: "2026-07-01", grade: "Raw", source: "cardhedge", sale_type: null, title: null, url: null },
    ]);
    const res = await cardhedgeVendorSource.resolveCard(baseQuery);
    expect(res!.gradedComps).toBeUndefined();
  });
});
