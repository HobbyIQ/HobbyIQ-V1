// CF-VENDOR-PRICING-CACHE (Drew, 2026-07-13) — verify the Cosmos-backed
// persistent cache round-trips resolutions correctly and TTL semantics
// hold. Uses a fake Container so tests don't require a real Cosmos.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Container } from "@azure/cosmos";
import {
  getCachedResolution,
  putCachedResolution,
  _setContainerForTests,
} from "../src/services/compiq/vendorPricingCache.service.js";
import type { CardResolution } from "../src/services/compiq/catalogResolver.service.js";

/** Minimal fake Container that mimics point-read + upsert. */
function makeFakeContainer(): {
  container: Container;
  store: Map<string, any>;
} {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
    },
    item(id: string, partitionKey: string) {
      return {
        async read() {
          const doc = store.get(`${partitionKey}::${id}`);
          if (!doc) {
            const err: any = new Error("not found");
            err.code = 404;
            throw err;
          }
          return { resource: doc };
        },
      };
    },
  } as unknown as Container;
  return { container, store };
}

const makeResolution = (over: Partial<CardResolution> = {}): CardResolution => ({
  vendor: "cardsight",
  cardId: "cs-abc",
  fairMarketValue: 1899.99,
  compCount: 1,
  freshestSaleDate: "2026-07-13",
  confidence: "high",
  ...over,
});

let store: Map<string, any>;
beforeEach(() => {
  const fake = makeFakeContainer();
  store = fake.store;
  _setContainerForTests(fake.container);
});
afterEach(() => {
  _setContainerForTests(null);
  vi.restoreAllMocks();
});

describe("vendorPricingCache — round trip", () => {
  it("put then get returns the same resolution", async () => {
    const r = makeResolution();
    await putCachedResolution("key:mookie-2020-prizm", r);
    const got = await getCachedResolution("key:mookie-2020-prizm", "cs-abc");
    expect(got).not.toBeNull();
    expect(got!.vendor).toBe("cardsight");
    expect(got!.fairMarketValue).toBe(1899.99);
  });

  it("get on unknown key returns null (not error)", async () => {
    const r = await getCachedResolution("key:never-written", "cs-x");
    expect(r).toBeNull();
  });

  it("null resolution is cached (prevents vendor DoS on repeated missing-card queries)", async () => {
    await putCachedResolution("key:missing-card", null);
    // partition key for null resolutions is "no-cardId"
    const r = await getCachedResolution("key:missing-card", null);
    expect(r).toBeNull();
    // But the DOC exists — a subsequent resolveCard would see the entry
    // and skip vendor calls. Verify by checking the store directly.
    expect(store.has("no-cardId::key:missing-card")).toBe(true);
  });
});

describe("vendorPricingCache — TTL enforcement", () => {
  it("expired doc returns null even when Cosmos still has it (belt-and-suspenders)", async () => {
    // Manually insert a doc with an old cachedAt + short TTL so it's expired.
    const doc = {
      id: "key:expired",
      cardId: "cs-old",
      resolution: makeResolution(),
      cachedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),   // 24h ago
      ttl: 60,   // 60 sec TTL
    };
    store.set("cs-old::key:expired", doc);
    const r = await getCachedResolution("key:expired", "cs-old");
    expect(r).toBeNull();
  });

  it("fresh doc within TTL returns the resolution", async () => {
    const doc = {
      id: "key:fresh",
      cardId: "cs-fresh",
      resolution: makeResolution(),
      cachedAt: new Date().toISOString(),   // now
      ttl: 24 * 3600,
    };
    store.set("cs-fresh::key:fresh", doc);
    const r = await getCachedResolution("key:fresh", "cs-fresh");
    expect(r).not.toBeNull();
  });
});

describe("vendorPricingCache — no-op when config absent", () => {
  it("get returns null when container is null (Cosmos not configured)", async () => {
    _setContainerForTests(null);
    // Force init to no-op by clearing env
    const prev = process.env.COSMOS_ENDPOINT;
    const prevConn = process.env.COSMOS_CONNECTION_STRING;
    delete process.env.COSMOS_ENDPOINT;
    delete process.env.COSMOS_CONNECTION_STRING;
    try {
      const r = await getCachedResolution("key:no-config", null);
      expect(r).toBeNull();
    } finally {
      if (prev) process.env.COSMOS_ENDPOINT = prev;
      if (prevConn) process.env.COSMOS_CONNECTION_STRING = prevConn;
    }
  });
});
