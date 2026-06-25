import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  findCompsByQuery: vi.fn(),
  searchCards: vi.fn(),
  getCardSales: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.mapper.js", () => ({
  resolveCardId: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.client.js", () => {
  class CardsightTimeoutError extends Error {
    constructor(message = "timeout") {
      super(message);
      this.name = "CardsightTimeoutError";
    }
  }

  return {
    getPricing: vi.fn(),
    searchCatalog: vi.fn(),
    CardsightTimeoutError,
  };
});

vi.mock("../src/services/compiq/cardsight.translator.js", () => ({
  translateResponse: vi.fn(),
}));


import { findCompsByQuery } from "../src/services/compiq/cardhedge.client.js";
import { resolveCardId } from "../src/services/compiq/cardsight.mapper.js";
import { getPricing, CardsightTimeoutError } from "../src/services/compiq/cardsight.client.js";
import { translateResponse } from "../src/services/compiq/cardsight.translator.js";
import { findCompsRouted } from "../src/services/compiq/cardsight.router.js";
import { searchCardsRouted, getCardSalesRouted } from "../src/services/compiq/cardsight.router.js";
import { searchCards, getCardSales } from "../src/services/compiq/cardhedge.client.js";
import { searchCatalog } from "../src/services/compiq/cardsight.client.js";

const mockTranslateResponse = vi.mocked(translateResponse);
const mockFindCompsByQuery = vi.mocked(findCompsByQuery);
const mockResolveCardId = vi.mocked(resolveCardId);
const mockGetPricing = vi.mocked(getPricing);

const chResult = {
  card: { card_id: "ch-1", player: "Mike Trout", set: "Topps Chrome", year: 2018, title: "CH title" },
  sales: [{ price: 100, title: "CH Comp 1", date: "2026-05-01", grade: "Raw", source: "ch", sale_type: null, url: null }],
  variantWarning: [],
  aiCategory: "Baseball",
};

beforeEach(() => {
  delete process.env.CARDSIGHT_MODE;
  vi.clearAllMocks();
  mockFindCompsByQuery.mockResolvedValue(chResult as any);
  mockResolveCardId.mockResolvedValue({
    cardId: "cs-1",
    parallelId: null,
    matchConfidence: "exact",
    warnings: [],
  } as any);
  mockGetPricing.mockResolvedValue({
    card: { id: "cs-1", name: "CS title", player: "Mike Trout", setName: "Topps Chrome", year: 2018, number: "1" },
    raw: { count: 1, records: [] },
    graded: [],
    meta: { total_records: 1, last_sale_date: "2026-05-01" },
  } as any);
  mockTranslateResponse.mockReturnValue([
    { price: 99, title: "CS Comp 1", soldDate: "2026-05-02", source: "cardsight" },
  ] as any);
});

afterEach(() => {
  delete process.env.CARDSIGHT_MODE;
  vi.restoreAllMocks();
});

