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

/**
 * CF-69-FINISH: module-level mutable for the current test's input
 * playerName. catalog() defaults `name` to this so candidates pass the
 * legacy name-guard (CF-69-FINISH 2+ token gate) without per-call
 * boilerplate. Multi-token tests set at top; `beforeEach` resets to "x".
 */
let _testPlayer = "x";

function catalog(
  id: string,
  releaseName: string,
  setName = "Base Set",
  year = "2017",
  name?: string,
): Catalog {
  return { id, name: name ?? _testPlayer, number: "", releaseName, setName, year: Number(year) };
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

// CF-69-RESOLVER-FIX: helper for warming-target mocks. Shape Y is
// `{year} {releaseName} {playerName} RC` — extracting the canonical
// releaseName lets the mock return a matching candidate so the filter
// chain exits on Shape Y (no Shape S / legacy fallback retry).
function releaseNameForQuery(query: string): string {
  if (query.includes("Topps Chrome Update")) return "Topps Chrome Update";
  if (query.includes("Bowman Draft Chrome")) return "Bowman Draft Chrome";
  if (query.includes("Topps Update")) return "Topps Update";
  if (query.includes("Bowman Chrome")) return "Bowman Chrome";
  return "Topps Update";
}

beforeEach(() => {
  vi.clearAllMocks();
  __resolveCardIdInternals.clearCache();
  // CF-69-FINISH: reset to placeholder. Multi-token tests override.
  _testPlayer = "x";
});

describe("resolveCardId — defect #1 (single candidate picked) + defect #5 (catalog duplicates)", () => {
  it("picks the single candidate when release filter narrows to one — no pricing probe", async () => {
    _testPlayer = "Player X";
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
    _testPlayer = "Player X";
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
    _testPlayer = "Mike Trout";
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
    _testPlayer = "Player Z";
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
    _testPlayer = "Mike Trout";
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
    // CF-69-FINISH: candidate name must include the playerName tokens so
    // name-guard passes on Shape Y (otherwise the resolver falls through to
    // S + legacy, inflating call count past 1).
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("only-id", "Topps Update", "Base Set", "2017", "Cache Test"),
    ]);

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

    // CF-69-RESOLVER-FIX: each resolveCardId call fires up to 3
    // searchCatalog calls (Shape Y → Shape S retry → legacy fallback)
    // when all return zero results. Two cold calls × 3 = 6. The core
    // assertion is that the cache stays empty (no null pinning).
    expect(cs.searchCatalog).toHaveBeenCalledTimes(6);
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
    // CF-69-FINISH: name-guard requires candidate name to contain "mike"+"trout"
    // tokens; the placeholder "x" would fall through to S+legacy and inflate
    // the searchCatalog count to 3 per cold call (6 total here vs expected 1).
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("c", "Topps Update", "Base Set", "2011", "Mike Trout"),
    ]);

    await resolveCardId({ playerName: "Mike Trout", cardYear: 2011, product: "topps update" });
    await resolveCardId({ playerName: "  mike   trout  ", cardYear: 2011, product: "TOPPS UPDATE" });

    expect(cs.searchCatalog).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCardId — Phase 2 dictionary additions (COMPIQ_TO_CARDSIGHT_RELEASES)", () => {
  it("'topps update' maps to 'Topps Update' (new entry — covers Trout/Ohtani/Judge demo cards)", async () => {
    _testPlayer = "Mike Trout";
    (cs.searchCatalog as any).mockResolvedValue([
      catalog("trout-tu", "Topps Update"),
    ]);

    const r = await resolveCardId({
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "topps update",
    });

    expect(r.cardId).toBe("trout-tu");
    // CF-69-RESOLVER-FIX: query is now Shape Y format
    // `{year} {releaseName} {playerName} RC` (no year= filter — flaky for
    // Skenes-class cards per CF-69 C2).
    expect(cs.searchCatalog).toHaveBeenCalledWith(
      "2011 Topps Update Mike Trout RC",
      expect.objectContaining({ take: 20 }),
    );
  });

  it("'bowman chrome' maps to 'Bowman Chrome' (corrected from prior 'Bowman Draft Chrome' mismap)", async () => {
    _testPlayer = "Mike Trout";
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
      "2024 Bowman Chrome Mike Trout RC",
      expect.objectContaining({ take: 20 }),
    );
  });

  it("'bowman draft chrome' still maps to 'Bowman Draft Chrome' (existing entry — no regression)", async () => {
    _testPlayer = "Caleb Bonemer";
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
      "2024 Bowman Draft Chrome Caleb Bonemer RC",
      expect.objectContaining({ take: 20 }),
    );
  });

  it("'topps chrome update' still maps to 'Topps Chrome Update' (existing entry — no regression)", async () => {
    _testPlayer = "Bobby Witt Jr";
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
      "2022 Topps Chrome Update Bobby Witt Jr RC",
      expect.objectContaining({ take: 20 }),
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
      "2020 Bowman Draft Chrome Bobby Witt Jr RC",
      expect.objectContaining({ take: 20 }),
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
      "2024 Bowman Draft Chrome Caleb Bonemer RC",
      expect.objectContaining({ take: 20 }),
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
      "2024 Bowman Chrome Mike Trout RC",
      expect.objectContaining({ take: 20 }),
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
      "2011 Topps Update Mike Trout RC",
      expect.objectContaining({ take: 20 }),
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
      "2024 Bowman Chrome Bobby Witt Jr RC",
      expect.objectContaining({ take: 20 }),
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
        "2024 Bowman Draft Chrome Test Player RC",
        expect.objectContaining({ take: 20 }),
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

  // CF-69-RESOLVER-FIX: warming mocks now infer releaseName from the
  // canonical strings present in the Shape Y query so the filter chain
  // exits on Shape Y and avoids the legacy fallback retry path (which
  // would inflate searchCatalog call counts beyond the 10-per-warming
  // contract). See module-level `releaseNameForQuery`.

  it("calls searchCatalog once per warming target and never calls getCardDetail (no cardNumber means no detail-probe)", async () => {
    // Mock searchCatalog to return a single candidate per warming target so
    // the cardNumber detail-probe step (`candidates.length > 1`) doesn't fire
    // for an unrelated reason.
    // CF-69-FINISH: pass the full query as candidate name so the warming
    // target's player tokens are present and pass the name-guard safety
    // filter (otherwise resolver falls through to S+legacy on every warming
    // target, inflating call count 3×).
    (cs.searchCatalog as any).mockImplementation((query: string) =>
      Promise.resolve([catalog(`only-${query.slice(0, 10)}`, releaseNameForQuery(query), "Base Set", "2017", query)]),
    );
    (cs.getCardDetail as any).mockResolvedValue(detail("x", "?"));
    (cs.getPricing as any).mockResolvedValue(pricing(0));

    await warmResolveCardIdCache();

    // 10 warming targets x 1 searchCatalog call each (Shape Y resolves
    // because releaseName matches; no Shape S or legacy fallback fires).
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
      // CF-69-FINISH: candidate name = query so player tokens pass name-guard.
      return Promise.resolve([catalog(`c-${query.slice(0, 8)}`, releaseNameForQuery(query), "Base Set", "2017", query)]);
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

describe("warmResolveCardIdCache — defect #13 v2 (serialized warming, single-cap symmetry)", () => {
  // Defect #13 v2 — first attempt used asymmetric cap (warming=3, request=8)
  // but regressed Ohtani-shape cards (deep-catalog data-bearing). Second
  // attempt serializes warming instead: one target at a time, full cap=8.
  // No rate-limit cascade because resolutions don't overlap. No cap
  // asymmetry, so warming reaches data-bearing cardIds at deep catalog
  // positions just like request-side does.

  it("warming completes for all 10 targets sequentially (no Promise.all parallelism)", async () => {
    // Track call ordering to verify serial execution.
    const callOrder: string[] = [];
    (cs.searchCatalog as any).mockImplementation(async (query: string) => {
      callOrder.push(`start:${query.slice(0, 20)}`);
      // Add small delay to amplify the parallel-vs-serial signal
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push(`end:${query.slice(0, 20)}`);
      // CF-69-FINISH: candidate name = query so player tokens pass name-guard.
      return [catalog(`c-${query.slice(0, 8)}`, releaseNameForQuery(query), "Base Set", "2017", query)];
    });
    (cs.getPricing as any).mockResolvedValue(pricing(0));

    await warmResolveCardIdCache();

    expect(cs.searchCatalog).toHaveBeenCalledTimes(10);
    // Serial: each `start:X` is immediately followed by its `end:X` before
    // the next `start:Y` begins. Parallel (Promise.all) would interleave.
    for (let i = 0; i < callOrder.length; i += 2) {
      const startEntry = callOrder[i];
      const endEntry = callOrder[i + 1];
      expect(startEntry.startsWith("start:")).toBe(true);
      expect(endEntry.startsWith("end:")).toBe(true);
      expect(startEntry.slice(6)).toBe(endEntry.slice(4));
    }
  });

  it("warming uses full MAX_PRICING_PROBES=8 (same as request-side — no asymmetric cap)", async () => {
    _testPlayer = "Shohei Ohtani";
    const cands = Array.from({ length: 16 }, (_, i) => catalog(`w${i}`, "Topps Update"));
    // Catalog mock returns 16 candidates only for one specific warming target;
    // other targets get single-candidate (no pricing-probe fanout) to keep
    // the math clean.
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Shohei Ohtani")) return Promise.resolve(cands);
      return Promise.resolve([catalog(`c-${query.slice(0, 8)}`, releaseNameForQuery(query))]);
    });
    (cs.getPricing as any).mockResolvedValue(pricing(10));

    await warmResolveCardIdCache();

    // Shohei Ohtani warming target alone should fire 8 pricing probes
    // (defect #5's MAX_PRICING_PROBES cap). The other 9 single-candidate
    // targets fire 0 pricing probes. Total: 8.
    expect(cs.getPricing).toHaveBeenCalledTimes(8);
  });

  it("Ohtani-shape deep-ranked card resolves correctly during warming (defect #13 v2 acceptance)", async () => {
    _testPlayer = "Shohei Ohtani";
    // 16 candidates; data-bearing at position 4 (o3). Cap=8 reaches it.
    const cands = Array.from({ length: 16 }, (_, i) => catalog(`o${i}`, "Topps Update"));
    (cs.searchCatalog as any).mockImplementation((query: string) => {
      if (query.includes("Shohei Ohtani")) return Promise.resolve(cands);
      return Promise.resolve([catalog(`c-${query.slice(0, 8)}`, releaseNameForQuery(query))]);
    });
    (cs.getPricing as any).mockImplementation((id: string) => {
      const recs = id === "o3" ? 600 : id === "o9" ? 1200 : 0;
      return Promise.resolve(pricing(recs));
    });

    await warmResolveCardIdCache();

    // Pricing probe selected o3 (600 records, position 4, within cap=8 reach).
    // o9 (1200 records) is at position 10, beyond cap — not selected.
    // Verify the cache now holds the correct cardId for the Ohtani warming key.
    const r = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "topps update",
    });
    expect(r.cardId).toBe("o3");
    // Top-8 probed contains only o3 with data (o9 at position 10 is beyond
    // cap=8). dataBearingCount=1 in the probe set → matchConfidence="exact".
    expect(r.matchConfidence).toBe("exact");
  });

  it("request-side resolution uses MAX_PRICING_PROBES=8 (single cap, no asymmetry)", async () => {
    _testPlayer = "Different Player";
    const cands = Array.from({ length: 16 }, (_, i) => catalog(`r${i}`, "Topps Update"));
    (cs.searchCatalog as any).mockResolvedValue(cands);
    (cs.getPricing as any).mockResolvedValue(pricing(10));

    await resolveCardId({ playerName: "Different Player", cardYear: 2018, product: "topps update" });

    expect(cs.getPricing).toHaveBeenCalledTimes(8);
  });
});

