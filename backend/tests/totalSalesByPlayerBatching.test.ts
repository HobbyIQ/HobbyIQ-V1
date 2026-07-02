// CF-CH-TOTAL-SALES-BATCH-LIMIT (2026-07-02) — pin the chunked-batching
// contract for getTotalSalesByPlayer.
//
// PRIOR-CF GAP: CardHedge's /cards/total-sales-by-player silently returns
// {results:[], days:null} when the request body carries more than ~20
// players — no error, no HTTP failure, just an empty results array. The
// DailyIQ matched-cohort job was passing all 60+ portfolio players in one
// call and getting zero data back, so `topVolume30d` in the DailyIQ
// market-players payload was stuck empty.
//
// Fix: chunk internally at 20 players per HTTP call, run chunks
// concurrently, merge results. Cache key unchanged (still keyed on the
// full sorted player list) so cache semantics are byte-identical to
// pre-CF for callers.
//
// THIS FILE PINS:
//   1. ≤20 players → single upstream call (no chunking)
//   2. >20 players → chunked into ceil(n/20) calls, all results merged
//   3. Chunk with an upstream failure returns null; other chunks still
//      contribute (partial data preferable to zero data)
//   4. Empty players[] → no call, returns null (invariant preserved)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the fetch layer so we control what CH's HTTP call returns.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  process.env.CARD_HEDGE_API_KEY = "test-key-for-batching";
  // Prevent cacheWrap collisions across tests.
  process.env.REDIS_HOST = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

async function importModuleFresh() {
  vi.resetModules();
  return await import("../src/services/compiq/cardhedge.client.js");
}

/** Build a fake CH response body for `n` players. */
function fakeResponse(players: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: players.map((p) => ({
        player: p,
        total_sales: 100 + p.length,
      })),
      days: 30,
    }),
  };
}

describe("getTotalSalesByPlayer — CH batch-limit workaround", () => {
  it("≤20 players → 1 upstream call, all results returned", async () => {
    const mod = await importModuleFresh();
    const players = Array.from({ length: 15 }, (_, i) => `Player${i + 1}`);
    fetchMock.mockResolvedValueOnce(fakeResponse(players));

    const res = await mod.getTotalSalesByPlayer(players);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res).not.toBeNull();
    expect(res!.results.length).toBe(15);
    expect(res!.days).toBe(30);
  });

  it("21 players → 2 upstream calls (20 + 1), results merged", async () => {
    const mod = await importModuleFresh();
    const players = Array.from({ length: 21 }, (_, i) => `Player${i + 1}`);
    fetchMock
      .mockResolvedValueOnce(fakeResponse(players.slice(0, 20)))
      .mockResolvedValueOnce(fakeResponse(players.slice(20)));

    const res = await mod.getTotalSalesByPlayer(players);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res!.results.length).toBe(21);
  });

  it("60 players → 3 upstream calls (20 + 20 + 20), results merged", async () => {
    const mod = await importModuleFresh();
    const players = Array.from({ length: 60 }, (_, i) => `Player${i + 1}`);
    fetchMock
      .mockResolvedValueOnce(fakeResponse(players.slice(0, 20)))
      .mockResolvedValueOnce(fakeResponse(players.slice(20, 40)))
      .mockResolvedValueOnce(fakeResponse(players.slice(40, 60)));

    const res = await mod.getTotalSalesByPlayer(players);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res!.results.length).toBe(60);
    // Every original player appears exactly once in the merged output.
    const merged = new Set(res!.results.map((r) => r.player));
    expect(merged.size).toBe(60);
    for (const p of players) expect(merged.has(p)).toBe(true);
  });

  it("one chunk fails → other chunks still contribute (partial data)", async () => {
    const mod = await importModuleFresh();
    const players = Array.from({ length: 40 }, (_, i) => `Player${i + 1}`);
    // First chunk succeeds, second throws.
    fetchMock
      .mockResolvedValueOnce(fakeResponse(players.slice(0, 20)))
      .mockRejectedValueOnce(new Error("CH 500"));

    const res = await mod.getTotalSalesByPlayer(players);

    expect(res).not.toBeNull();
    // Only the successful chunk's rows survive.
    expect(res!.results.length).toBe(20);
    expect(res!.results.every((r) => players.slice(0, 20).includes(r.player))).toBe(true);
  });

  it("empty players[] → no upstream call, returns null", async () => {
    const mod = await importModuleFresh();
    const res = await mod.getTotalSalesByPlayer([]);
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
