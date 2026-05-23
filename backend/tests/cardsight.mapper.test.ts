/**
 * Phase 1 CH-removal-v2 regression tests for cardsight.mapper.resolveCardId.
 * Covers defects #1 (blind candidates[0]) and #5 (catalog duplicates with
 * empty pricing siblings) per docs/phase0/ch_removal_v2_plan.md commit 8d6d769.
 *
 * Tests run against mocked cardsight.client; no live network. See
 * cardsight.router.test.ts for the routing-mode integration coverage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/compiq/cardsight.client.js", () => ({
  searchCatalog: vi.fn(),
  getCardDetail: vi.fn(),
  getPricing: vi.fn(),
}));

import * as cs from "../src/services/compiq/cardsight.client.js";
import {
  resolveCardId,
  warmResolveCardIdCache,
  __resolveCardIdInternals,
} from "../src/services/compiq/cardsight.mapper";

type Catalog = Awaited<ReturnType<typeof cs.searchCatalog>>[number];
type Detail = Awaited<ReturnType<typeof cs.getCardDetail>>;
type Pricing = Awaited<ReturnType<typeof cs.getPricing>>;

function catalog(id: string, releaseName: string, setName = "Base Set", year = "2017"): Catalog {
  return { id, name: "x", number: "", releaseName, setName, year: Number(year) };
}

function detail(id: string, number: string, parallels: Detail["parallels"] = []): Detail {
  return {
    id,
    name: "x",
    number,
    releaseName: "Topps Update",
    setName: "Base Set",
    year: 2017,
    parallels,
  };
}

function pricing(totalRecords: number): Pricing {
  return {
    raw: { count: totalRecords, records: [] },
    graded: [],
    meta: { total_records: totalRecords, last_sale_date: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resolveCardIdInternals.clearCache();
});

describe("resolveCardId — defect #1 (single candidate picked) + defect #5 (catalog duplicates)", () => {
  it("picks the single candidate when release filter narrows to one — no pricing probe", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("bowman-1", "Bowman", "Topps 100"),
      catalog("topps-update-1", "Topps Update", "Base Set"),
      catalog("finest-1", "Finest", "Base Set"),
    ]);

    const r = await resolveCardId({ playerName: "Player X", cardYear: 2017, product: "topps update" });

    expect(r.cardId).toBe("topps-update-1");
    expect(r.matchConfidence).toBe("exact");
    expect(cs.getPricing).not.toHaveBeenCalled();
    expect(cs.getCardDetail).not.toHaveBeenCalled();
  });

  it("picks the highest-records candidate when multiple data-bearing siblings exist", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("dup-1", "Topps Update"),
      catalog("dup-2", "Topps Update"),
      catalog("dup-3", "Topps Update"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "dup-1": 75, "dup-2": 295, "dup-3": 165 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });

    const r = await resolveCardId({ playerName: "Player X", cardYear: 2017, product: "topps update" });

    expect(r.cardId).toBe("dup-2");
    expect(r.matchConfidence).toBe("likely");
    expect(cs.getPricing).toHaveBeenCalledTimes(3);
    expect(r.warnings.some((w) => w.includes("3 candidates have pricing data"))).toBe(true);
  });

  it("skips empty siblings and picks the only data-bearing candidate (defect #5 core)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("empty-1", "Topps Update"),
      catalog("data-bearing", "Topps Update"),
      catalog("empty-2", "Topps Update"),
    ]);
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "data-bearing": 600 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });

    const r = await resolveCardId({ playerName: "Mike Trout", cardYear: 2011, product: "topps update" });

    expect(r.cardId).toBe("data-bearing");
    expect(r.matchConfidence).toBe("exact"); // exactly one had data
  });

  it("falls back to candidates[0] (with warning) when all top-3 are empty", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("empty-1", "Topps Update"),
      catalog("empty-2", "Topps Update"),
      catalog("empty-3", "Topps Update"),
    ]);
    (cs.getPricing as any).mockResolvedValue(pricing(0));

    const r = await resolveCardId({ playerName: "Player Z", cardYear: 2017, product: "topps update" });

    expect(r.cardId).toBe("empty-1");
    expect(r.matchConfidence).toBe("likely");
    expect(r.warnings.some((w) => w.includes("zero pricing data"))).toBe(true);
  });

  it("returns null when catalog search returns zero results", async () => {
    (cs.searchCatalog as any).mockResolvedValue([]);

    const r = await resolveCardId({ playerName: "Fake Player", cardYear: 2099, product: "topps update" });

    expect(r.cardId).toBe(null);
    expect(r.matchConfidence).toBe("none");
    expect(cs.getPricing).not.toHaveBeenCalled();
  });
});

describe("resolveCardId — cardNumber disambiguation via detail probe", () => {
  it("narrows duplicate candidates by detail.number when cardNumber provided", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("dup-a", "Topps Update"),
      catalog("dup-b", "Topps Update"),
      catalog("dup-c", "Topps Update"),
    ]);
    (cs.getCardDetail as any).mockImplementation((id: string) => {
      const num = { "dup-a": "US100", "dup-b": "US175", "dup-c": "US200" }[id] ?? "?";
      return Promise.resolve(detail(id, num));
    });

    const r = await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "topps update",
      cardNumber: "US175",
    });

    expect(r.cardId).toBe("dup-b");
    expect(cs.getCardDetail).toHaveBeenCalledTimes(3);
    // After number narrowing to 1, pricing probe should NOT fire
    expect(cs.getPricing).not.toHaveBeenCalled();
  });

  it("falls back to pricing probe when cardNumber matches no candidate detail", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("dup-a", "Topps Update"),
      catalog("dup-b", "Topps Update"),
    ]);
    (cs.getCardDetail as any).mockResolvedValue(detail("x", "DIFFERENT"));
    (cs.getPricing as any).mockImplementation((id: string) => {
      const records = { "dup-a": 50, "dup-b": 500 }[id] ?? 0;
      return Promise.resolve(pricing(records));
    });

    const r = await resolveCardId({
      playerName: "X",
      cardYear: 2017,
      product: "topps update",
      cardNumber: "NOMATCH",
    });

    expect(r.cardId).toBe("dup-b"); // pricing probe wins
    expect(cs.getPricing).toHaveBeenCalled();
  });

  it("caps detail probes at MAX_DETAIL_PROBES=5 even when there are more candidates", async () => {
    const cands = Array.from({ length: 8 }, (_, i) => catalog(`c${i}`, "Topps Update"));
    (cs.searchCatalog as any).mockResolvedValue(cands);
    (cs.getCardDetail as any).mockImplementation((id: string) => Promise.resolve(detail(id, "NOMATCH-" + id)));
    (cs.getPricing as any).mockResolvedValue(pricing(10));

    await resolveCardId({
      playerName: "X",
      cardYear: 2017,
      product: "topps update",
      cardNumber: "US175",
    });

    expect(cs.getCardDetail).toHaveBeenCalledTimes(5);
  });
});

describe("resolveCardId — LRU cache behavior", () => {
  it("returns cached result on second call without re-hitting searchCatalog", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("only-id", "Topps Update")]);

    const input = { playerName: "Cache Test", cardYear: 2017, product: "topps update" };
    const r1 = await resolveCardId(input);
    const r2 = await resolveCardId(input);

    expect(r1.cardId).toBe("only-id");
    expect(r2.cardId).toBe("only-id");
    expect(cs.searchCatalog).toHaveBeenCalledTimes(1);
    expect(__resolveCardIdInternals.cacheSize()).toBe(1);
  });

  it("does NOT cache null results", async () => {
    (cs.searchCatalog as any).mockResolvedValue([]);

    const input = { playerName: "Miss Test", cardYear: 2099, product: "topps update" };
    await resolveCardId(input);
    await resolveCardId(input);

    expect(cs.searchCatalog).toHaveBeenCalledTimes(2);
    expect(__resolveCardIdInternals.cacheSize()).toBe(0);
  });

  it("key includes all disambiguating fields (different cardNumber → different cache key)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("only-id", "Topps Update")]);

    const a = await resolveCardId({ playerName: "X", cardYear: 2017, product: "topps update", cardNumber: "A" });
    const b = await resolveCardId({ playerName: "X", cardYear: 2017, product: "topps update", cardNumber: "B" });

    expect(a.cardId).toBe("only-id");
    expect(b.cardId).toBe("only-id");
    expect(cs.searchCatalog).toHaveBeenCalledTimes(2); // both cold
    expect(__resolveCardIdInternals.cacheSize()).toBe(2);
  });

  it("normalizes player-name whitespace + casing in cache key", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c", "Topps Update")]);

    await resolveCardId({ playerName: "Mike Trout", cardYear: 2011, product: "topps update" });
    await resolveCardId({ playerName: "  mike   trout  ", cardYear: 2011, product: "TOPPS UPDATE" });

    expect(cs.searchCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCardId — Phase 2 dictionary additions (COMPIQ_TO_CARDSIGHT_RELEASES)", () => {
  it("'topps update' maps to 'Topps Update' (new entry — covers Trout/Ohtani/Judge demo cards)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("trout-tu", "Topps Update"),
    ]);

    const r = await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "topps update",
    });

    expect(r.cardId).toBe("trout-tu");
    // searchCatalog should have been called with query containing the
    // dictionary-resolved release name (not the raw product string).
    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Mike Trout Topps Update",
      expect.objectContaining({ year: 2011 }),
    );
  });

  it("'bowman chrome' maps to 'Bowman Chrome' (corrected from prior 'Bowman Draft Chrome' mismap)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("trout-bc", "Bowman Chrome"),
    ]);

    const r = await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2024,
      product: "bowman chrome",
    });

    expect(r.cardId).toBe("trout-bc");
    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Mike Trout Bowman Chrome",
      expect.objectContaining({ year: 2024 }),
    );
  });

  it("'bowman draft chrome' still maps to 'Bowman Draft Chrome' (existing entry — no regression)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("bonemer-bdc", "Bowman Draft Chrome"),
    ]);

    const r = await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "bowman draft chrome",
    });

    expect(r.cardId).toBe("bonemer-bdc");
    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Caleb Bonemer Bowman Draft Chrome",
      expect.objectContaining({ year: 2024 }),
    );
  });

  it("'topps chrome update' still maps to 'Topps Chrome Update' (existing entry — no regression)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("witt-tcu", "Topps Chrome Update"),
    ]);

    const r = await resolveCardId({
      playerName: "Bobby Witt Jr",
      cardYear: 2022,
      product: "topps chrome update",
    });

    expect(r.cardId).toBe("witt-tcu");
    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Bobby Witt Jr Topps Chrome Update",
      expect.objectContaining({ year: 2022 }),
    );
  });
});

describe("resolveCardId — Phase 2 v2 defect #12 (Bowman Chrome cardNumber-pattern dispatch)", () => {
  // When user types product="Bowman Chrome" with a cardNumber prefix indicating
  // Bowman Draft Chrome realm (BDC-, BD-, CPA-, CDA-, BCRP-, BBPA-), the
  // dispatch overrides effectiveProduct to "Bowman Draft Chrome" so the catalog
  // search lands on the broader Bowman Draft space rather than flagship Bowman
  // Chrome (which would surface BCP-N Prospects — semantically different card).

  it("overrides 'Bowman Chrome' to 'Bowman Draft Chrome' when cardNumber starts with BDC-", async () => {
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("witt-bdc", "Bowman Draft Chrome"),
    ]);

    await resolveCardId({
      playerName: "Bobby Witt Jr",
      cardYear: 2020,
      product: "bowman chrome",
      cardNumber: "BDC-1",
    });

    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Bobby Witt Jr Bowman Draft Chrome",
      expect.objectContaining({ year: 2020 }),
    );
  });

  it("overrides 'Bowman Chrome' to 'Bowman Draft Chrome' when cardNumber starts with CPA-", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("bonemer-bdc", "Bowman Draft Chrome")]);

    await resolveCardId({
      playerName: "Caleb Bonemer",
      cardYear: 2024,
      product: "bowman chrome",
      cardNumber: "CPA-CBO",
    });

    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Caleb Bonemer Bowman Draft Chrome",
      expect.objectContaining({ year: 2024 }),
    );
  });

  it("does NOT override when cardNumber is BCP- (flagship Bowman Chrome Prospects)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("trout-bcp", "Bowman Chrome")]);

    await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2024,
      product: "bowman chrome",
      cardNumber: "BCP-1",
    });

    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Mike Trout Bowman Chrome",
      expect.objectContaining({ year: 2024 }),
    );
  });

  it("does NOT override when product is NOT 'Bowman Chrome' (e.g. Topps Update)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("trout-tu", "Topps Update")]);

    await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "topps update",
      cardNumber: "BDC-99",
    });

    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Mike Trout Topps Update",
      expect.objectContaining({ year: 2011 }),
    );
  });

  it("does NOT override when cardNumber is missing", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("witt-bc", "Bowman Chrome")]);

    await resolveCardId({
      playerName: "Bobby Witt Jr",
      cardYear: 2024,
      product: "bowman chrome",
    });

    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "Bobby Witt Jr Bowman Chrome",
      expect.objectContaining({ year: 2024 }),
    );
  });

  it("covers BD-/CDA-/BCRP-/BBPA- prefixes (full pattern coverage)", async () => {
    const prefixes = ["BD-31", "CDA-X1", "BCRP-AB", "BBPA-ZZ"];
    for (const cardNumber of prefixes) {
      (cs.searchCatalog as any).mockClear();
      (cs.searchCatalog as any).mockResolvedValue([catalog("x", "Bowman Draft Chrome")]);
      __resolveCardIdInternals.clearCache();

      await resolveCardId({
        playerName: "Test Player",
        cardYear: 2024,
        product: "bowman chrome",
        cardNumber,
      });

      expect(cs.searchCatalog).toHaveBeenCalledWith(
        "Test Player Bowman Draft Chrome",
        expect.objectContaining({ year: 2024 }),
      );
    }
  });
});

describe("buildCacheKey — Phase 2 v2 defect #11 (cache-key alignment trace)", () => {
  // Verifies the request-side key (built from queryContext fields) matches
  // the warming-side key (built from CACHE_WARM_TARGETS) for the same logical
  // card. Post-defect-#10 fix, warming targets carry NO cardNumber. Post-
  // defect-#11 fix, the request side may or may not carry cardNumber
  // depending on which endpoint produced the queryContext:
  //   - /price + /estimate with no cardNumber in body  → cardNumber=undefined → KEY MATCHES warming
  //   - /price-by-id parsed from iOS displayLabel       → cardNumber populated → KEY DIFFERS from warming (separate lazy cache entry, by design)

  const buildCacheKey = __resolveCardIdInternals.buildCacheKey;

  it("warming-side key for Mike Trout 2011 Topps Update == /price-side key (cardNumber undefined on both)", () => {
    const warmingKey = buildCacheKey({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      // no cardNumber — matches post-defect-#10 CACHE_WARM_TARGETS shape
    });
    const priceKey = buildCacheKey({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      // /price + /estimate with no cardNumber field → undefined
    });
    expect(priceKey).toBe(warmingKey);
  });

  it("/price-by-id key (with cardNumber) DIFFERS from warming key (lazy-cache by design)", () => {
    const warmingKey = buildCacheKey({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
    });
    const priceByIdKey = buildCacheKey({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      cardNumber: "US175",
    });
    expect(priceByIdKey).not.toBe(warmingKey);
    expect(priceByIdKey).toContain("us175");
  });
});

describe("warmResolveCardIdCache — Phase 2 v2 defect #10 (warming API load reduction)", () => {
  // CACHE_WARM_TARGETS post-defect-#10 fix has NO cardNumber field on any
  // target. This means warmResolveCardIdCache must NOT trigger the cardNumber
  // detail-probe path in resolveCardId (which would fan out
  // MAX_DETAIL_PROBES=5 getCardDetail calls per target = 50 extra Cardsight
  // calls = rate-limit storm).

  it("calls searchCatalog once per warming target and never calls getCardDetail (no cardNumber means no detail-probe)", async () => {
    // Mock searchCatalog to return a single candidate per warming target so
    // the cardNumber detail-probe step (`candidates.length > 1`) doesn't fire
    // for an unrelated reason.
    (cs.searchCatalog as any).mockImplementation((query: string) =>
      Promise.resolve([catalog(`only-${query.slice(0, 10)}`, "Topps Update")]),
    );
    (cs.getCardDetail as any).mockResolvedValue(detail("x", "?"));
    (cs.getPricing as any).mockResolvedValue(pricing(0));

    await warmResolveCardIdCache();

    // 10 warming targets x 1 searchCatalog call each
    expect(cs.searchCatalog).toHaveBeenCalledTimes(10);
    // Defect #10 acceptance — NO detail probes during warming
    expect(cs.getCardDetail).not.toHaveBeenCalled();
    // Pricing probes only fire when there are multiple candidates; with
    // single-candidate mock above, no pricing probes either.
    expect(cs.getPricing).not.toHaveBeenCalled();
  });

  it("warming targets in CACHE_WARM_TARGETS do NOT carry cardNumber field (defect #10 fix preserved)", async () => {
    // Capture every CompIQQueryInput passed to searchCatalog via the resolver
    const inputs: Array<{ query: string; year: unknown }> = [];
    (cs.searchCatalog as any).mockImplementation((query: string, opts: any) => {
      inputs.push({ query, year: opts?.year });
      return Promise.resolve([catalog(`c-${query.slice(0, 8)}`, "x")]);
    });

    await warmResolveCardIdCache();

    expect(inputs.length).toBe(10);
    // No query should contain a cardNumber-like token (US/USC/HMT/CPA prefix
    // with digits or letters). Warming queries are player + releaseName only.
    for (const i of inputs) {
      expect(/\b(US\d+|USC\d+|HMT\d+|CPA-)/i.test(i.query)).toBe(false);
    }
  });
});

describe("resolveCardId — parallel resolution preserved", () => {
  it("resolves parallelId when input.parallel present and detail.parallels has match", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("only-id", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue(
      detail("only-id", "US175", [{ id: "blue-id", name: "Blue Refractor", numberedTo: 150 }]),
    );

    const r = await resolveCardId({
      playerName: "X",
      cardYear: 2017,
      product: "topps update",
      parallel: "Blue Refractor",
    });

    expect(r.cardId).toBe("only-id");
    expect(r.parallelId).toBe("blue-id");
  });
});
