// CF-QUERY-SOLD-COMPS-FAILS-CLOSED (2026-08-29, checklist D12a §8).
//
// querySoldComps walks every user's ledger. A failed user-doc read was
// swallowed (`catch { continue }`), so a Cosmos error came back as fewer —
// or zero — comps: the caller priced from nothing as if the pool were empty,
// the sold-comps vendor source turned the error into null ("no comps"), and
// the resolver cached that null for the card. A pool that could not be read
// is not an empty pool. Now: the query throws SoldCompsQueryError, the
// vendor source propagates it, and the resolver neither treats the error as
// an answer nor caches the null it reached through it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/portfolioiq/portfolioStore.service.js", () => ({
  listAllPortfolioUserIds: vi.fn(),
  readUserDoc: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  put: vi.fn(async () => undefined),
}));
vi.mock("../src/services/compiq/vendorPricingCache.service.js", () => ({
  getCachedResolution: cache.get,
  putCachedResolution: cache.put,
}));

import {
  querySoldComps,
  SoldCompsQueryError,
  isSoldCompsQueryError,
} from "../src/services/portfolioiq/ebaySoldComps.service.js";
import * as store from "../src/services/portfolioiq/portfolioStore.service.js";
import { soldCompsVendorSource } from "../src/services/compiq/soldCompsVendorSource.js";
import {
  resolveCard,
  registerVendorSource,
  _resetVendorRegistryForTests,
  _clearResolverCacheForTests,
  type CardQuery,
} from "../src/services/compiq/catalogResolver.service.js";

function sale(overrides: Record<string, unknown> = {}) {
  return {
    id: "l-1",
    userId: "u-1",
    holdingId: "h-1",
    playerName: "Mookie Betts",
    cardTitle: "2020 Panini Prizm Mookie Betts",
    quantitySold: 1,
    unitSalePrice: 250,
    grossProceeds: 250, fees: 0, tax: 0, shipping: 0, netProceeds: 225,
    costBasisSold: 100, realizedProfitLoss: 125, realizedProfitLossPct: 125,
    soldAt: "2026-06-01T00:00:00Z",
    source: "ebay",
    ebayOrderId: "o-1",
    ebayItemAspects: { Player: "Mookie Betts", Season: "2020", Set: "Panini Prizm", "Card Number": "275", "Parallel/Variety": "Silver", Autographed: "No" },
    ...overrides,
  };
}

/** Two users: u-1 readable with one sale, u-2 whose doc read FAILS. */
function onePoolOneOutage(): void {
  vi.mocked(store.listAllPortfolioUserIds).mockResolvedValue(["u-1", "u-2"]);
  vi.mocked(store.readUserDoc).mockImplementation(async (uid: string) => {
    if (uid === "u-2") throw new Error("Cosmos: 503 service unavailable");
    return { userId: uid, holdings: {}, ledger: [sale()] } as never;
  });
}

const query: CardQuery = { playerName: "Mookie Betts", cardYear: 2020, setName: "Panini Prizm" } as unknown as CardQuery;
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  vi.mocked(store.listAllPortfolioUserIds).mockReset();
  vi.mocked(store.readUserDoc).mockReset();
  cache.get.mockClear();
  cache.put.mockClear();
  _resetVendorRegistryForTests();
  _clearResolverCacheForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("querySoldComps throws a typed error instead of returning a partial pool", () => {
  it("a failed user-doc read throws SoldCompsQueryError — the readable user's sales are NOT returned as the whole pool", async () => {
    onePoolOneOutage();
    // Mutation check: the pre-fix loop `continue`d and resolved with count 1.
    const err = await querySoldComps({}).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SoldCompsQueryError);
    expect(isSoldCompsQueryError(err)).toBe(true);
    expect((err as SoldCompsQueryError).stage).toBe("read-user-doc");
    expect((err as SoldCompsQueryError).userId).toBe("u-2");
    expect((err as SoldCompsQueryError).code).toBe("SOLD_COMPS_QUERY_FAILED");
    expect((err as Error).message).toMatch(/503/);
  });

  it("a failed user listing throws at stage list-users", async () => {
    vi.mocked(store.listAllPortfolioUserIds).mockRejectedValue(new Error("Cosmos: 429"));
    const err = await querySoldComps({}).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SoldCompsQueryError);
    expect((err as SoldCompsQueryError).stage).toBe("list-users");
    expect((err as SoldCompsQueryError).userId).toBeNull();
  });

  it("a readable pool still answers", async () => {
    vi.mocked(store.listAllPortfolioUserIds).mockResolvedValue(["u-1"]);
    vi.mocked(store.readUserDoc).mockResolvedValue({ userId: "u-1", holdings: {}, ledger: [sale()] } as never);
    const r = await querySoldComps({ playerName: "Mookie" });
    expect(r.count).toBe(1);
  });
});

describe("soldCompsVendorSource propagates the error", () => {
  it("resolveCard rejects with the typed error instead of answering null", async () => {
    onePoolOneOutage();
    // Mutation check: the pre-fix source caught everything and returned null.
    const err = await soldCompsVendorSource.resolveCard(query).then(() => null, (e: unknown) => e);
    expect(isSoldCompsQueryError(err)).toBe(true);
  });
});

describe("catalogResolver does not cache a null reached through a source error", () => {
  it("a throwing source yields winner null, sourceErrors 1, and NO cache write", async () => {
    registerVendorSource({
      name: "sold-comps",
      resolveCard: async () => { throw new SoldCompsQueryError("read-user-doc", "u-2", new Error("cosmos")); },
    });
    const r = await resolveCard(query);
    expect(r.winner).toBeNull();
    expect(r.sourceErrors).toBe(1);
    await settle();
    // Mutation check: the pre-fix tail wrote the null through unconditionally.
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("a source that answers null without error is still cached as null — a genuinely missing card", async () => {
    registerVendorSource({ name: "sold-comps", resolveCard: async () => null });
    const r = await resolveCard(query);
    expect(r.winner).toBeNull();
    expect(r.sourceErrors).toBe(0);
    await settle();
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0][1]).toBeNull();
  });
});
