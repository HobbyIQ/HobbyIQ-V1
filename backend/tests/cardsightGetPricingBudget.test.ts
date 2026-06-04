// CF-OPS-HARDENING-1a (2026-06-04): getPricing budget instrumentation
// coverage. The Azure Monitor budget alert against Cardsight's 100k/mo
// soft quota only works if:
//
//   1. Every LIVE call increments the live_calls counter.
//   2. Cache HITS do not increment (they don't draw from quota).
//   3. The hourly delta emit resets the counter (so MTD totals come from
//      summing all emitted events, not from a single ever-growing value).
//
// These three invariants are pinned here so a future refactor can't
// silently drift the budget signal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPricing,
  __getPricingLiveCallCountForTests,
  __resetGetPricingBudgetForTests,
  __emitGetPricingBudgetForTests,
} from "../src/services/compiq/cardsight.client";

process.env.CARDSIGHT_API_KEY = "test-key";

function jsonRes(body: any, status: number = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RICH_BODY = {
  card: { card_id: "abc", name: "Test Player" },
  raw: { count: 5, records: [{ price: 1, date: "2026-06-04", source: "ebay", title: "x" }] },
  graded: [
    {
      company_name: "PSA",
      grades: [
        { grade_value: "10", records: [{ price: 100, date: "2026-06-04", source: "ebay", title: "x" }] },
      ],
    },
  ],
  meta: { total_records: 5, last_sale_date: "2026-06-04" },
};

const EMPTY_BODY = {
  card: { card_id: "abc", name: "Test Player" },
  raw: { count: 0, records: [] },
  graded: [],
  meta: { total_records: 0, last_sale_date: null },
};

let _seq = 0;
function uniqueCardId(): string {
  _seq += 1;
  return `budget-${_seq}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  __resetGetPricingBudgetForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  __resetGetPricingBudgetForTests();
});

describe("getPricing budget counter", () => {
  it("LIVE call increments live_calls by 1", async () => {
    const cardId = uniqueCardId();
    (globalThis.fetch as any).mockResolvedValueOnce(jsonRes(RICH_BODY));

    expect(__getPricingLiveCallCountForTests()).toBe(0);
    const r = await getPricing(cardId, {});
    expect(r.raw?.count).toBe(5);
    expect(__getPricingLiveCallCountForTests()).toBe(1);
  });

  it("CACHE HIT does NOT increment live_calls", async () => {
    const cardId = uniqueCardId();
    (globalThis.fetch as any).mockResolvedValueOnce(jsonRes(RICH_BODY));

    // First call: live (miss → counter 1).
    await getPricing(cardId, {});
    expect(__getPricingLiveCallCountForTests()).toBe(1);

    // Second call with same cardId + no parallelId hits the in-memory
    // cacheWrap entry — must NOT bump the counter, and must NOT call fetch.
    await getPricing(cardId, {});
    expect(__getPricingLiveCallCountForTests()).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("parallel_id empty-response FALLBACK counts BOTH HTTP calls (firstPass + fallback)", async () => {
    // The first pass with parallel_id returns empty, triggering the
    // fallback to call _getPricingRaw a SECOND time without parallel_id.
    // Both calls hit Cardsight; both must increment the budget counter.
    const cardId = uniqueCardId();
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonRes(EMPTY_BODY))
      .mockResolvedValueOnce(jsonRes(RICH_BODY));

    const r = await getPricing(cardId, { parallelId: "some-parallel-id" });
    expect(r.raw?.count).toBe(5);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(__getPricingLiveCallCountForTests()).toBe(2);
  });

  it("hourly emit produces a structured log line AND resets the counter", async () => {
    const cardId1 = uniqueCardId();
    const cardId2 = uniqueCardId();
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonRes(RICH_BODY))
      .mockResolvedValueOnce(jsonRes(RICH_BODY));

    await getPricing(cardId1, {});
    await getPricing(cardId2, {});
    expect(__getPricingLiveCallCountForTests()).toBe(2);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    __emitGetPricingBudgetForTests();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const emitted = (logSpy.mock.calls[0]?.[0] as string) ?? "";
    const parsed = JSON.parse(emitted);
    expect(parsed.event).toBe("cardsight_getpricing_budget");
    expect(parsed.live_calls).toBe(2);
    expect(parsed.month).toMatch(/^\d{4}-\d{2}$/);
    expect(typeof parsed.instance).toBe("string");
    // Reset must zero the counter so the NEXT hour's delta starts fresh.
    expect(__getPricingLiveCallCountForTests()).toBe(0);
    logSpy.mockRestore();
  });
});
