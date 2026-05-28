/**
 * CF-CARDSIGHT-RESOLVER-COMPREHENSIVE (parallel_id fallback) — getPricing
 * must retry without parallel_id when the filtered response is empty.
 *
 * Empirical finding 2026-05-27: Cardsight's /pricing/{cardId}?parallel_id=X
 * returns ZERO raw/graded records for cards where the unified /pricing/
 * {cardId} returns hundreds. Cardsight doesn't tag eBay sales by
 * parallelId; the catalog parallels[] is metadata only. Without fallback,
 * cards with verbose-wrapper parallel names (e.g. Maddux Tiffany's
 * "Limited Edition (Tiffany)") get null parallelId pre-fix or empty
 * comps post-fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetchWithRetry to control responses precisely.
// Note: we mock the entire cardsight.client module's internal fetch via
// vi.stubGlobal on fetch since fetchWithRetry uses global fetch.

import { getPricing } from "../src/services/compiq/cardsight.client";

process.env.CARDSIGHT_API_KEY = "test-key";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonRes(body: any, status: number = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EMPTY_PRICING_BODY = {
  card: null,
  raw: { count: 0, records: [] },
  graded: [],
  meta: { total_records: 0, last_sale_date: null },
};

const RICH_PRICING_BODY = {
  card: { card_id: "abc", name: "Greg Maddux" },
  raw: { count: 156, records: [{ price: 6.99, date: "2026-05-27", source: "ebay", title: "Greg Maddux 1987 Topps Traded RC #70T" }] },
  graded: [
    {
      company_name: "PSA",
      grades: [
        { grade_value: "10", records: [{ price: 1599.99, date: "2026-05-27", source: "ebay", title: "GREG MADDUX 1987 Topps Traded Tiffany PSA 10 RC" }] },
      ],
    },
  ],
  meta: { total_records: 156, last_sale_date: "2026-05-27" },
};

// cardsight.client wraps getPricing in cacheWrap (in-memory Map without
// REDIS_HOST). Cache key includes cardId + parallelId, so each test
// uses a unique cardId to bypass cache pollution.
let _testIdSeq = 0;
function uniqueCardId(): string {
  _testIdSeq += 1;
  return `test-card-${Date.now()}-${_testIdSeq}`;
}

describe("getPricing — parallel_id empty-response fallback", () => {
  it("WITHOUT parallel_id: returns the unified response as-is (no fallback path)", async () => {
    const cardId = uniqueCardId();
    const mock = (globalThis.fetch as any).mockResolvedValueOnce(
      jsonRes(RICH_PRICING_BODY),
    );

    const r = await getPricing(cardId, {});

    expect(r.raw?.count).toBe(156);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0][0] as string)).not.toContain("parallel_id=");
  });

  it("WITH parallel_id, filter returns DATA: returns first-pass response (no fallback)", async () => {
    const cardId = uniqueCardId();
    const filteredBody = {
      ...RICH_PRICING_BODY,
      raw: { count: 5, records: [{ price: 1200, date: "2026-05-27", source: "ebay", title: "Tiffany only sale" }] },
    };
    const mock = (globalThis.fetch as any).mockResolvedValueOnce(
      jsonRes(filteredBody),
    );

    const r = await getPricing(cardId, { parallelId: "tiffany-id" });

    expect(r.raw?.count).toBe(5);
    expect(mock).toHaveBeenCalledTimes(1);
    expect((mock.mock.calls[0][0] as string)).toContain("parallel_id=tiffany-id");
  });

  it("WITH parallel_id, filter returns EMPTY (raw 0 + graded []): retries WITHOUT parallel_id", async () => {
    const cardId = uniqueCardId();
    // First call: parallel_id filter returns empty
    // Second call: no filter, returns rich data
    const mock = (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonRes(EMPTY_PRICING_BODY))
      .mockResolvedValueOnce(jsonRes(RICH_PRICING_BODY));

    const r = await getPricing(cardId, { parallelId: "tiffany-id" });

    expect(r.raw?.count).toBe(156); // fallback delivered data
    expect(mock).toHaveBeenCalledTimes(2);
    expect((mock.mock.calls[0][0] as string)).toContain("parallel_id=tiffany-id");
    expect((mock.mock.calls[1][0] as string)).not.toContain("parallel_id=");
  });

  it("WITH parallel_id, filter returns raw 0 + graded with empty arrays: still fallback", async () => {
    const cardId = uniqueCardId();
    const emptyButShapedBody = {
      card: null,
      raw: { count: 0, records: [] },
      graded: [], // empty array (length 0)
      meta: { total_records: 0, last_sale_date: null },
    };
    const mock = (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonRes(emptyButShapedBody))
      .mockResolvedValueOnce(jsonRes(RICH_PRICING_BODY));

    const r = await getPricing(cardId, { parallelId: "tiffany-id" });

    expect(r.raw?.count).toBe(156);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("WITH parallel_id, filter returns 404: does NOT fallback (notFound is authoritative)", async () => {
    const cardId = uniqueCardId();
    const mock = (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("", { status: 404 }),
    );

    const r = await getPricing(cardId, { parallelId: "tiffany-id" });

    expect(r.notFound).toBe(true);
    expect(r.raw?.count).toBe(0);
    expect(mock).toHaveBeenCalledTimes(1); // no retry on 404
  });

  it("WITH parallel_id, filter returns raw 0 + graded with HAS records: returns first pass (no fallback)", async () => {
    const cardId = uniqueCardId();
    // The fallback only fires when BOTH raw and graded are empty. If
    // graded has any record, that's data — return it.
    const partialBody = {
      card: null,
      raw: { count: 0, records: [] },
      graded: [{
        company_name: "PSA",
        grades: [{ grade_value: "10", records: [{ price: 1500, date: "2026-05-27", source: "ebay", title: "x" }] }],
      }],
      meta: { total_records: 1, last_sale_date: "2026-05-27" },
    };
    const mock = (globalThis.fetch as any).mockResolvedValueOnce(
      jsonRes(partialBody),
    );

    const r = await getPricing(cardId, { parallelId: "tiffany-id" });

    expect(r.graded.length).toBe(1);
    expect(mock).toHaveBeenCalledTimes(1); // no fallback
  });
});