describe("cardsight.router", () => {
  it("mode off calls only cardhedge", async () => {
    process.env.CARDSIGHT_MODE = "off";

    const out = await findCompsRouted("Mike Trout", { grade: "Raw", limit: 25 });

    expect(out).toEqual(chResult);
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).not.toHaveBeenCalled();
  });

  it("default mode is off when env unset", async () => {
    delete process.env.CARDSIGHT_MODE;

    await findCompsRouted("Mike Trout", { grade: "Raw", limit: 25 });

    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).not.toHaveBeenCalled();
  });

  it("invalid mode falls back to off and logs warning", async () => {
    process.env.CARDSIGHT_MODE = "wat";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await findCompsRouted("Mike Trout", { grade: "Raw", limit: 25 });

    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).not.toHaveBeenCalled();
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.event).toBe("invalid_mode");
  });

  it("shadow calls both providers and returns cardhedge result", async () => {
    process.env.CARDSIGHT_MODE = "shadow";

    const out = await findCompsRouted("Mike Trout", {
      grade: "Raw",
      limit: 25,
      queryContext: { playerName: "Mike Trout", cardYear: 2018, product: "Topps Chrome" },
    });

    expect(out).toEqual(chResult);
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).toHaveBeenCalledTimes(1);
  });

  it("shadow emits shadow_comparison log", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await findCompsRouted("Mike Trout", {
      grade: "Raw",
      queryContext: { playerName: "Mike Trout", cardYear: 2018, product: "Topps Chrome" },
    });

    const payloads = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
    const shadow = payloads.find((p) => p.event === "shadow_comparison");
    expect(shadow).toBeTruthy();
    expect(shadow.selectedSource).toBe("card_hedge");
    expect(shadow.cardhedge.compsCount).toBe(1);
    expect(shadow.cardsight.compsCount).toBe(1);
  });

  it("shadow runs in parallel", async () => {
    process.env.CARDSIGHT_MODE = "shadow";

    mockFindCompsByQuery.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return chResult as any;
    });
    mockResolveCardId.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { cardId: "cs-1", parallelId: null, matchConfidence: "exact", warnings: [] } as any;
    });

    const start = Date.now();
    await findCompsRouted("Mike Trout", { grade: "Raw" });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(120);
  });

  it("shadow returns cardhedge when cardsight throws and logs hasError", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockResolveCardId.mockRejectedValue(new Error("cardsight boom"));

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out).toEqual(chResult);
    const payloads = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
    const shadow = payloads.find((p) => p.event === "shadow_comparison");
    expect(shadow.cardsight.hasError).toBe(true);
  });

  it("primary returns cardsight result when non-empty", async () => {
    process.env.CARDSIGHT_MODE = "primary";

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toHaveLength(1);
    expect(out.sales[0].title).toBe("CS Comp 1");
    expect(mockFindCompsByQuery).not.toHaveBeenCalled();
  });

  it("primary falls back to cardhedge when cardsight empty", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    mockTranslateResponse.mockReturnValue([] as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out).toEqual(chResult);
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
  });

  it("primary falls back to cardhedge when cardsight throws", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    mockResolveCardId.mockRejectedValue(new Error("cardsight fail"));

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out).toEqual(chResult);
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
  });

  it("cardhedge_primary returns cardhedge result when CH has sales", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out).toEqual(chResult);
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).not.toHaveBeenCalled();
  });

  it("cardhedge_primary falls back to cardsight when CH returns empty", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockFindCompsByQuery.mockResolvedValueOnce({
      card: null,
      sales: [],
      variantWarning: [],
      aiCategory: null,
    } as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toHaveLength(1);
    expect(out.sales[0].title).toBe("CS Comp 1");
    expect(mockFindCompsByQuery).toHaveBeenCalledTimes(1);
    expect(mockResolveCardId).toHaveBeenCalledTimes(1);
  });

  it("cardhedge_primary falls back to cardsight when CH throws", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockFindCompsByQuery.mockRejectedValueOnce(new Error("ch fail"));

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toHaveLength(1);
    expect(out.sales[0].title).toBe("CS Comp 1");
    expect(mockResolveCardId).toHaveBeenCalledTimes(1);
  });

  it("cardhedge_primary returns empty when both vendors fail", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockFindCompsByQuery.mockRejectedValueOnce(new Error("ch fail"));
    mockResolveCardId.mockRejectedValueOnce(new Error("cs fail"));

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toEqual([]);
    expect(out.variantWarning).toContain("cardhedge_primary_both_vendors_empty_or_failed");
  });

  it("cardhedge_primary propagates CardsightTimeoutError from fallback", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockFindCompsByQuery.mockResolvedValueOnce({
      card: null,
      sales: [],
      variantWarning: [],
      aiCategory: null,
    } as any);
    mockResolveCardId.mockRejectedValueOnce(new CardsightTimeoutError("timeout"));

    await expect(findCompsRouted("Mike Trout", { grade: "Raw" })).rejects.toThrow("timeout");
  });

  it("exclusive uses only cardsight even when empty", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockTranslateResponse.mockReturnValue([] as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toHaveLength(0);
    expect(mockFindCompsByQuery).not.toHaveBeenCalled();
  });

  it("exclusive cardsight throw returns empty result", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockResolveCardId.mockRejectedValue(new Error("cardsight fail"));

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.sales).toEqual([]);
    expect(out.card).toBeNull();
  });

  it("exclusive propagates CardsightTimeoutError", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockResolveCardId.mockRejectedValue(new CardsightTimeoutError("timeout"));

    await expect(findCompsRouted("Mike Trout", { grade: "Raw" })).rejects.toThrow("timeout");
  });

  it("cardsight path returns card/sales/variantWarning/aiCategory shape", async () => {
    process.env.CARDSIGHT_MODE = "primary";

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out).toHaveProperty("card");
    expect(out).toHaveProperty("sales");
    expect(out).toHaveProperty("variantWarning");
    expect(out).toHaveProperty("aiCategory");
    expect(out.aiCategory).toBeNull();
  });

  it("cardsight no catalog match returns cardsight_no_catalog_match in warnings", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockResolveCardId.mockResolvedValue({ cardId: null, parallelId: null, matchConfidence: "none", warnings: [] } as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.variantWarning).toContain("cardsight_no_catalog_match");
  });

  // Defect #7 — when Cardsight pricing.card has no `player` field (the
  // typical case), baseCard.player must fall back to pricing.card.name so
  // the downstream CH-identity guard in compiqEstimate.service.ts builds a
  // haystack that actually contains the player surname.
  it("defect #7: baseCard.player falls back to pricing.card.name when pricing.card.player is undefined", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockGetPricing.mockResolvedValue({
      card: { id: "cs-1", name: "Mike Trout", setName: "Topps Update", year: 2011, number: "US175" /* no player field */ },
      raw: { count: 1, records: [] },
      graded: [],
      meta: { total_records: 1, last_sale_date: "2026-05-01" },
    } as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.card?.player).toBe("Mike Trout");
  });

  it("defect #7: baseCard.player preserves pricing.card.player when both fields populated (no regression)", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockGetPricing.mockResolvedValue({
      card: { id: "cs-1", name: "Mike Trout title string", player: "Mike Trout", setName: "Topps Update", year: 2011, number: "US175" },
      raw: { count: 1, records: [] },
      graded: [],
      meta: { total_records: 1, last_sale_date: "2026-05-01" },
    } as any);

    const out = await findCompsRouted("Mike Trout", { grade: "Raw" });

    expect(out.card?.player).toBe("Mike Trout");
  });
});


