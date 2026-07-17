// CF-NOTABLE-SALES-FEED (Drew, 2026-07-17). Pinning tests for the
// notable-sales reader — query bounds, source-label derivation,
// error handling.

import { describe, it, expect, afterEach } from "vitest";
import {
  readNotableSales,
  deriveSourceLabel,
  _setContainerForTesting,
  _NOTABLE_SALES_DEFAULTS,
} from "../src/services/portfolioiq/notableSalesRead.service.js";
import type { CHDailySaleRow } from "../src/types/chDailySales.types.js";

function makeRow(overrides: Partial<CHDailySaleRow> = {}): CHDailySaleRow {
  return {
    price_history_id: `phid-${Math.random().toString(36).slice(2, 8)}`,
    source: "ebay",
    description: "",
    price: 250_000,
    listing_url: "https://www.ebay.com/itm/12345",
    image_url: "https://cdn.example.com/img.jpg",
    pop: 0,
    sale_date: "2026-07-15T12:00:00Z",
    sale_type: "BIN",
    card_id: "card-42",
    card_description: "",
    number: "1",
    player: "Mike Trout",
    grade: "10",
    grader: "PSA",
    group: "Baseball",
    card_set: "2011 Topps Update",
    card_set_type: "Topps",
    variant: "Base",
    year: 2011,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function stubContainer(
  rows: CHDailySaleRow[],
  opts: { onQuery?: (spec: any) => void } = {},
): any {
  return {
    items: {
      query: (spec: any) => {
        opts.onQuery?.(spec);
        let called = false;
        return {
          hasMoreResults: () => !called,
          fetchNext: async () => {
            called = true;
            return { resources: rows };
          },
        };
      },
    },
  };
}

describe("deriveSourceLabel", () => {
  it("labels goldin.co as Goldin", () => {
    expect(deriveSourceLabel("https://goldin.co/item/abc")).toBe("Goldin");
    expect(deriveSourceLabel("https://www.goldin.co/item/abc")).toBe("Goldin");
  });

  it("labels ha.com and sports.ha.com as Heritage", () => {
    expect(deriveSourceLabel("https://ha.com/c/item.zx?saleNo=5")).toBe("Heritage");
    expect(deriveSourceLabel("https://sports.ha.com/c/item.zx")).toBe("Heritage");
  });

  it("labels fanaticscollect.com as Fanatics Collect", () => {
    expect(deriveSourceLabel("https://www.fanaticscollect.com/weekly/12345")).toBe("Fanatics Collect");
    expect(deriveSourceLabel("https://fanaticscollect.com/weekly/12345")).toBe("Fanatics Collect");
  });

  it("labels ebay.com (any subdomain / tld) as eBay", () => {
    expect(deriveSourceLabel("https://www.ebay.com/itm/1")).toBe("eBay");
    expect(deriveSourceLabel("https://ebay.co.uk/itm/1")).toBe("eBay");
  });

  it("labels x.com / twitter.com as Private", () => {
    expect(deriveSourceLabel("https://x.com/some/tweet")).toBe("Private");
    expect(deriveSourceLabel("https://twitter.com/some/tweet")).toBe("Private");
  });

  it("returns null on empty / unparseable URL", () => {
    expect(deriveSourceLabel("")).toBeNull();
    expect(deriveSourceLabel("not-a-url")).toBeNull();
    // @ts-expect-error — pinning the runtime guard
    expect(deriveSourceLabel(null)).toBeNull();
  });

  it("returns null on unrecognized domains", () => {
    expect(deriveSourceLabel("https://example.com/item/1")).toBeNull();
    expect(deriveSourceLabel("https://myslabs.com/listing/2")).toBeNull();
  });
});

describe("readNotableSales — orchestration", () => {
  afterEach(() => _setContainerForTesting(null));

  it("emits an empty result when container isn't configured", async () => {
    _setContainerForTesting(null);
    // No COSMOS_CONNECTION_STRING set in tests → container is null
    const originalCs = process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_CONNECTION_STRING;
    try {
      const r = await readNotableSales();
      expect(r).toEqual({ count: 0, sales: [] });
    } finally {
      if (originalCs) process.env.COSMOS_CONNECTION_STRING = originalCs;
    }
  });

  it("returns rows mapped to camelCase NotableSale shape", async () => {
    _setContainerForTesting(stubContainer([makeRow()]));
    const r = await readNotableSales();
    expect(r.count).toBe(1);
    expect(r.sales[0].cardId).toBe("card-42");
    expect(r.sales[0].player).toBe("Mike Trout");
    expect(r.sales[0].cardSet).toBe("2011 Topps Update");
    expect(r.sales[0].price).toBe(250_000);
    expect(r.sales[0].sourceLabel).toBe("eBay");
  });

  it("passes clamped @minPrice and @sinceIso params to Cosmos query", async () => {
    let captured: any = null;
    _setContainerForTesting(stubContainer([], { onQuery: (spec) => { captured = spec; } }));
    await readNotableSales({ minPrice: 500_000, days: 7 });

    const paramMap: Record<string, unknown> = {};
    for (const p of captured.parameters as { name: string; value: unknown }[]) {
      paramMap[p.name] = p.value;
    }
    expect(paramMap["@minPrice"]).toBe(500_000);
    expect(typeof paramMap["@sinceIso"]).toBe("string");
    // sinceIso should be ~7 days ago
    const now = Date.now();
    const sinceMs = Date.parse(paramMap["@sinceIso"] as string);
    const diffDays = (now - sinceMs) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("applies defaults (100k / 30d / 20 rows) when opts are unset", async () => {
    let captured: any = null;
    _setContainerForTesting(stubContainer([], { onQuery: (spec) => { captured = spec; } }));
    await readNotableSales();

    expect(captured.query).toMatch(/SELECT TOP 20/);
    const paramMap: Record<string, unknown> = {};
    for (const p of captured.parameters as { name: string; value: unknown }[]) {
      paramMap[p.name] = p.value;
    }
    expect(paramMap["@minPrice"]).toBe(_NOTABLE_SALES_DEFAULTS.minPrice);
  });

  it("clamps out-of-range days and limit to bounds", async () => {
    let captured: any = null;
    _setContainerForTesting(stubContainer([], { onQuery: (spec) => { captured = spec; } }));
    // days=9999 → clamped to MAX_DAYS (365)
    // limit=9999 → clamped to MAX_LIMIT (100)
    await readNotableSales({ days: 9999, limit: 9999 });
    expect(captured.query).toMatch(/SELECT TOP 100/);
    // sinceIso should be ~365 days ago
    const paramMap: Record<string, unknown> = {};
    for (const p of captured.parameters as { name: string; value: unknown }[]) {
      paramMap[p.name] = p.value;
    }
    const now = Date.now();
    const sinceMs = Date.parse(paramMap["@sinceIso"] as string);
    const diffDays = (now - sinceMs) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(364);
    expect(diffDays).toBeLessThan(366);
  });

  it("returns empty result when the Cosmos iterator throws", async () => {
    _setContainerForTesting({
      items: {
        query: () => {
          throw new Error("cosmos-offline");
        },
      },
    } as any);
    const r = await readNotableSales();
    expect(r).toEqual({ count: 0, sales: [] });
  });

  it("maps sourceLabel per-row using each row's own listingUrl", async () => {
    const rows: CHDailySaleRow[] = [
      makeRow({ listing_url: "https://goldin.co/item/1", price_history_id: "g" }),
      makeRow({ listing_url: "https://ha.com/c/item.zx", price_history_id: "h" }),
      makeRow({ listing_url: "https://x.com/private/tweet", price_history_id: "x" }),
      makeRow({ listing_url: "", price_history_id: "empty" }),
    ];
    _setContainerForTesting(stubContainer(rows));
    const r = await readNotableSales();
    const byId = Object.fromEntries(r.sales.map((s) => [s.cardId + s.saleDate + s.price, s.sourceLabel]));
    // 4 rows share cardId + saleDate + price, so simpler: just check the array in order
    expect(r.sales.map((s) => s.sourceLabel)).toEqual(["Goldin", "Heritage", "Private", null]);
    void byId; // unused — satisfies noUnused
  });

  it("caps result at the requested limit even when the container returns more rows", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow({ price_history_id: `p${i}` }));
    _setContainerForTesting(stubContainer(rows));
    const r = await readNotableSales({ limit: 5 });
    expect(r.count).toBe(5);
    expect(r.sales).toHaveLength(5);
  });
});
