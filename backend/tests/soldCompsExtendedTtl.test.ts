// CF-SEASONALITY-EXTENDED-TTL (Drew, 2026-07-15) — pins the extended
// retention on sold_comps for historical / seasonality analysis.
//
// TTL controls how long records stay queryable. Engine's recency
// filter (applyRecencyFilter, 21d default) still trims stale comps
// out of FMV aggregation — TTL is for RETAINING the record so we can
// query it for chart / signal / YoY-comparison purposes.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Container } from "@azure/cosmos";

const ORIGINAL_TTL_ENV = process.env.SOLD_COMPS_TTL_YEARS;

function fakeContainer(): { container: Container; store: Map<string, any> } {
  const store = new Map<string, any>();
  const container = {
    items: {
      async upsert(doc: any) {
        store.set(`${doc.cardId}::${doc.id}`, doc);
        return { resource: doc };
      },
    },
  } as unknown as Container;
  return { container, store };
}

async function importStoreFresh() {
  // vitest holds modules in cache; use dynamic import + vi.resetModules
  // via the top-level vi if available. We use a query-string cache-bust
  // fallback since our module has no side-effectful init beyond reading
  // process.env at module-scope.
  const { vi } = await import("vitest");
  vi.resetModules();
  return await import("../src/services/portfolioiq/soldCompsStore.service.js");
}

afterEach(() => {
  if (ORIGINAL_TTL_ENV === undefined) delete process.env.SOLD_COMPS_TTL_YEARS;
  else process.env.SOLD_COMPS_TTL_YEARS = ORIGINAL_TTL_ENV;
});

describe("sold_comps extended TTL — default 5 years", () => {
  it("stamps 5-year TTL (157,680,000 sec) when env is unset", async () => {
    delete process.env.SOLD_COMPS_TTL_YEARS;
    const { recordSoldComp, _setContainerForTests } = await importStoreFresh();
    const f = fakeContainer();
    _setContainerForTests(f.container);
    await recordSoldComp({
      cardId: "cs-1", playerName: "Eric Hartman", price: 100,
      soldAt: "2026-07-15T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    const doc = Array.from(f.store.values())[0] as { ttl: number };
    expect(doc.ttl).toBe(5 * 365 * 24 * 3600);
  });
});

describe("sold_comps extended TTL — env override", () => {
  beforeEach(() => { /* per-test env set inline */ });

  it("honors SOLD_COMPS_TTL_YEARS=3 (3 years)", async () => {
    process.env.SOLD_COMPS_TTL_YEARS = "3";
    const { recordSoldComp, _setContainerForTests } = await importStoreFresh();
    const f = fakeContainer();
    _setContainerForTests(f.container);
    await recordSoldComp({
      cardId: "cs-1", playerName: "P", price: 100,
      soldAt: "2026-07-15T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    const doc = Array.from(f.store.values())[0] as { ttl: number };
    expect(doc.ttl).toBe(3 * 365 * 24 * 3600);
  });

  it("honors SOLD_COMPS_TTL_YEARS=-1 (no expiry)", async () => {
    process.env.SOLD_COMPS_TTL_YEARS = "-1";
    const { recordSoldComp, _setContainerForTests } = await importStoreFresh();
    const f = fakeContainer();
    _setContainerForTests(f.container);
    await recordSoldComp({
      cardId: "cs-1", playerName: "P", price: 100,
      soldAt: "2026-07-15T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    const doc = Array.from(f.store.values())[0] as { ttl: number };
    // Cosmos convention: ttl=-1 on a document means "no expiry" (the
    // container-level defaultTtl is also -1, so this is a no-op).
    expect(doc.ttl).toBe(-1);
  });

  it("falls back to default (5 years) on garbage env value", async () => {
    process.env.SOLD_COMPS_TTL_YEARS = "not-a-number";
    const { recordSoldComp, _setContainerForTests } = await importStoreFresh();
    const f = fakeContainer();
    _setContainerForTests(f.container);
    await recordSoldComp({
      cardId: "cs-1", playerName: "P", price: 100,
      soldAt: "2026-07-15T00:00:00Z", source: "ebay-user-purchase",
      sourceExternalId: "a",
    });
    const doc = Array.from(f.store.values())[0] as { ttl: number };
    expect(doc.ttl).toBe(5 * 365 * 24 * 3600);  // default
  });
});
