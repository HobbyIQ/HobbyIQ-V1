// CF-CH-ALL-PRICES-BY-CARD (2026-07-04) — pins the getAllPricesByCard
// wrapper on the CardHedge client. Endpoint returns CH's latest per-grade
// model estimate for a card in one HTTP call. See project memory
// project_engine_owns_signals_not_ch_product — treated as CH's guess for
// calibration, NOT as authoritative FMV.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

beforeEach(() => {
  // @ts-expect-error – global fetch override
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
});

describe("CF-CH-ALL-PRICES-BY-CARD — getAllPricesByCard", () => {
  it("POSTs to /cards/all-prices-by-card with card_id in body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        prices: [
          { card_id: "c1", grade: "Raw", grader: "Raw", price: "1299.99", display_order: "-1" },
          { card_id: "c1", grade: "PSA 10", grader: "PSA", price: "16999.99", display_order: "1" },
        ],
      }),
    });
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/cards/all-prices-by-card");
    const body = JSON.parse(opts.body as string);
    expect(body.card_id).toBe("c1");

    // Response mapping: string prices become numeric, display_order too.
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ grade: "Raw", grader: "Raw", price: 1299.99, display_order: -1 });
    expect(r[1]).toMatchObject({ grade: "PSA 10", grader: "PSA", price: 16999.99, display_order: 1 });
  });

  it("returns [] when the API key is missing (no HTTP call)", async () => {
    delete process.env.CARD_HEDGE_API_KEY;
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when cardId is empty (guard against wasted calls)", async () => {
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("");
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters out rows with zero/invalid prices or missing grade", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        prices: [
          { card_id: "c1", grade: "Raw", price: "50" },
          { card_id: "c1", grade: "PSA 10", price: "0" }, // zero → dropped
          { card_id: "c1", grade: "", price: "100" }, // missing grade → dropped
          { card_id: "c1", grade: "BGS 9.5", price: "not-a-number" }, // bad → dropped
        ],
      }),
    });
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");
    expect(r).toHaveLength(1);
    expect(r[0].grade).toBe("Raw");
  });

  it("returns [] on non-2xx status (never propagates the error)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");
    expect(r).toEqual([]);
  });

  it("returns [] when fetch throws (network / timeout)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");
    expect(r).toEqual([]);
  });

  it("handles missing prices array shape", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ detail: "not found" }) });
    const { getAllPricesByCard } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAllPricesByCard("c1");
    expect(r).toEqual([]);
  });
});
