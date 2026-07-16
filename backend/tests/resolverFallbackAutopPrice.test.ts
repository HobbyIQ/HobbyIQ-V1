// CF-CATALOG-RESOLVER-FALLBACK (2026-07-13) — verify autoPriceHolding
// consults the multi-source resolver when CH couldn't price a card. On
// resolver hit, fairMarketValue + sourceVendor should reflect the winning
// non-CH vendor.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  registerVendorSource,
  _clearResolverCacheForTests,
  _resetVendorRegistryForTests,
  type CardResolution,
  type VendorSource,
} from "../src/services/compiq/catalogResolver.service.js";

beforeEach(() => {
  _resetVendorRegistryForTests();
  _clearResolverCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

// A synthetic sold-comps source that always returns a confident hit at a
// specified price. Used to simulate the "our own sales have priced this
// card even when CH can't find it" case.
function syntheticSoldComps(fmv: number, count = 5): VendorSource {
  return {
    name: "sold-comps",
    async resolveCard(query) {
      const resolution: CardResolution = {
        vendor: "sold-comps",
        cardId: `sold-comps:${query.playerName ?? "?"}`,
        fairMarketValue: fmv,
        compCount: count,
        freshestSaleDate: "2026-07-10T00:00:00Z",
        confidence: "high",
      };
      return resolution;
    },
  };
}

// A synthetic CH source that always returns nothing — simulates a
// catalog gap.
function chCatalogMiss(): VendorSource {
  return {
    name: "cardhedge",
    async resolveCard() { return null; },
  };
}

describe("catalog resolver fallback in autoPriceHolding", () => {
  it("resolver contract holds: sold-comps hit surfaces the FMV + winning vendor", async () => {
    registerVendorSource(chCatalogMiss());
    registerVendorSource(syntheticSoldComps(342.5, 7));

    const { resolveCard } = await import("../src/services/compiq/catalogResolver.service.js");
    const r = await resolveCard({
      playerName: "Eric Hartman",
      cardYear: 2026,
      setName: "Bowman",
      parallel: "Blue Refractor",
      cardNumber: "CPA-EHA",
      isAuto: true,
    });

    expect(r.winner).toBeTruthy();
    expect(r.winner?.vendor).toBe("sold-comps");
    expect(r.winner?.fairMarketValue).toBe(342.5);
    expect(r.winner?.compCount).toBe(7);
    expect(r.winner?.confidence).toBe("high");
  });

  it("when CH resolves a card, resolver returns CH — sold-comps is NOT preferred", async () => {
    // Both vendors return hits; the fast one wins the race.
    registerVendorSource({
      name: "cardhedge",
      async resolveCard() {
        return {
          vendor: "cardhedge",
          cardId: "ch-card",
          fairMarketValue: 200,
          compCount: 12,
          freshestSaleDate: "2026-07-01T00:00:00Z",
          confidence: "high",
        };
      },
    });
    registerVendorSource(syntheticSoldComps(150, 3));

    const { resolveCard } = await import("../src/services/compiq/catalogResolver.service.js");
    const r = await resolveCard({
      playerName: "Mookie Betts",
      cardYear: 2020,
      setName: "Panini Prizm",
      cardNumber: "275",
    });

    expect(r.winner?.vendor).toBe("cardhedge");
    expect(r.winner?.fairMarketValue).toBe(200);
  });

  it("when both sources miss, resolver returns null (no forced pricing)", async () => {
    registerVendorSource(chCatalogMiss());
    registerVendorSource({
      name: "sold-comps",
      async resolveCard() { return null; },
    });

    const { resolveCard } = await import("../src/services/compiq/catalogResolver.service.js");
    const r = await resolveCard({
      playerName: "Truly Missing Player",
      cardYear: 2099,
    });

    expect(r.winner).toBeNull();
  });
});
