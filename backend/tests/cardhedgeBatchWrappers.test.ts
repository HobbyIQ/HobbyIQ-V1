// CF-CH-BATCH-PORTFOLIO-REFRESH (2026-06-30) — pins the 4 batch wrappers
// on the CardHedge client: card-fmv-batch, batch-price-estimate,
// batch-prices-by-cert, price-updates.
//
// Phase 1 of the portfolio batch project. These wrappers are the
// foundation; refactor of refresh callers comes in Phase 2.
//
// THIS FILE PINS:
//   1. URL + body shape per endpoint
//   2. Chunking at 100 items (CH's per-call limit)
//   3. Empty-input fast path (no HTTP call)
//   4. Field validation (drops items missing card_id/grade/cert)
//   5. Non-fatal failure: HTTP error / throw → null OR partial
//      accumulated results (chunk failures don't poison the whole call)
//   6. price-updates: NO cache, includes optional ignore_grades

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();

vi.mock("../src/services/shared/cache.service.js", () => ({
  cacheWrap: (_key: string, fn: () => Promise<unknown>) => fn(),
  cacheKey: (...parts: string[]) => parts.join(":"),
}));

beforeEach(() => {
  // @ts-expect-error – override global fetch
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  process.env.CARD_HEDGE_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.CARD_HEDGE_API_KEY;
});

describe("CF-CH-BATCH — getCardFmvBatch", () => {
  it("posts items to /cards/card-fmv-batch with correct body shape", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ card_id: "c1", grade: "PSA 10", status: "success", fmv: { price: 100 } }],
        total_requested: 1,
        total_successful: 1,
      }),
    });
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getCardFmvBatch([{ cardId: "c1", grade: "PSA 10" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/cards/card-fmv-batch");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.items).toEqual([{ card_id: "c1", grade: "PSA 10" }]);
    expect(r?.results).toHaveLength(1);
    expect(r?.total_successful).toBe(1);
  });

  it("empty input → no HTTP call, empty result", async () => {
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getCardFmvBatch([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r?.results).toEqual([]);
    expect(r?.total_requested).toBe(0);
  });

  it("filters items missing cardId or grade", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [], total_requested: 0, total_successful: 0 }) });
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    await getCardFmvBatch([
      { cardId: "c1", grade: "PSA 10" },
      { cardId: "", grade: "PSA 9" } as any,
      { cardId: "c2", grade: "" } as any,
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.items).toEqual([{ card_id: "c1", grade: "PSA 10" }]);
  });

  it("chunks at 100 items: 250 items → 3 HTTP calls", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], total_requested: 0, total_successful: 0 }),
    });
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    const items = Array.from({ length: 250 }, (_, i) => ({ cardId: `c${i}`, grade: "PSA 10" }));
    await getCardFmvBatch(items);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body0 = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const body2 = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(body0.items).toHaveLength(100);
    expect(body2.items).toHaveLength(50);
  });

  it("partial chunk failure → other chunks' results preserved", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ card_id: "c1", grade: "PSA 10", status: "success", fmv: { price: 100 } }], total_requested: 100, total_successful: 1 }),
      })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ card_id: "c3", grade: "PSA 10", status: "success", fmv: { price: 300 } }], total_requested: 50, total_successful: 1 }),
      });
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    const items = Array.from({ length: 250 }, (_, i) => ({ cardId: `c${i}`, grade: "PSA 10" }));
    const r = await getCardFmvBatch(items);
    expect(r?.results).toHaveLength(2);  // 2 successful chunks
    expect(r?.total_successful).toBe(2);
  });

  it("HTTP error on single-chunk batch → empty result (non-fatal)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { getCardFmvBatch } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getCardFmvBatch([{ cardId: "c1", grade: "PSA 10" }]);
    expect(r?.results).toEqual([]);
    expect(r?.total_successful).toBe(0);
  });
});

describe("CF-CH-BATCH — getBatchPriceEstimate", () => {
  it("posts to /cards/batch-price-estimate", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total_requested: 1, total_successful: 0 }),
    });
    const { getBatchPriceEstimate } = await import("../src/services/compiq/cardhedge.client.js");
    await getBatchPriceEstimate([{ cardId: "c1", grade: "PSA 9" }]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/cards/batch-price-estimate");
  });
});

describe("CF-CH-BATCH — getBatchPricesByCert", () => {
  it("posts to /cards/batch-prices-by-cert with certs array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ cert_info: { cert_number: "123", grader: "PSA" }, card: null, price: 100, price_low: 90, price_high: 110, confidence: 0.9, method: "direct", card_source: "gemrate_id", match_confidence: null }],
        total_requested: 1,
        total_found: 1,
      }),
    });
    const { getBatchPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getBatchPricesByCert(["123", "456"], "PSA");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.certs).toEqual(["123", "456"]);
    expect(body.grader).toBe("PSA");
    expect(r?.total_found).toBe(1);
  });

  it("omits grader from body when not specified", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total_requested: 0, total_found: 0 }),
    });
    const { getBatchPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    await getBatchPricesByCert(["123"]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.grader).toBeUndefined();
  });

  it("filters empty / whitespace certs", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], total_requested: 0, total_found: 0 }),
    });
    const { getBatchPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    await getBatchPricesByCert(["abc", "", "   ", "def"]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.certs).toEqual(["abc", "def"]);
  });

  it("chunking honored on the cert endpoint too (250 → 3 calls)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], total_requested: 0, total_found: 0 }),
    });
    const { getBatchPricesByCert } = await import("../src/services/compiq/cardhedge.client.js");
    const certs = Array.from({ length: 250 }, (_, i) => `cert${i}`);
    await getBatchPricesByCert(certs);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("CF-CH-BATCH — getPriceUpdates (delta poll)", () => {
  it("posts to /cards/price-updates with since timestamp", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updates: [], count: 0 }),
    });
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    await getPriceUpdates("2026-06-30T00:00:00Z");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/cards/price-updates");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.since).toBe("2026-06-30T00:00:00Z");
    expect(body.ignore_grades).toBeUndefined();
  });

  it("passes ignoreGrades through as ignore_grades", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ updates: [], count: 0 }),
    });
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    await getPriceUpdates("2026-06-30T00:00:00Z", { ignoreGrades: ["Raw"] });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.ignore_grades).toEqual(["Raw"]);
  });

  it("empty since → null (defensive)", async () => {
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getPriceUpdates("");
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes response: updates array + count number", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        updates: [
          { card_id: "c1", grade: "PSA 10", price: "100", sale_date: "2026-06-29", update_timestamp: "2026-06-29T10:00:00Z", card_desc: "x", card_set: "s", card_number: "1", player: "p", variant: "v" },
        ],
        count: 1,
      }),
    });
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getPriceUpdates("2026-06-30T00:00:00Z");
    expect(r?.updates).toHaveLength(1);
    expect(r?.count).toBe(1);
    expect(r?.updates[0]!.card_id).toBe("c1");
  });

  it("HTTP error → null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getPriceUpdates("2026-06-30T00:00:00Z");
    expect(r).toBeNull();
  });

  it("network throw → null (never propagates)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect timeout"));
    const { getPriceUpdates } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getPriceUpdates("2026-06-30T00:00:00Z");
    expect(r).toBeNull();
  });
});