// ===================== NEW TESTS FOR PR #5 =====================



describe("searchCardsRouted", () => {
  let mockSearchCards = vi.mocked(searchCards);
  let mockSearchCatalog = vi.mocked(searchCatalog);
  let logSpy: any;
  beforeEach(() => {
    mockSearchCards.mockReset();
    mockSearchCatalog.mockReset();
    mockSearchCards.mockResolvedValue([
      { card_id: "ch_1", player: "Test Player", set: "Topps Chrome", year: "2024" },
    ]);
    mockSearchCatalog.mockResolvedValue([
      { id: "cs_1", name: "P1", releaseName: "S1", setName: "S1", player: "P1", year: 2024 },
    ]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.CARDSIGHT_MODE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CARDSIGHT_MODE;
  });

  it("off mode calls only cardhedge.searchCards and returns result unchanged", async () => {
    process.env.CARDSIGHT_MODE = "off";
    const result = await searchCardsRouted("query", 20);
    expect(mockSearchCards).toHaveBeenCalledWith("query", 20);
    expect(mockSearchCatalog).not.toHaveBeenCalled();
    expect(result).toEqual([
      { card_id: "ch_1", player: "Test Player", set: "Topps Chrome", year: "2024" },
    ]);
  });

  it("shadow mode calls both providers in parallel and returns cardhedge result", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const result = await searchCardsRouted("query", 20);
    expect(mockSearchCards).toHaveBeenCalledWith("query", 20);
    expect(mockSearchCatalog).toHaveBeenCalledWith("query", { take: 20 });
    expect(result).toEqual([
      { card_id: "ch_1", player: "Test Player", set: "Topps Chrome", year: "2024" },
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("shadow_search_comparison"), expect.anything());
  });

  it("shadow mode when cardsight throws still returns cardhedge result", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    mockSearchCatalog.mockRejectedValueOnce(new Error("network failure"));
    const result = await searchCardsRouted("q", 20);
    expect(result).toEqual([
      { card_id: "ch_1", player: "Test Player", set: "Topps Chrome", year: "2024" },
    ]);
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("shadow_search_comparison") && msg.includes("hasError"))).toBeTruthy();
  });

  it("primary mode returns cardsight result when non-empty", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    mockSearchCatalog.mockResolvedValueOnce([
      { id: "cs_1", name: "Player Name", releaseName: "Topps Chrome", setName: "Topps Chrome", player: "Player Name", year: 2024 },
    ]);
    mockSearchCards.mockClear();
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCards).not.toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("card_id");
    expect(result[0]).toHaveProperty("player");
    expect(result[0]).toHaveProperty("set");
    expect(result[0]).toHaveProperty("year");
  });

  it("primary mode falls back to cardhedge when cardsight returns empty", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    mockSearchCatalog.mockResolvedValueOnce([]);
    const fallback = [{ card_id: "ch_1", player: "P1" }];
    mockSearchCards.mockResolvedValueOnce(fallback);
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCatalog).toHaveBeenCalled();
    expect(mockSearchCards).toHaveBeenCalled();
    expect(result).toEqual(fallback);
  });

  it("exclusive mode calls only cardsight even if empty", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockSearchCatalog.mockResolvedValueOnce([]);
    mockSearchCards.mockClear();
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCards).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("cardhedge_primary returns cardhedge result when non-empty", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCards).toHaveBeenCalledWith("q", 20);
    expect(mockSearchCatalog).not.toHaveBeenCalled();
    expect(result).toEqual([
      { card_id: "ch_1", player: "Test Player", set: "Topps Chrome", year: "2024" },
    ]);
  });

  it("cardhedge_primary falls back to cardsight when cardhedge empty", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockSearchCards.mockResolvedValueOnce([]);
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCards).toHaveBeenCalled();
    expect(mockSearchCatalog).toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("card_id");
  });

  it("cardhedge_primary falls back to cardsight when cardhedge throws", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    mockSearchCards.mockRejectedValueOnce(new Error("ch search fail"));
    const result = await searchCardsRouted("q", 20);
    expect(mockSearchCatalog).toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
  });

  it("shape mapping translates cardsight result to CardHedgeCard fields", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    mockSearchCatalog.mockResolvedValueOnce([
      { id: "cs_uuid", name: "Aaron Judge", releaseName: "Topps Chrome", setName: "Base Set", player: "Aaron Judge", year: 2024, number: "99" },
    ]);
    mockSearchCards.mockImplementation(() => { throw new Error("should not be called"); });
    const result = await searchCardsRouted("q", 20);
    expect(result.length).toBe(1);
    expect(result[0].card_id).toBe("cs_uuid");
    expect(result[0].player).toContain("Aaron Judge");
    expect(result[0].set).toBeTruthy();
  });
});