describe("resolveCardId — Phase 2 v2 defect #2 (parallelMatches sorted-array equality)", () => {
  // Prior behavior: "Refractor" matched "Chrome Blue Refractor" (subset). Now:
  // strict set-equality on tokens. Tests the disambiguation path in
  // resolveParallelOnCandidate, which uses parallelMatches via Array.find.

  function setupParallel(parallels: Array<{ id: string; name: string }>) {
    (cs.searchCatalog as any).mockResolvedValue([catalog("p2-card", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "p2-card", name: "x", number: "", releaseName: "Topps Update", setName: "Base Set",
      year: 2020, parallels: parallels.map(p => ({ id: p.id, name: p.name, numberedTo: null })),
    });
  }

  it("exact 1-token match: input 'Refractor' matches parallel 'Refractor' only", async () => {
    setupParallel([
      { id: "chrome-blue-refractor", name: "Chrome Blue Refractor" },
      { id: "refractor", name: "Refractor" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Refractor",
    });
    expect(r.parallelId).toBe("refractor");
  });

  it("rejects subset (the 2020 Witt regression case): 'Refractor' does NOT match 'Chrome Blue Refractor'", async () => {
    setupParallel([
      { id: "chrome-blue-refractor", name: "Chrome Blue Refractor" },
      { id: "chrome-gold-refractor", name: "Chrome Gold Refractor" },
      { id: "chrome", name: "Chrome" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Refractor",
    });
    // No plain 'Refractor' in the parallels list — strict equality finds
    // none. parallelId stays null; getPricing fires without parallel filter.
    expect(r.parallelId).toBeNull();
  });

  it("rejects subset: 'Blue Refractor' does NOT match 'Blue Wave Refractor'", async () => {
    setupParallel([
      { id: "blue-wave-refractor", name: "Blue Wave Refractor" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Blue Refractor",
    });
    expect(r.parallelId).toBeNull();
  });

  it("exact multi-token match: 'Blue Wave Refractor' matches 'Blue Wave Refractor' parallel only", async () => {
    setupParallel([
      { id: "blue-refractor", name: "Blue Refractor" },
      { id: "blue-wave-refractor", name: "Blue Wave Refractor" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Blue Wave Refractor",
    });
    expect(r.parallelId).toBe("blue-wave-refractor");
  });

  it("token-order independence (sorted equality): 'Refractor Blue' matches 'Blue Refractor'", async () => {
    setupParallel([
      { id: "blue-refractor", name: "Blue Refractor" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Refractor Blue",
    });
    expect(r.parallelId).toBe("blue-refractor");
  });

  it("when no strict match exists, parallelId is null and pricing fetch fires without parallel filter", async () => {
    setupParallel([
      { id: "chrome-blue-refractor", name: "Chrome Blue Refractor" },
    ]);
    const r = await resolveCardId({
      playerName: "X", cardYear: 2020, product: "topps update", parallel: "Refractor",
    });
    expect(r.parallelId).toBeNull();
    // Resolution still completes successfully with cardId; just no parallel narrow.
    expect(r.cardId).toBe("p2-card");
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

// CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (parallelMatches wrapper fix):
// Cardsight catalogs some set-level parallels with a verbose wrapper
// around the canonical name — e.g. "Limited Edition (Tiffany)" for
// the Maddux 1987 Topps Traded Tiffany RC. tokenizeParallel must strip
// the wrapper so user input "TIFFANY" satisfies strict-set-equality
// against ["tiffany"] (extracted from the parenthesized wrapper),
// instead of failing against ["limited", "edition", "(tiffany)"].
//
// Preserves defect #2 strict-equality semantics for non-wrapped
// parallels: "Refractor" still does NOT match "Chrome Blue Refractor".
describe("resolveCardId — parallelMatches strips parenthesized wrappers (Tiffany case)", () => {
  it("Tiffany input matches 'Limited Edition (Tiffany)' parallel via wrapper-strip", async () => {
    _testPlayer = "Greg Maddux";
    (cs.searchCatalog as any).mockResolvedValue([catalog("maddux-card", "Topps Traded")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "maddux-card",
      name: "Greg Maddux",
      number: "70T",
      releaseName: "Topps Traded",
      setName: "Base Set",
      year: 1987,
      parallels: [
        { id: "limited-edition-tiffany", name: "Limited Edition (Tiffany)", numberedTo: null },
        { id: "base", name: "Base", numberedTo: null },
      ],
    });

    const r = await resolveCardId({
      playerName: "Greg Maddux",
      cardYear: 1987,
      product: "Topps Traded",
      parallel: "TIFFANY",
    });

    expect(r.cardId).toBe("maddux-card");
    expect(r.parallelId).toBe("limited-edition-tiffany");
  });

  it("Gold input matches 'Refractor (Gold)' parallel via wrapper-strip", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "c",
      name: "x",
      number: "",
      releaseName: "Topps Update",
      setName: "Base Set",
      year: 2020,
      parallels: [
        { id: "refractor-gold", name: "Refractor (Gold)", numberedTo: 50 },
        { id: "refractor", name: "Refractor", numberedTo: null },
      ],
    });

    const r = await resolveCardId({
      playerName: "x",
      cardYear: 2020,
      product: "topps update",
      parallel: "Gold",
    });

    expect(r.parallelId).toBe("refractor-gold");
  });

  it("non-wrapped parallel still works (no regression)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "c",
      name: "x",
      number: "",
      releaseName: "Topps Update",
      setName: "Base Set",
      year: 2020,
      parallels: [
        { id: "tiffany-plain", name: "Tiffany", numberedTo: null },
      ],
    });

    const r = await resolveCardId({
      playerName: "x",
      cardYear: 2020,
      product: "topps update",
      parallel: "TIFFANY",
    });

    expect(r.parallelId).toBe("tiffany-plain");
  });

  it("defect #2 preserved: 'Refractor' still does NOT match 'Chrome Blue Refractor' (no wrapper)", async () => {
    (cs.searchCatalog as any).mockResolvedValue([catalog("c", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "c",
      name: "x",
      number: "",
      releaseName: "Topps Update",
      setName: "Base Set",
      year: 2020,
      parallels: [
        { id: "chrome-blue-refractor", name: "Chrome Blue Refractor", numberedTo: null },
      ],
    });

    const r = await resolveCardId({
      playerName: "x",
      cardYear: 2020,
      product: "topps update",
      parallel: "Refractor",
    });

    // Wrapper-strip doesn't apply (no parens); strict-equality preserved.
    expect(r.parallelId).toBeNull();
  });

  it("wrapped vs non-wrapped distinction: 'Tiffany' matches BOTH 'Tiffany' and 'Limited Edition (Tiffany)'", async () => {
    // Both candidates tokenize to ["tiffany"] (wrapped one via strip).
    // resolveParallelOnCandidate uses Array.find so picks first match;
    // verify the resolver doesn't crash and produces a valid parallelId.
    (cs.searchCatalog as any).mockResolvedValue([catalog("c", "Topps Update")]);
    (cs.getCardDetail as any).mockResolvedValue({
      id: "c",
      name: "x",
      number: "",
      releaseName: "Topps Update",
      setName: "Base Set",
      year: 2020,
      parallels: [
        { id: "limited-edition-tiffany", name: "Limited Edition (Tiffany)", numberedTo: null },
        { id: "tiffany-plain", name: "Tiffany", numberedTo: null },
      ],
    });

    const r = await resolveCardId({
      playerName: "x",
      cardYear: 2020,
      product: "topps update",
      parallel: "Tiffany",
    });

    // Array.find returns first match. Both tokenize to ["tiffany"] so
    // the first listed wins. The test doesn't enforce which one as
    // long as the resolver picks A parallel rather than failing to null.
    expect(r.parallelId).toBeTruthy();
    expect(["limited-edition-tiffany", "tiffany-plain"]).toContain(r.parallelId);
  });
});

