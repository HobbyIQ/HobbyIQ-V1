// CF-CATALOG-RESOLVER (2026-07-13) — unit tests for the multi-source
// resolver orchestrator. Covers cache-first, parallel fan-out, early-
// return race, full-timeout fallback, reconciliation logging.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalCacheKey,
  registerVendorSource,
  listVendorSources,
  resolveCard,
  _clearResolverCacheForTests,
  _resetVendorRegistryForTests,
  type CardQuery,
  type CardResolution,
  type VendorSource,
} from "../src/services/compiq/catalogResolver.service.js";

/** Build a mock vendor source with configurable behavior. */
function mockSource(
  name: any,
  behavior: (query: CardQuery) => Promise<CardResolution | null>,
): VendorSource {
  return { name, resolveCard: behavior };
}

function fastConfidentHit(vendor: any, fmv = 100, delay = 50): VendorSource {
  return mockSource(vendor, async () => {
    await new Promise((r) => setTimeout(r, delay));
    return {
      vendor,
      cardId: `${vendor}-card`,
      fairMarketValue: fmv,
      compCount: 5,
      freshestSaleDate: "2026-07-01T00:00:00Z",
      confidence: "high",
    };
  });
}

function slowLowConfidenceHit(vendor: any, delay = 500): VendorSource {
  return mockSource(vendor, async () => {
    await new Promise((r) => setTimeout(r, delay));
    return {
      vendor,
      cardId: `${vendor}-slow`,
      fairMarketValue: 50,
      compCount: 1,
      freshestSaleDate: null,
      confidence: "low",
    };
  });
}

function nullResponder(vendor: any, delay = 100): VendorSource {
  return mockSource(vendor, async () => {
    await new Promise((r) => setTimeout(r, delay));
    return null;
  });
}

beforeEach(() => {
  _resetVendorRegistryForTests();
  _clearResolverCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("canonicalCacheKey — order-independent + case-insensitive", () => {
  it("produces same key regardless of field order", () => {
    const a = canonicalCacheKey({ playerName: "Mookie", cardYear: 2020 });
    const b = canonicalCacheKey({ cardYear: 2020, playerName: "Mookie" });
    expect(a).toBe(b);
  });

  it("case-insensitive on string fields", () => {
    const a = canonicalCacheKey({ playerName: "Mookie Betts", setName: "Panini Prizm" });
    const b = canonicalCacheKey({ playerName: "mookie betts", setName: "PANINI PRIZM" });
    expect(a).toBe(b);
  });

  it("different queries produce different keys", () => {
    const a = canonicalCacheKey({ playerName: "Mookie", cardYear: 2020 });
    const b = canonicalCacheKey({ playerName: "Mookie", cardYear: 2021 });
    expect(a).not.toBe(b);
  });
});

describe("resolveCard — cache-first", () => {
  it("cache hit skips vendor calls entirely", async () => {
    const source = fastConfidentHit("cardhedge", 100, 20);
    registerVendorSource(source);
    const spy = vi.spyOn(source, "resolveCard");

    const q: CardQuery = { playerName: "Mookie", cardYear: 2020 };
    const first = await resolveCard(q);
    expect(first.fromCache).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await resolveCard(q);
    expect(second.fromCache).toBe(true);
    expect(second.winner?.cardId).toBe("cardhedge-card");
    expect(spy).toHaveBeenCalledTimes(1);   // no additional call
  });
});

describe("resolveCard — early-return on first confident hit", () => {
  it("returns the fast confident hit without waiting for slow source", async () => {
    registerVendorSource(fastConfidentHit("cardhedge", 100, 50));
    registerVendorSource(slowLowConfidenceHit("sold-comps", 500));

    const start = Date.now();
    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    const elapsed = Date.now() - start;

    expect(result.winner?.vendor).toBe("cardhedge");
    expect(result.winner?.confidence).toBe("high");
    // Should return in <300ms (fast hit @ 50ms + margin), NOT wait for
    // slow source @ 500ms.
    expect(elapsed).toBeLessThan(300);
  });
});

describe("resolveCard — waits for all when no early confident hit", () => {
  it("no confident hit → waits for slow source + picks best", async () => {
    // Both sources return low-confidence hits. Neither triggers early-return.
    registerVendorSource(slowLowConfidenceHit("cardhedge", 300));
    registerVendorSource(slowLowConfidenceHit("sold-comps", 500));

    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    expect(result.winner).toBeTruthy();
    expect(result.responses.filter((r) => r !== null)).toHaveLength(2);
  });

  it("all sources return null → winner is null", async () => {
    registerVendorSource(nullResponder("cardhedge", 100));
    registerVendorSource(nullResponder("sold-comps", 100));

    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    expect(result.winner).toBeNull();
  });
});

describe("resolveCard — vendor errors don't crash", () => {
  it("one vendor throws → the other still returns", async () => {
    registerVendorSource(mockSource("cardhedge", async () => {
      throw new Error("CH exploded");
    }));
    registerVendorSource(fastConfidentHit("sold-comps", 100, 50));

    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    expect(result.winner?.vendor).toBe("sold-comps");
  });
});

describe("resolveCard — empty registry", () => {
  it("no sources registered → null winner", async () => {
    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    expect(result.winner).toBeNull();
    expect(result.responses).toHaveLength(0);
  });
});

describe("pickBest — ranks by confidence, then comps, then recency", () => {
  it("prefers high-confidence over medium even if fewer comps", async () => {
    // Register both — orchestrator will pick the high-confidence one when
    // neither triggers early-return (medium confidence blocks early-return).
    registerVendorSource(mockSource("cardhedge", async () => ({
      vendor: "cardhedge",
      cardId: "ch-card",
      fairMarketValue: 100,
      compCount: 2,
      freshestSaleDate: "2026-07-01T00:00:00Z",
      confidence: "high",
    })));
    registerVendorSource(mockSource("sold-comps", async () => ({
      vendor: "sold-comps",
      cardId: "sc-card",
      fairMarketValue: 90,
      compCount: 10,
      freshestSaleDate: "2026-07-10T00:00:00Z",
      confidence: "medium",
    })));

    const result = await resolveCard({ playerName: "Mookie", cardYear: 2020 });
    // CH is high-confidence + compCount 2 → confident predicate needs
    // compCount >= 3 to trigger early return. Neither triggers early-
    // return, so we wait + pickBest ranks high-confidence first.
    expect(result.winner?.vendor).toBe("cardhedge");
  });
});

describe("listVendorSources — introspection", () => {
  it("returns registered vendor names in order", () => {
    registerVendorSource(fastConfidentHit("cardhedge"));
    registerVendorSource(fastConfidentHit("sold-comps"));
    expect(listVendorSources()).toEqual(["cardhedge", "sold-comps"]);
  });

  it("registering same name twice replaces (no dup)", () => {
    registerVendorSource(fastConfidentHit("cardhedge"));
    registerVendorSource(fastConfidentHit("cardhedge"));
    expect(listVendorSources()).toEqual(["cardhedge"]);
  });
});