describe("getCardSalesRouted", () => {
  let mockGetCardSales = vi.mocked(getCardSales);
  let mockGetPricing = vi.mocked(getPricing);
  let mockTranslateResponse = vi.mocked(translateResponse);
  let logSpy: any;
  beforeEach(() => {
    mockGetCardSales.mockReset();
    mockGetPricing.mockReset();
    mockTranslateResponse.mockReset();
    mockGetCardSales.mockResolvedValue([
      { price: 100, date: "2026-05-01", grade: "PSA 10", source: "ebay", sale_type: "fixed" },
    ]);
    mockGetPricing.mockResolvedValue({
      raw: { count: 1, records: [{ price: 100, date: "2026-05-01", source: "cardsight" }] },
      graded: [],
      card: { id: "cs_uuid" },
    });
    mockTranslateResponse.mockReturnValue([
      { price: 100, date: "2026-05-01", grade: "PSA 10", source: "cardsight" },
    ]);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.CARDSIGHT_MODE;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CARDSIGHT_MODE;
  });

  it("off mode calls only cardhedge.getCardSales", async () => {
    process.env.CARDSIGHT_MODE = "off";
    const result = await getCardSalesRouted("ch_card_id", "PSA 10", 25, { cardIdSource: "cardhedge" });
    expect(mockGetCardSales).toHaveBeenCalledWith("ch_card_id", "PSA 10", 25);
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(result).toEqual([
      { price: 100, date: "2026-05-01", grade: "PSA 10", source: "ebay", sale_type: "fixed" },
    ]);
  });

  it("shadow mode with cardIdSource cardhedge skips cardsight and logs namespace_check", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const result = await getCardSalesRouted("ch_1", "PSA 10", 25, { cardIdSource: "cardhedge" });
    expect(mockGetCardSales).toHaveBeenCalled();
    expect(mockGetPricing).not.toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("shadow_pricing_skipped_namespace_check"))).toBeTruthy();
  });

  it("shadow mode with cardIdSource cardsight calls only cardsight", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const result = await getCardSalesRouted("cs_uuid", "PSA 10", 25, { cardIdSource: "cardsight" });
    expect(mockGetCardSales).not.toHaveBeenCalled();
    expect(mockGetPricing).toHaveBeenCalled();
    expect(result.length).toBe(1);
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("shadow_pricing_comparison"))).toBeTruthy();
  });

  it("shadow mode with cardIdSource undefined defaults to cardhedge namespace", async () => {
    process.env.CARDSIGHT_MODE = "shadow";
    const result = await getCardSalesRouted("ch_1", "PSA 10", 25);
    expect(mockGetPricing).not.toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("shadow_pricing_skipped_namespace_check"))).toBeTruthy();
  });

  it("primary mode with cardIdSource cardhedge calls only cardhedge and logs warning", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    const result = await getCardSalesRouted("ch_1", "PSA 10", 25, { cardIdSource: "cardhedge" });
    expect(mockGetCardSales).toHaveBeenCalled();
    expect(mockGetPricing).not.toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("primary_mode_cardhedge_namespace_only"))).toBeTruthy();
  });

  it("primary mode with cardIdSource cardsight calls only cardsight", async () => {
    process.env.CARDSIGHT_MODE = "primary";
    const result = await getCardSalesRouted("cs_uuid", "PSA 10", 25, { cardIdSource: "cardsight" });
    expect(mockGetCardSales).not.toHaveBeenCalled();
    expect(result.length).toBe(1);
    expect(result[0].source).toBe("cardsight");
  });

  it("cardhedge_primary with cardIdSource cardhedge calls only cardhedge", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    const result = await getCardSalesRouted("ch_1", "PSA 10", 25, { cardIdSource: "cardhedge" });
    expect(mockGetCardSales).toHaveBeenCalledWith("ch_1", "PSA 10", 25);
    expect(mockGetPricing).not.toHaveBeenCalled();
    expect(result.length).toBe(1);
  });

  it("cardhedge_primary with cardIdSource cardsight calls only cardsight", async () => {
    process.env.CARDSIGHT_MODE = "cardhedge_primary";
    const result = await getCardSalesRouted("cs_uuid", "PSA 10", 25, { cardIdSource: "cardsight" });
    expect(mockGetCardSales).not.toHaveBeenCalled();
    expect(mockGetPricing).toHaveBeenCalled();
    expect(result.length).toBe(1);
    expect(result[0].source).toBe("cardsight");
  });

  it("exclusive mode with cardIdSource cardhedge returns empty and logs warning", async () => {
    process.env.CARDSIGHT_MODE = "exclusive";
    const result = await getCardSalesRouted("ch_1", "PSA 10", 25, { cardIdSource: "cardhedge" });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    const logCalls = logSpy.mock.calls.map((c: any[]) => c[0]);
    expect(logCalls.some((msg: string) => msg.includes("primary_mode_cardhedge_namespace_only"))).toBeTruthy();
  });
});
