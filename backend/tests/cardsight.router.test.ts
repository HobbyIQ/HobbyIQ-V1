import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  findCompsByQuery: vi.fn(),
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

const mockFindCompsByQuery = vi.mocked(findCompsByQuery);
const mockResolveCardId = vi.mocked(resolveCardId);
const mockGetPricing = vi.mocked(getPricing);
const mockTranslateResponse = vi.mocked(translateResponse);

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
});
