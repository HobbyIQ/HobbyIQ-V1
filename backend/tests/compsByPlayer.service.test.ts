/**
 * Phase 1 MCP rewire — unit tests for compsByPlayer.service.fetchCompsByPlayer.
 * Mocks cardsight.client (searchCatalog, getPricing) + cache.service so tests
 * are deterministic and never touch the network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", () => ({
  searchCatalog: vi.fn(),
  getPricing: vi.fn(),
  getCardDetail: vi.fn(),
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

import * as cs from "../src/services/compiq/cardsight.client.js";
import {
  fetchCompsByPlayer,
  warmCompsByPlayerCache,
  __compsByPlayerInternals,
} from "../src/services/compiq/compsByPlayer.service";

type Catalog = Awaited<ReturnType<typeof cs.searchCatalog>>[number];
type Pricing = Awaited<ReturnType<typeof cs.getPricing>>;

function catalog(id: string, releaseName: string, setName = "Base Set", year = 2017): Catalog {
  return { id, name: `card-${id}`, number: "", releaseName, setName, year };
}

function pricingWithRecords(
  totalRecords: number,
  records: Array<{ title: string; price: number; date: string }> = [],
): Pricing {
  return {
    raw: {
      count: totalRecords,
      records: records.map((r) => ({
        title: r.title,
        price: r.price,
        date: r.date,
        source: "ebay",
        url: null,
      })),
    },
    graded: [],
    meta: { total_records: totalRecords, last_sale_date: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __memoryCache.clear();
});

describe("fetchCompsByPlayer — happy path aggregation", () => {
  it("Mike Trout + Topps Update + year=2011 → aggregated comps with cardId attached", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("trout-tu-base", "Topps Update", "Base Set", 2011),
    ]);
    (cs.getPricing as any).mockResolvedValue(
      pricingWithRecords(2, [
        { title: "2011 Topps Update Trout RC #US175", price: 310, date: "2026-05-20T12:00:00Z" },
        { title: "2011 Topps Update Trout RC #US175 PSA", price: 295, date: "2026-05-15T08:00:00Z" },
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
    expect(r.comps[0].source).toBe("cardsight");
    expect(r.cached).toBe(false);
    expect(r.cacheAge).toBeUndefined();
    // Sorted desc by date
    expect(r.comps[0].date.localeCompare(r.comps[1].date)).toBeGreaterThan(0);
  });

  it("Aaron Judge + Topps Update + year=2017 → product narrowing recovers buried RC (Q1 case)", async () => {
    // Q1 finding: searchCatalog("Aaron Judge", year=2017) returns 50 candidates
    // with no Topps Update Base in top 50. With product narrowing, the query
    // becomes "Aaron Judge Topps Update" and the RC surfaces at position 4.
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("bowman-chrome-1", "Bowman Chrome", "Base", 2017),
      catalog("bowman-1", "Bowman", "Base", 2017),
      catalog("finest-1", "Finest", "Base", 2017),
      catalog("judge-tu-base", "Topps Update", "Base Set", 2017),
      catalog("donruss-1", "Donruss", "Base", 2017),
    ]);
    (cs.getPricing as any).mockResolvedValue(
      pricingWithRecords(1, [
        { title: "2017 Topps Update Judge RC #US87", price: 75, date: "2026-05-19T00:00:00Z" },
      ]),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Aaron Judge",
      product: "Topps Update",
      cardYear: 2017,
    });

    // Release filter narrows from 5 candidates to 1 (only judge-tu-base has releaseName=Topps Update)
    expect(r.cardIds).toEqual(["judge-tu-base"]);
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].cardId).toBe("judge-tu-base");
  });

  it("multi-candidate aggregation: dedupes same sale appearing under multiple cardIds", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("dup-a", "Topps Update"),
      catalog("dup-b", "Topps Update"),
    ]);
    // dup-a and dup-b both report the same sale + one unique each
    (cs.getPricing as any).mockImplementation((id: string) => {
      const shared = { title: "shared sale", price: 100, date: "2026-05-20T00:00:00Z" };
      if (id === "dup-a") {
        return Promise.resolve(pricingWithRecords(2, [
          shared,
          { title: "dup-a-unique", price: 50, date: "2026-05-19T00:00:00Z" },
        ]));
      }
      return Promise.resolve(pricingWithRecords(2, [
        shared,
        { title: "dup-b-unique", price: 60, date: "2026-05-18T00:00:00Z" },
      ]));
    });

    const r = await fetchCompsByPlayer({ playerName: "Player X", product: "Topps Update" });

    expect(r.cardIds).toHaveLength(2);
    expect(r.comps).toHaveLength(3); // 1 shared + 2 unique (dedup removed the second occurrence of shared)
    const titles = r.comps.map((c) => c.title).sort();
    expect(titles).toEqual(["dup-a-unique", "dup-b-unique", "shared sale"]);
  });

  it("partial pricing failure: tolerates getPricing rejection, returns the successful card's comps", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("ok-1", "Topps Update"),
      catalog("err-1", "Topps Update"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      if (id === "ok-1") {
        return Promise.resolve(pricingWithRecords(1, [
          { title: "ok sale", price: 200, date: "2026-05-20T00:00:00Z" },
        ]));
      }
      return Promise.reject(new Error("upstream 503"));
    });

    const r = await fetchCompsByPlayer({ playerName: "Player Y", product: "Topps Update" });

    expect(r.cardIds).toEqual(["ok-1"]); // err-1 omitted
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].cardId).toBe("ok-1");
  });
});

describe("fetchCompsByPlayer — setName Chrome fallback (Bonemer pre-merge finding)", () => {
  it("Bonemer 2024 Bowman Draft Chrome: narrows to setName containing 'Chrome' when releaseName exact-match misses", async () => {
    // Cardsight encodes Bonemer's chrome variant as releaseName="Bowman Draft"
    // + setName="Chrome Prospect Autographs". Exact-match on
    // releaseName="Bowman Draft Chrome" yields zero, so the fallback narrows
    // by setName containing "Chrome" — picks the CPA-CBO card, NOT the
    // BD-31 Base Set card.
    (cs.searchCatalog as any).mockResolvedValue([
      {
        id: "bonemer-base",
        name: "Caleb Bonemer",
        number: "BD-31",
        releaseName: "Bowman Draft",
        setName: "Base Set",
        year: 2024,
      },
      {
        id: "bonemer-chrome-auto",
        name: "Caleb Bonemer",
        number: "CPA-CBO",
        releaseName: "Bowman Draft",
        setName: "Chrome Prospect Autographs",
        year: 2024,
      },
    ]);
    (cs.getPricing as any).mockImplementation((id: string) =>
      Promise.resolve(
        pricingWithRecords(1, [
          { title: `sale-${id}`, price: 100, date: "2026-05-20T00:00:00Z" },
        ]),
      ),
    );

    const r = await fetchCompsByPlayer({
      playerName: "Caleb Bonemer",
      product: "Bowman Draft Chrome",
      cardYear: 2024,
    });

    expect(r.cardIds).toEqual(["bonemer-chrome-auto"]);
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].cardId).toBe("bonemer-chrome-auto");
    expect(
      r.warnings.some((w) => w.includes('setName containing "Chrome"')),
    ).toBe(true);
  });

  it("setName Chrome fallback does NOT fire for non-Chrome products", async () => {
    // Mike Trout 2011 Topps Update — product doesn't contain "Chrome", so
    // even if releaseName exact-match misses (e.g., catalog returns a
    // different releaseName variant), the fallback is skipped and the code
    // falls through to top-K aggregation.
    (cs.searchCatalog as any).mockResolvedValue([
      { id: "weird-id", name: "?", number: "?", releaseName: "Topps Series 2", setName: "Base Set", year: 2011 },
    ]);
    (cs.getPricing as any).mockResolvedValue(pricingWithRecords(0));

    const r = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });

    // Falls through to top-K (the single weird candidate)
    expect(r.cardIds).toEqual(["weird-id"]);
    expect(r.warnings.some((w) => w.includes("aggregating top-ranked"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("Chrome"))).toBe(false);
  });
});

describe("fetchCompsByPlayer — filtering + warnings", () => {
  it("releases match filter fall-through: warns when product not in dictionary", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("legacy-1", "Some Obscure Release"),
    ]);
    (cs.getPricing as any).mockResolvedValue(pricingWithRecords(0));

    const r = await fetchCompsByPlayer({
      playerName: "Player Z",
      product: "Made Up Brand",
    });

    expect(r.warnings.some((w) => w.includes("not in Cardsight release dictionary"))).toBe(true);
  });

  it("grade filter applies: gradeCompany + gradeValue routes through translateResponse graded path", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("graded-1", "Topps Update")]);
    (cs.getPricing as any).mockResolvedValue({
      raw: { count: 0, records: [] },
      graded: [
        {
          company_name: "PSA",
          grades: [
            {
              grade_value: "10",
              count: 1,
              records: [
                { title: "PSA 10 Trout", price: 1500, date: "2026-05-15T00:00:00Z", source: "ebay", url: null },
              ],
            },
            {
              grade_value: "9",
              count: 1,
              records: [
                { title: "PSA 9 Trout", price: 800, date: "2026-05-10T00:00:00Z", source: "ebay", url: null },
              ],
            },
          ],
        },
      ],
      meta: { total_records: 2, last_sale_date: null },
    });

    const r = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
      gradeCompany: "PSA",
      gradeValue: "10",
    });

    expect(r.comps).toHaveLength(1);
    expect(r.comps[0].price).toBe(1500);
    expect(r.comps[0].title).toBe("PSA 10 Trout");
  });

  it("empty catalog: returns empty comps + warning, NOT cached", async () => {
    (cs.searchCatalog as any).mockResolvedValue([]);

    const r = await fetchCompsByPlayer({
      playerName: "Made Up Player",
      product: "Topps Update",
    });

    expect(r.cardIds).toEqual([]);
    expect(r.comps).toEqual([]);
    expect(r.cached).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);

    // Verify NOT cached — second call should re-hit catalog (mock counter increments)
    await fetchCompsByPlayer({ playerName: "Made Up Player", product: "Topps Update" });
    expect((cs.searchCatalog as any).mock.calls.length).toBe(2);
  });
});

describe("fetchCompsByPlayer — cache behavior", () => {
  it("cache hit: second call returns cached=true with cacheAge populated; no upstream calls", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c-1", "Topps Update")]);
    (cs.getPricing as any).mockResolvedValue(
      pricingWithRecords(1, [
        { title: "sale", price: 50, date: "2026-05-20T00:00:00Z" },
      ]),
    );

    const first = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    expect(first.cached).toBe(false);

    const callsAfterFirst = (cs.searchCatalog as any).mock.calls.length;

    const second = await fetchCompsByPlayer({
      playerName: "Mike Trout",
      product: "Topps Update",
      cardYear: 2011,
    });
    expect(second.cached).toBe(true);
    expect(second.cacheAge).toBeGreaterThanOrEqual(0);
    expect(second.comps).toEqual(first.comps);
    // No new upstream calls
    expect((cs.searchCatalog as any).mock.calls.length).toBe(callsAfterFirst);
  });

  it("cache key sensitivity: different query params produce different keys", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c-1", "Topps Update")]);
    (cs.getPricing as any).mockResolvedValue(pricingWithRecords(0));

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
});

describe("warmCompsByPlayerCache", () => {
  it("warms all CACHE_WARM_TARGETS sequentially (not parallel) and reports results", async () => {
    // Per defect #13 v2: warming must be serialized, NOT Promise.all'd.
    // Verify by tracking the order of searchCatalog calls — they must complete
    // before the next starts. Each call resolves on a short delay; if running
    // in parallel, the call count would jump ahead of the resolved count.
    let inFlight = 0;
    let maxInFlight = 0;
    (cs.searchCatalog as any).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [catalog("warmed-1", "Topps Update")];
    });
    (cs.getPricing as any).mockResolvedValue(
      pricingWithRecords(1, [{ title: "x", price: 1, date: "2026-05-20T00:00:00Z" }]),
    );

    await warmCompsByPlayerCache();

    expect(maxInFlight).toBe(1); // serialized — never more than one concurrent
    expect((cs.searchCatalog as any).mock.calls.length).toBe(
      __compsByPlayerInternals.CACHE_WARM_TARGETS.length,
    );
  });
});
