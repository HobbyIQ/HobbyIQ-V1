/**
 * Unit tests for compsByPlayer.service.fetchCompsByPlayer (CardHedge-only edition).
 *
 * Mocks cardhedge.client (searchCards, getTrustedComps) + cache.service so tests
 * are deterministic and never touch the network.
 *
 * Phase 2 of the Cardsight removal arc replaced the Cardsight-direct flow
 * (searchCatalog + getPricing + translateResponse) with CH searchCards +
 * trust-guarded getTrustedComps. The aggregate contract (CompsByPlayerResponse)
 * is byte-compatible apart from `source: "cardsight"` -> `source: "cardhedge"`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
  getTrustedComps: vi.fn(),
}));

// In-memory cache mock so each test starts clean and we can observe cache
// behavior without touching Redis.
const __memoryCache = new Map<string, { value: string; expiresAt: number }>();
vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => {
    const hit = __memoryCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      __memoryCache.delete(key);
      return null;
    }
    return hit.value;
  }),
  cacheSet: vi.fn(async (key: string, value: string, ttlSeconds: number) => {
    __memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }),
  cacheWrap: vi.fn(),
  isRedisReady: vi.fn(async () => false),
}));

import * as ch from "../src/services/compiq/cardhedge.client.js";
import {
  fetchCompsByPlayer,
  warmCompsByPlayerCache,
  __compsByPlayerInternals,
} from "../src/services/compiq/compsByPlayer.service";

type CHCard = Awaited<ReturnType<typeof ch.searchCards>>[number];
type CHTrusted = Awaited<ReturnType<typeof ch.getTrustedComps>>;
type CHSale = CHTrusted["comps"][number];

function chCard(
  cardId: string,
  opts: Partial<Omit<CHCard, "card_id">> = {},
): CHCard {
  return {
    card_id: cardId,
    player: opts.player ?? "Test Player",
    set: opts.set ?? "Topps Update",
    year: opts.year ?? 2017,
    number: opts.number ?? "US1",
    variant: opts.variant ?? "Base",
    title: opts.title ?? `${opts.year ?? 2017} ${opts.set ?? "Topps Update"} ${cardId}`,
    ...opts,
  };
}

function chSale(
  title: string,
  price: number,
  date: string,
  grade = "Raw",
): CHSale {
  return { title, price, date, grade, source: "ebay", sale_type: null, url: null };
}

function trustedComps(sales: CHSale[]): CHTrusted {
  return {
    trusted: true,
    reason: "prices_by_card_honest",
    comps: sales,
    median: sales.length ? sales[Math.floor(sales.length / 2)].price : null,
    count: sales.length,
    newestDate: sales.length ? sales[0].date : null,
    pricesByCardLength: Math.max(1, sales.length),
  };
}

function rejectedTrust(reason: CHTrusted["reason"] = "no_real_data"): CHTrusted {
  return {
    trusted: false,
    reason,
    comps: [],
    median: null,
    count: 0,
    newestDate: null,
    pricesByCardLength: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __memoryCache.clear();
});

describe("fetchCompsByPlayer — happy path aggregation", () => {
  it("Mike Trout + Topps Update + year=2011 → aggregated comps with cardId attached and source=cardhedge", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("trout-tu-base", { year: 2011, set: "Topps Update" }),
    ]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([
        chSale("2011 Topps Update Trout RC #US175", 310, "2026-05-20T12:00:00Z"),
        chSale("2011 Topps Update Trout RC #US175", 295, "2026-05-15T08:00:00Z"),
      ]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });

    expect(r.player).toBe("Mike Trout");
    expect(r.product).toBe("Topps Update");
    expect(r.cardYear).toBe(2011);
    expect(r.cardIds).toEqual(["trout-tu-base"]);
    expect(r.comps).toHaveLength(2);
    expect(r.comps[0].cardId).toBe("trout-tu-base");
    expect(r.comps[0].source).toBe("cardhedge");
    expect(r.cached).toBe(false);
    expect(r.cacheAge).toBeUndefined();
    // Sorted desc by date
    expect(r.comps[0].date.localeCompare(r.comps[1].date)).toBeGreaterThan(0);
  });

  it("year filter discards candidates from other years", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("judge-tu-2017", { year: 2017, set: "Topps Update" }),
      chCard("judge-tu-2019", { year: 2019, set: "Topps Update" }),
      chCard("judge-tu-2020", { year: 2020, set: "Topps Update" }),
    ]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("2017 Topps Update Judge RC #US87", 75, "2026-05-19T00:00:00Z")]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Aaron Judge",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toEqual(["judge-tu-2017"]);
    expect(r.comps).toHaveLength(1);
    // Only the year=2017 candidate should have been probed for trust.
    expect((ch.getTrustedComps as any).mock.calls).toHaveLength(1);
    expect((ch.getTrustedComps as any).mock.calls[0][0]).toBe("judge-tu-2017");
  });

  it("product filter discards candidates whose set/title don't contain the product", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("trout-tu", { year: 2011, set: "Topps Update" }),
      chCard("trout-bowman", { year: 2011, set: "Bowman Chrome" }),
      chCard("trout-finest", { year: 2011, set: "Finest" }),
    ]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("sale", 100, "2026-05-20T00:00:00Z")]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });

    expect(r.cardIds).toEqual(["trout-tu"]);
  });

  it("multi-candidate aggregation: dedupes same sale appearing under multiple cardIds", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("dup-a"),
      chCard("dup-b"),
    ]);
    (ch.getTrustedComps as any).mockImplementation((id: string) => {
      const shared = chSale("shared sale", 100, "2026-05-20T00:00:00Z");
      if (id === "dup-a") {
        return Promise.resolve(
          trustedComps([shared, chSale("dup-a-unique", 50, "2026-05-19T00:00:00Z")]),
        );
      }
      return Promise.resolve(
        trustedComps([shared, chSale("dup-b-unique", 60, "2026-05-18T00:00:00Z")]),
      );
    });

    const r = await fetchCompsByPlayer({
      playerName: "Player X",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toHaveLength(2);
    // 1 shared (deduped) + 2 unique
    expect(r.comps).toHaveLength(3);
    const titles = r.comps.map((c) => c.title).sort();
    expect(titles).toEqual(["dup-a-unique", "dup-b-unique", "shared sale"]);
  });

  it("partial trust failure: tolerates getTrustedComps rejection, returns the successful card's comps", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("ok-1"),
      chCard("err-1"),
    ]);
    (ch.getTrustedComps as any).mockImplementation((id: string) => {
      if (id === "ok-1") {
        return Promise.resolve(
          trustedComps([chSale("ok sale", 200, "2026-05-20T00:00:00Z")]),
        );
      }
      return Promise.reject(new Error("upstream 503"));
    });

    const r = await fetchCompsByPlayer({
      playerName: "Player Y",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toEqual(["ok-1"]);
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].cardId).toBe("ok-1");
  });
});

describe("fetchCompsByPlayer — trust-guard behavior", () => {
  it("trust-rejected candidates are silently dropped from cardIds + comps", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("trusted-1"),
      chCard("blob-1"),
      chCard("no-data-1"),
    ]);
    (ch.getTrustedComps as any).mockImplementation((id: string) => {
      if (id === "trusted-1") {
        return Promise.resolve(
          trustedComps([chSale("real sale", 99, "2026-05-20T00:00:00Z")]),
        );
      }
      if (id === "blob-1") return Promise.resolve(rejectedTrust("blob_signature"));
      return Promise.resolve(rejectedTrust("no_real_data"));
    });

    const r = await fetchCompsByPlayer({
      playerName: "Player Z",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toEqual(["trusted-1"]);
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].source).toBe("cardhedge");
  });

  it("all candidates trust-rejected → empty cardIds + comps (NOT cached)", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("blob-1"),
      chCard("blob-2"),
    ]);
    (ch.getTrustedComps as any).mockResolvedValue(rejectedTrust("blob_signature"));

    const r = await fetchCompsByPlayer({
      playerName: "Made Up Player",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toEqual([]);
    expect(r.comps).toEqual([]);

    // Verify NOT cached — second call should re-hit upstream.
    await fetchCompsByPlayer({
      playerName: "Made Up Player",
      product: "Topps Update",
      cardYear: 2017,
    });
    expect((ch.searchCards as any).mock.calls.length).toBe(2);
  });
});

describe("fetchCompsByPlayer — filtering + warnings", () => {
  it("year+product filter empties pool → falls through to top-K with warning", async () => {
    (ch.searchCards as any).mockResolvedValue([
      chCard("c-wrong-year", { year: 2019, set: "Topps Update" }),
      chCard("c-wrong-set", { year: 2017, set: "Bowman Chrome" }),
    ]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("fallback sale", 1, "2026-05-20T00:00:00Z")]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Player W",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.warnings.some((w) => w.includes("aggregating top-ranked"))).toBe(true);
    // Both candidates probed because the filter empties + falls through.
    expect((ch.getTrustedComps as any).mock.calls.length).toBe(2);
  });

  it("grade query is forwarded to getTrustedComps", async () => {
    (ch.searchCards as any).mockResolvedValue([chCard("graded-1")]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("PSA 10 Trout", 1500, "2026-05-15T00:00:00Z", "PSA 10")]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      gradeCompany: "PSA",
      gradeValue: "10",
    });

    expect(r.comps).toHaveLength(1);
    expect((ch.getTrustedComps as any).mock.calls[0][2]).toBe("PSA 10");
  });

  it("empty search: returns empty comps + warning, NOT cached", async () => {
    (ch.searchCards as any).mockResolvedValue([]);

    const r = await fetchCompsByPlayer({
      playerName: "Made Up Player",
      product: "Topps Update",
      cardYear: 2017,
    });

    expect(r.cardIds).toEqual([]);
    expect(r.comps).toEqual([]);
    expect(r.cached).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);

    // Verify NOT cached — second call should re-hit upstream.
    await fetchCompsByPlayer({
      playerName: "Made Up Player",
      product: "Topps Update",
      cardYear: 2017,
    });
    expect((ch.searchCards as any).mock.calls.length).toBe(2);
  });
});

describe("fetchCompsByPlayer — cache behavior", () => {
  it("cache hit: second call returns cached=true with cacheAge populated; no upstream calls", async () => {
    (ch.searchCards as any).mockResolvedValue([chCard("c-1", { year: 2011 })]);
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("sale", 50, "2026-05-20T00:00:00Z")]),
    );

    const first = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    expect(first.cached).toBe(false);

    const callsAfterFirst = (ch.searchCards as any).mock.calls.length;

    const second = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    expect(second.cached).toBe(true);
    expect(second.cacheAge).toBeGreaterThanOrEqual(0);
    expect(second.comps).toEqual(first.comps);
    expect((ch.searchCards as any).mock.calls.length).toBe(callsAfterFirst);
  });

  it("cache key sensitivity: different query params produce different keys", async () => {
    const baseInput = {
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    };
    const k1 = __compsByPlayerInternals.buildCacheKey(baseInput);
    const k2 = __compsByPlayerInternals.buildCacheKey({ ...baseInput, cardYear: 2012 });
    const k3 = __compsByPlayerInternals.buildCacheKey({ ...baseInput, gradeCompany: "PSA" });
    const k4 = __compsByPlayerInternals.buildCacheKey({ ...baseInput, parallel: "Refractor" });
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
  });

  it("cache key normalization: case-insensitive + whitespace-trimmed", async () => {
    const k1 = __compsByPlayerInternals.buildCacheKey({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    const k2 = __compsByPlayerInternals.buildCacheKey({
      playerName: "  mike   trout  ",
      product: "TOPPS UPDATE",
      cardYear: 2011,
    });
    expect(k1).toBe(k2);
  });

  it("cache key version is v2 (vendor changed from Cardsight to CardHedge)", async () => {
    const k = __compsByPlayerInternals.buildCacheKey({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    expect(k.startsWith("compsByPlayer:v2|")).toBe(true);
  });
});

describe("warmCompsByPlayerCache", () => {
  it("warms all CACHE_WARM_TARGETS sequentially (not parallel)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    (ch.searchCards as any).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [chCard("warmed-1", { year: 2011 })];
    });
    (ch.getTrustedComps as any).mockResolvedValue(
      trustedComps([chSale("x", 1, "2026-05-20T00:00:00Z")]),
    );

    await warmCompsByPlayerCache();

    expect(maxInFlight).toBe(1);
    expect((ch.searchCards as any).mock.calls.length).toBe(
      __compsByPlayerInternals.CACHE_WARM_TARGETS.length,
    );
  });
});
