// CF-RESOLVER-FALLBACK-EVERYWHERE (2026-07-13) — shared helper tests.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  registerVendorSource,
  _clearResolverCacheForTests,
  _resetVendorRegistryForTests,
  type VendorSource,
  type CardResolution,
} from "../src/services/compiq/catalogResolver.service.js";
import {
  tryResolverFallback,
  shouldTryFallback,
} from "../src/services/compiq/resolverFallbackHelper.js";

function mockSource(name: any, resolution: CardResolution | null): VendorSource {
  return { name, async resolveCard() { return resolution; } };
}

beforeEach(() => {
  _resetVendorRegistryForTests();
  _clearResolverCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("shouldTryFallback — predicate", () => {
  it("null estimate → try fallback", () => {
    expect(shouldTryFallback(null)).toBe(true);
    expect(shouldTryFallback(undefined)).toBe(true);
  });

  it("both fairMarketValue AND estimatedValue null → try", () => {
    expect(shouldTryFallback({ fairMarketValue: null, estimatedValue: null })).toBe(true);
  });

  it("fairMarketValue present → DON'T try", () => {
    expect(shouldTryFallback({ fairMarketValue: 100, estimatedValue: null })).toBe(false);
  });

  it("estimatedValue present → DON'T try", () => {
    expect(shouldTryFallback({ fairMarketValue: null, estimatedValue: 50 })).toBe(false);
  });
});

describe("tryResolverFallback — vendor filtering", () => {
  it("cardhedge winner → ignored (fallback returns null)", async () => {
    registerVendorSource(mockSource("cardhedge", {
      vendor: "cardhedge",
      cardId: "ch",
      fairMarketValue: 200,
      compCount: 10,
      freshestSaleDate: "2026-07-01",
      confidence: "high",
    }));
    const r = await tryResolverFallback({ playerName: "Mookie", cardYear: 2020 });
    expect(r).toBeNull();
  });

  it("sold-comps winner → returned + surfaced", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("sold-comps", {
      vendor: "sold-comps",
      cardId: "sc-abc",
      fairMarketValue: 342.5,
      compCount: 7,
      freshestSaleDate: "2026-07-10",
      confidence: "high",
    }));
    const r = await tryResolverFallback({ playerName: "Mookie", cardYear: 2020 });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("sold-comps");
    expect(r!.fairMarketValue).toBe(342.5);
    expect(r!.compCount).toBe(7);
    expect(r!.estimateBasis).toBe("7 comp(s) via sold-comps");
  });

  it("cardsight winner → returned + surfaced", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("cardsight", {
      vendor: "cardsight",
      cardId: "cs-blue-refractor",
      fairMarketValue: 1899.99,
      compCount: 1,
      freshestSaleDate: "2026-07-13",
      confidence: "high",
    }));
    const r = await tryResolverFallback({
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("cardsight");
    expect(r!.fairMarketValue).toBe(1899.99);
  });

  it("all vendors return null → fallback returns null", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("sold-comps", null));
    registerVendorSource(mockSource("cardsight", null));
    const r = await tryResolverFallback({ playerName: "Nobody", cardYear: 2099 });
    expect(r).toBeNull();
  });

  it("resolver throws → fallback returns null (never throws)", async () => {
    registerVendorSource({
      name: "cardsight",
      async resolveCard() { throw new Error("boom"); },
    });
    const r = await tryResolverFallback({ playerName: "Mookie", cardYear: 2020 });
    expect(r).toBeNull();
  });

  it("zero-FMV winner → ignored (fallback requires positive FMV)", async () => {
    registerVendorSource(mockSource("cardhedge", null));
    registerVendorSource(mockSource("cardsight", {
      vendor: "cardsight",
      cardId: "cs-zero",
      fairMarketValue: 0,
      compCount: 5,
      freshestSaleDate: null,
      confidence: "high",
    }));
    const r = await tryResolverFallback({ playerName: "Mookie", cardYear: 2020 });
    expect(r).toBeNull();
  });
});
