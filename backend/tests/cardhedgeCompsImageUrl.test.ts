// CF-COMP-IMAGE-PHASE-0 (Drew, 2026-07-16) — pin the CH /cards/comps
// image → image_url passthrough. Live probe (2026-07-16) confirmed CH
// returns the eBay thumbnail under the field name `image`; the daily-
// price-export CSV uses `image_url`. Our mapper reads both defensively
// so a rename on CH's side doesn't silently null the field on comp rows.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCardSales, type CardHedgeSale } from "../src/services/compiq/cardhedge.client.js";

const ORIGINAL_KEY = process.env.CARD_HEDGE_API_KEY;

beforeEach(() => {
  process.env.CARD_HEDGE_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.CARD_HEDGE_API_KEY;
  else process.env.CARD_HEDGE_API_KEY = ORIGINAL_KEY;
});

function mockFetchOnce(body: unknown, opts: { status?: number } = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    json: async () => body,
  }));
}

describe("getCardSales — image → image_url passthrough", () => {
  it("reads CH's `image` field into image_url", async () => {
    mockFetchOnce({
      raw_prices: [
        {
          price: "42.50",
          sale_date: "2026-07-15",
          grade: "PSA 9",
          price_source: "card_hedge",
          sale_type: "BIN",
          title: "Test Card PSA 9",
          sale_url: "https://ebay.com/x",
          image: "https://i.ebayimg.com/thumb1.jpg",
        },
      ],
    });
    const sales = await getCardSales("card-1", "PSA 9", 5);
    expect(sales.length).toBe(1);
    expect(sales[0].image_url).toBe("https://i.ebayimg.com/thumb1.jpg");
    expect(sales[0].price).toBe(42.5);
    expect(sales[0].title).toBe("Test Card PSA 9");
  });

  it("falls back to `image_url` if CH renames the field (daily-export naming)", async () => {
    mockFetchOnce({
      raw_prices: [
        {
          price: "10.00",
          sale_date: "2026-07-15",
          grade: "Raw",
          sale_type: "Auction",
          title: "Raw Sale",
          image_url: "https://i.ebayimg.com/thumb2.jpg",
        },
      ],
    });
    const sales = await getCardSales("card-2", "Raw", 5);
    expect(sales[0].image_url).toBe("https://i.ebayimg.com/thumb2.jpg");
  });

  it("defaults to null when CH omits both `image` and `image_url`", async () => {
    mockFetchOnce({
      raw_prices: [
        {
          price: "5.00",
          sale_date: "2026-07-15",
          grade: "Raw",
          title: "No-image sale",
        },
      ],
    });
    const sales = await getCardSales("card-3", "Raw", 5);
    expect(sales[0].image_url).toBeNull();
  });

  it("prefers `image` when both fields are present (CH is authoritative for the live endpoint)", async () => {
    mockFetchOnce({
      raw_prices: [
        {
          price: "20.00",
          sale_date: "2026-07-15",
          grade: "PSA 10",
          image: "https://from-image-field.jpg",
          image_url: "https://from-image-url-field.jpg",
        },
      ],
    });
    const sales = await getCardSales("card-4", "PSA 10", 5);
    expect(sales[0].image_url).toBe("https://from-image-field.jpg");
  });

  it("empty raw_prices → empty result (no throw)", async () => {
    mockFetchOnce({ raw_prices: [] });
    const sales = await getCardSales("card-5", "PSA 10", 5);
    expect(sales).toEqual([]);
  });

  it("HTTP failure → empty result (never throws)", async () => {
    mockFetchOnce({}, { status: 500 });
    const sales = await getCardSales("card-6", "PSA 10", 5);
    expect(sales).toEqual([]);
  });

  it("CardHedgeSale interface exposes image_url — pin the contract", () => {
    // Compile-time pin: if a future edit removes image_url from the
    // interface, this file fails tsc + the assertion fails at runtime.
    const sample: CardHedgeSale = {
      price: 1,
      date: null,
      grade: "Raw",
      source: "x",
      sale_type: null,
      title: null,
      url: null,
      image_url: "https://example/x.jpg",
    };
    expect(sample.image_url).toBe("https://example/x.jpg");
  });
});
