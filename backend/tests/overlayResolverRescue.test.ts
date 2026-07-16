// CF-RESOLVER-FALLBACK-COMPIQ-ROUTES (2026-07-13) — verify the overlay
// helper used by compiq/search + /price + /price-by-id routes.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  registerVendorSource,
  _clearResolverCacheForTests,
  _resetVendorRegistryForTests,
  type VendorSource,
  type CardResolution,
} from "../src/services/compiq/catalogResolver.service.js";
import { overlayResolverRescue } from "../src/services/compiq/resolverFallbackHelper.js";

function mockSource(name: any, res: CardResolution | null): VendorSource {
  return { name, async resolveCard() { return res; } };
}

beforeEach(() => {
  _resetVendorRegistryForTests();
  _clearResolverCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("overlayResolverRescue — CH-null path gets rescued", () => {
  it("overlays FMV + sourceVendor + estimateBasis when response has null FMV", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("cardsight", {
      vendor: "cardsight",
      cardId: "cs-blue-refractor",
      fairMarketValue: 1899.99,
      compCount: 1,
      freshestSaleDate: "2026-07-13",
      confidence: "high",
    }));

    const response: any = {
      fairMarketValueLive: null,
      marketValue: null,
      marketTier: { value: null, high: null },
      approximate: false,
    };
    await overlayResolverRescue(response, {
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    });

    expect(response.fairMarketValueLive).toBe(1899.99);
    expect(response.marketValue).toBe(1899.99);
    expect(response.marketTier.value).toBe(1899.99);
    expect(response.estimateBasis).toBe("1 comp(s) via cardsight");
    expect(response.approximate).toBe(true);
    // iOS shape lock (Drew 2026-07-13): vendor attribution stays out of
    // the wire — logged to KQL only. sourceVendor MUST NOT appear here.
    expect(response.sourceVendor).toBeUndefined();
  });
});

describe("overlayResolverRescue — no-op when CH already has FMV", () => {
  it("does NOT overlay when response.fairMarketValueLive is set", async () => {
    registerVendorSource(mockSource("cardsight", {
      vendor: "cardsight",
      cardId: "cs-would-overwrite",
      fairMarketValue: 999,
      compCount: 5,
      freshestSaleDate: null,
      confidence: "high",
    }));

    const response: any = { fairMarketValueLive: 200, marketValue: 200 };
    await overlayResolverRescue(response, { playerName: "Mookie", cardYear: 2020 });
    // Original values preserved
    expect(response.fairMarketValueLive).toBe(200);
    expect(response.marketValue).toBe(200);
  });

  it("does NOT overlay when response.marketValue is set even if fairMarketValueLive is null", async () => {
    registerVendorSource(mockSource("cardsight", {
      vendor: "cardsight",
      cardId: "cs-x",
      fairMarketValue: 500,
      compCount: 5,
      freshestSaleDate: null,
      confidence: "high",
    }));
    const response: any = { fairMarketValueLive: null, marketValue: 150 };
    await overlayResolverRescue(response, { playerName: "Mookie", cardYear: 2020 });
    expect(response.marketValue).toBe(150);
    expect(response.fairMarketValueLive).toBeNull();
  });
});

describe("overlayResolverRescue — resolver returns null → response unchanged", () => {
  it("all vendors miss → response stays null-FMV", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("cardsight", null));

    const response: any = { fairMarketValueLive: null, marketValue: null };
    await overlayResolverRescue(response, { playerName: "Nobody", cardYear: 2099 });
    expect(response.fairMarketValueLive).toBeNull();
    expect(response.marketValue).toBeNull();
  });
});

describe("overlayResolverRescue — cardhedge winner not overlaid (fallback contract)", () => {
  it("CH winner in resolver → NO overlay (CH already had its chance in primary path)", async () => {
    registerVendorSource(mockSource("cardhedge", {
      vendor: "cardhedge",
      cardId: "ch-card",
      fairMarketValue: 100,
      compCount: 10,
      freshestSaleDate: "2026-07-01",
      confidence: "high",
    }));

    const response: any = { fairMarketValueLive: null, marketValue: null };
    await overlayResolverRescue(response, { playerName: "Mookie", cardYear: 2020 });
    // CH is filtered out; no non-CH vendor answered → no overlay
    expect(response.fairMarketValueLive).toBeNull();
  });
});

describe("overlayResolverRescue — safe on malformed input", () => {
  it("null response → returns null", async () => {
    const r = await overlayResolverRescue(null, { playerName: "x" });
    expect(r).toBeNull();
  });
  it("non-object response → returns as-is", async () => {
    const r = await overlayResolverRescue("string" as any, { playerName: "x" });
    expect(r).toBe("string");
  });
});
