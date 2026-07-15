// CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15) — pins the tier-3 pricing
// backstop for cards NO vendor's canonical catalog resolves. Fires when
// both CH bridge AND CS catalog-explode returned null.
//
// Coverage:
//   - CS unconfigured / query empty → null
//   - Empty result set → null
//   - Filter: only completed auctions land in sales (belt-and-suspenders)
//   - Filter: positive prices, valid dates
//   - MAX_BACKSTOP_COMPS cap
//   - card_id is DELIBERATELY empty (no canonical bridge)
//   - variantWarning=["cs_pricing_backstop"] set for downstream distinction
//   - CS-native fields (listing_type, image_url) preserved

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CardsightPricingSearchRecord } from "../src/services/compiq/cardsightSlim.client.js";

vi.mock("../src/services/compiq/cardsightSlim.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsightSlim.client.js")>(
    "../src/services/compiq/cardsightSlim.client.js",
  );
  return {
    ...actual,
    searchPricingByTitle: vi.fn(),
    isCardsightConfigured: vi.fn(),
  };
});

import { searchPricingByTitle, isCardsightConfigured } from "../src/services/compiq/cardsightSlim.client.js";
import { tryCardsightPricingBackstop } from "../src/services/compiq/cardsightPricingBackstop.js";

const mockedSearch = vi.mocked(searchPricingByTitle);
const mockedConfigured = vi.mocked(isCardsightConfigured);

function rec(o: Partial<CardsightPricingSearchRecord> = {}): CardsightPricingSearchRecord {
  return {
    title: "2026 Bowman Eric Hartman Blue Refractor Auto /150 #CPA-EHA",
    price: 1800,
    date: "2026-07-12T00:00:00Z",
    source: "ebay",
    listing_type: "auction",
    url: "https://ebay.com/itm/x",
    image_url: "https://i.ebayimg.com/x.jpg",
    parallel_id: null,
    parallel_name: null,
    ...o,
  };
}

const ctx = {
  playerName: "Eric Hartman",
  cardYear: 2026,
  parallel: "Blue Refractor",
  cardNumber: "CPA-EHA",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedConfigured.mockReturnValue(true);
});

describe("tryCardsightPricingBackstop — early exits", () => {
  it("returns null when CS not configured", async () => {
    mockedConfigured.mockReturnValue(false);
    const r = await tryCardsightPricingBackstop("anything", ctx, "Raw");
    expect(r).toBeNull();
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("returns null on empty query", async () => {
    const r = await tryCardsightPricingBackstop("   ", ctx, "Raw");
    expect(r).toBeNull();
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("returns null when search yields zero results", async () => {
    mockedSearch.mockResolvedValue([]);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r).toBeNull();
  });

  it("returns null when all results are filtered out (non-auction / bad price / no date)", async () => {
    mockedSearch.mockResolvedValue([
      rec({ listing_type: "fixed" }),          // ask price — reject
      rec({ price: 0 }),                        // zero — reject
      rec({ price: -50 }),                      // negative — reject
      rec({ date: "" }),                        // no date — reject
      rec({ date: null as unknown as string }), // null date — reject
    ]);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r).toBeNull();
  });
});

describe("tryCardsightPricingBackstop — happy path", () => {
  it("returns comps with source=cardsight and empty card_id (no canonical bridge)", async () => {
    mockedSearch.mockResolvedValue([
      rec({ price: 1800, date: "2026-07-12T00:00:00Z" }),
      rec({ price: 1750, date: "2026-07-10T00:00:00Z" }),
    ]);
    const r = await tryCardsightPricingBackstop("Eric Hartman 2026 Bowman Blue Refractor Auto", ctx, "Raw");
    expect(r).not.toBeNull();
    expect(r!.sales).toHaveLength(2);
    expect(r!.sales.every((s) => s.source === "cardsight")).toBe(true);
    expect(r!.card?.card_id).toBe("");   // deliberate — no canonical bridge
    expect(r!.variantWarning).toEqual(["cs_pricing_backstop"]);
  });

  it("preserves listing_type + image_url so RawComp mapper picks them up", async () => {
    mockedSearch.mockResolvedValue([
      rec({ listing_type: "auction", image_url: "https://i.ebayimg.com/z.jpg" }),
    ]);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    const sale = r!.sales[0] as { listing_type?: string | null; image_url?: string | null };
    expect(sale.listing_type).toBe("auction");
    expect(sale.image_url).toBe("https://i.ebayimg.com/z.jpg");
  });

  it("propagates queryContext into synthetic identity", async () => {
    mockedSearch.mockResolvedValue([rec()]);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r!.card?.player).toBe("Eric Hartman");
    expect(r!.card?.year).toBe(2026);
    expect(r!.card?.variant).toBe("Blue Refractor");
    expect(r!.card?.number).toBe("CPA-EHA");
  });

  it("caps at MAX_BACKSTOP_COMPS (25) even if server returns more", async () => {
    const many: CardsightPricingSearchRecord[] = Array.from({ length: 40 }, (_, i) =>
      rec({ price: 1000 + i, date: `2026-06-${String(1 + i).padStart(2, "0")}T00:00:00Z` }),
    );
    mockedSearch.mockResolvedValue(many);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r!.sales.length).toBe(25);
  });

  it("belt-and-suspenders: filters out non-auction rows even if server returns them", async () => {
    mockedSearch.mockResolvedValue([
      rec({ price: 1800, listing_type: "auction" }),
      rec({ price: 999, listing_type: "fixed" }),   // ASK — should be dropped
      rec({ price: 1700, listing_type: null }),      // unknown — should be dropped
    ]);
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r!.sales.length).toBe(1);
    expect(r!.sales[0].price).toBe(1800);
  });
});

describe("tryCardsightPricingBackstop — period selection by grade", () => {
  it("uses '3m' window for Raw", async () => {
    mockedSearch.mockResolvedValue([rec()]);
    await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(mockedSearch).toHaveBeenCalledWith("q", expect.objectContaining({ period: "3m" }));
  });

  it("uses '1y' window for graded grades (thinner cohort)", async () => {
    mockedSearch.mockResolvedValue([rec()]);
    await tryCardsightPricingBackstop("q", ctx, "PSA 10");
    expect(mockedSearch).toHaveBeenCalledWith("q", expect.objectContaining({ period: "1y" }));
  });

  it("always requests listingType='auction' to avoid asks polluting FMV", async () => {
    mockedSearch.mockResolvedValue([rec()]);
    await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(mockedSearch).toHaveBeenCalledWith("q", expect.objectContaining({ listingType: "auction" }));
  });
});

describe("tryCardsightPricingBackstop — error resilience", () => {
  it("returns null when searchPricingByTitle throws", async () => {
    mockedSearch.mockRejectedValue(new Error("network"));
    const r = await tryCardsightPricingBackstop("q", ctx, "Raw");
    expect(r).toBeNull();
  });

  it("still works with undefined queryContext (backstop tolerates missing identity)", async () => {
    mockedSearch.mockResolvedValue([rec()]);
    const r = await tryCardsightPricingBackstop("q", undefined, "Raw");
    expect(r).not.toBeNull();
    expect(r!.card?.card_id).toBe("");
    expect(r!.card?.player).toBeUndefined();
  });
});
