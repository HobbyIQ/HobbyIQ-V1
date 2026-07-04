// CF-CH-ADDITIONS-SUMMARY (2026-07-04) — pins getAdditionsSummary wrapper.

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

describe("CF-CH-ADDITIONS-SUMMARY — getAdditionsSummary", () => {
  it("POSTs to /cards/additions-summary with start_date + defaults", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], page: 1, page_size: 50 }),
    });
    const { getAdditionsSummary } = await import("../src/services/compiq/cardhedge.client.js");
    await getAdditionsSummary({ startDate: "2026-06-01" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/cards/additions-summary");
    const body = JSON.parse(opts.body as string);
    expect(body.start_date).toBe("2026-06-01");
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
  });

  it("optional filters land in the body only when set", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], page: 2, page_size: 25 }),
    });
    const { getAdditionsSummary } = await import("../src/services/compiq/cardhedge.client.js");
    await getAdditionsSummary({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      category: "Baseball",
      setName: "2024 Bowman",
      page: 2,
      pageSize: 25,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      category: "Baseball",
      set_name: "2024 Bowman",
      page: 2,
      page_size: 25,
    });
  });

  it("returns null when API key missing or startDate empty", async () => {
    const { getAdditionsSummary } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getAdditionsSummary({ startDate: "" })).toBeNull();
    delete process.env.CARD_HEDGE_API_KEY;
    expect(await getAdditionsSummary({ startDate: "2026-06-01" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns default shape on malformed response body", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ garbage: true }) });
    const { getAdditionsSummary } = await import("../src/services/compiq/cardhedge.client.js");
    const r = await getAdditionsSummary({ startDate: "2026-06-01" });
    expect(r?.data).toEqual([]);
    expect(r?.page).toBe(1);
    expect(r?.page_size).toBe(50);
  });

  it("returns null on non-2xx status / thrown fetch", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const { getAdditionsSummary } = await import("../src/services/compiq/cardhedge.client.js");
    expect(await getAdditionsSummary({ startDate: "2026-06-01" })).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("boom"));
    expect(await getAdditionsSummary({ startDate: "2026-06-01" })).toBeNull();
  });
});
