// CF-CARDSIGHT-CACHE (Drew, 2026-07-14): pins the cacheWrap behavior on
// Cardsight's searchCatalog + getCardDetail. Verify Card sheet's edit
// loop fires dry-run-suggest on every keystroke — CS calls used to cost
// ~350ms cold per call because both functions had zero caching.
//
// Each test uses a locally-captured nonce for query/cardId so
// cross-test cache contamination is structurally impossible (defense
// in depth alongside store.clear() in beforeEach).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as cacheMod from "../src/services/shared/cache.service.js";
import { searchCatalog, getCardDetail } from "../src/services/compiq/cardsightSlim.client.js";

const store = new Map<string, string>();
const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;
let nonce = 0;
function uniq(): string { return `probe-${nonce++}`; }

beforeEach(() => {
  store.clear();
  fetchMock.mockReset();
  process.env.CARDSIGHT_API_KEY = "test-key";
  vi.spyOn(cacheMod, "cacheGet").mockImplementation(async (k: string) => store.get(k) ?? null);
  vi.spyOn(cacheMod, "cacheSet").mockImplementation(async (k: string, v: string) => {
    store.set(k, v);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("searchCatalog — cacheWrap", () => {
  it("second identical call returns cached result without a second HTTP fetch", async () => {
    const query = uniq();
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        results: [{
          id: "cs-1", name: "Eric Hartman", number: "CPA-EHA",
          releaseName: "2026 Bowman", setName: "2026 Bowman", year: 2026, player: "Eric Hartman",
        }],
      }),
    });

    const first = await searchCatalog(query, { take: 5 });
    const second = await searchCatalog(query, { take: 5 });

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("different take (5 vs 10) cache-keys separately", async () => {
    const query = uniq();
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ results: [{ id: "cs-1" }] }),
    });
    await searchCatalog(query, { take: 5 });
    await searchCatalog(query, { take: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("empty result is NOT cached (transient vendor blips shouldn't blackhole)", async () => {
    const query = uniq();
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ results: [] }),
    });
    const first = await searchCatalog(query, { take: 5 });
    expect(first).toEqual([]);

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ results: [{ id: "cs-1" }] }),
    });
    const second = await searchCatalog(query, { take: 5 });
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP error is NOT cached (empty result triggers skipCacheWhen)", async () => {
    const query = uniq();
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500,
      json: async () => ({ error: "vendor down" }),
    });
    const first = await searchCatalog(query, { take: 5 });
    expect(first).toEqual([]);

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ results: [{ id: "cs-1" }] }),
    });
    const second = await searchCatalog(query, { take: 5 });
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("getCardDetail — cacheWrap", () => {
  it("second call for the same cardId returns cached detail without a re-fetch", async () => {
    const cardId = "cs-" + uniq();
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: cardId, name: "Eric Hartman", number: "CPA-EHA",
        releaseName: "2026 Bowman", setName: "2026 Bowman", year: 2026,
        parallels: [{ id: "p1", name: "Blue Refractor" }],
      }),
    });

    const first = await getCardDetail(cardId);
    const second = await getCardDetail(cardId);

    expect(first?.parallels).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("different cardIds cache-key separately", async () => {
    const cardIdA = "cs-" + uniq();
    const cardIdB = "cs-" + uniq();
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: "x", name: "n", number: "1", releaseName: "r", setName: "s", year: 2026, parallels: [] }),
    });
    await getCardDetail(cardIdA);
    await getCardDetail(cardIdB);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("null result (404) is NOT cached", async () => {
    const cardId = "cs-" + uniq();
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 404,
      json: async () => null,
    });
    const first = await getCardDetail(cardId);
    expect(first).toBeNull();

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: cardId, name: "Recovered", number: "CPA-EHA",
        releaseName: "2026", setName: "2026", year: 2026, parallels: [],
      }),
    });
    const second = await getCardDetail(cardId);
    expect(second?.name).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("no CARDSIGHT_API_KEY → no fetch, no cache pollution", () => {
  it("searchCatalog short-circuits when key missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const r = await searchCatalog(uniq());
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getCardDetail short-circuits when key missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const r = await getCardDetail("cs-" + uniq());
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
