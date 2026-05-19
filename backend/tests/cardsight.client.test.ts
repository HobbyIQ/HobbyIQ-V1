/**
 * Unit tests for cardsight.client.ts
 *
 * All HTTP calls are mocked at global.fetch. The cache service falls back to
 * in-memory (no REDIS_HOST in test env) so unique query strings are used per
 * test to avoid cross-test cache hits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  searchCatalog,
  getCardDetail,
  getPricing,
  fetchWithRetry,
  CardsightApiError,
  CardsightTimeoutError,
} from "../src/services/compiq/cardsight.client.js";
// CardsightApiError is used in fetchWithRetry unit tests only; getPricing gracefully degrades on exhausted retries.

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_CATALOG_CARD = {
  id: "cs-001",
  name: "Shohei Ohtani",
  number: "700",
  releaseName: "Topps Chrome",
  setName: "Base Set",
  year: 2018,
};

const MOCK_DETAIL = {
  id: "cs-001",
  name: "Shohei Ohtani",
  number: "700",
  releaseName: "Topps Chrome",
  setName: "Base Set",
  year: 2018,
  parallels: [
    { id: "par-001", name: "Refractor", numberedTo: null },
    { id: "par-002", name: "Blue Refractor", numberedTo: 150 },
  ],
};

const MOCK_PRICING = {
  card: MOCK_CATALOG_CARD,
  raw: {
    count: 2,
    records: [
      { title: "Ohtani 2018 Topps Chrome Raw", price: 45.00, date: "2026-05-10", source: "ebay", url: null },
      { title: "Ohtani 2018 Topps Chrome Raw #2", price: 42.00, date: "2026-05-08", source: "ebay", url: null },
    ],
  },
  graded: [
    {
      company_name: "PSA",
      grades: [
        {
          grade_value: "10",
          count: 5,
          records: [
            { title: "Ohtani 2018 Topps Chrome PSA 10", price: 95.00, date: "2026-05-09", source: "ebay", url: null },
          ],
        },
      ],
    },
  ],
  meta: { total_records: 3, last_sale_date: "2026-05-10" },
};

// ─── Fetch Mock Helpers ───────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: "api error" }),
  } as unknown as Response;
}

// ─── Test Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.CARDSIGHT_API_KEY = "test-api-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CARDSIGHT_API_KEY;
});

// ─── searchCatalog ────────────────────────────────────────────────────────────

describe("searchCatalog", () => {
  it("returns [] and warns when CARDSIGHT_API_KEY is missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await searchCatalog("Ohtani Topps Chrome missing-key-test");
    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
    const line = String(logSpy.mock.calls[0][0]);
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("WARN");
    expect(parsed.module).toBe("cardsight.client");
    expect(parsed.event).toBe("api_key_missing");
    expect(parsed.endpoint).toBe("searchCatalog");
  });

  it("always includes segment=baseball in the query string", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ results: [] });
    });
    await searchCatalog("Ohtani segment-test-unique1");
    expect(capturedUrl).toContain("segment=baseball");
  });

  it("includes year param when provided", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ results: [] });
    });
    await searchCatalog("Ohtani year-test-unique1", { year: 2018 });
    expect(capturedUrl).toContain("year=2018");
  });

  it("does NOT include year param when omitted", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ results: [] });
    });
    await searchCatalog("Ohtani no-year-test-unique1");
    expect(capturedUrl).not.toContain("year=");
  });

  it("includes take param when provided", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse({ results: [] });
    });
    await searchCatalog("Ohtani take-test-unique1", { take: 10 });
    expect(capturedUrl).toContain("take=10");
  });

  it("includes X-API-Key header in request", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse({ results: [] });
    });
    await searchCatalog("Ohtani header-test-unique1");
    expect(capturedHeaders["X-API-Key"]).toBe("test-api-key");
  });

  it("returns mapped results array from API response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ results: [MOCK_CATALOG_CARD] }),
    );
    const result = await searchCatalog("Ohtani result-map-test-unique1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("cs-001");
    expect(result[0].releaseName).toBe("Topps Chrome");
  });

  it("returns [] when API returns empty results array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ results: [] }));
    const result = await searchCatalog("Ohtani empty-results-unique1");
    expect(result).toEqual([]);
  });

  it("returns [] on non-OK HTTP response (retries exhaust without throw)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch").mockResolvedValue(errorResponse(503));
    const pending = searchCatalog("Ohtani 503-test-unique1");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toEqual([]);
    vi.useRealTimers();
  });

  it("retries once on 429 then returns results", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return errorResponse(429);
      return jsonResponse({ results: [MOCK_CATALOG_CARD] });
    });
    const pending = searchCatalog("Ohtani retry-429-unique1");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(callCount).toBe(2);
    expect(result).toHaveLength(1);
    vi.useRealTimers();
  });

  it("throws CardsightTimeoutError when fetch signals AbortError", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(
      Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
    );
    await expect(searchCatalog("Ohtani timeout-test-unique1")).rejects.toThrow(
      CardsightTimeoutError,
    );
  });

  it("throws CardsightTimeoutError when fetch signals TimeoutError", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    );
    await expect(searchCatalog("Ohtani timeouterr-unique1")).rejects.toThrow(
      CardsightTimeoutError,
    );
  });
});

// ─── getCardDetail ────────────────────────────────────────────────────────────

describe("getCardDetail", () => {
  it("returns { notFound: true } sentinel on 404", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response,
    );
    const result = await getCardDetail("cs-notfound-unique1");
    expect(result.notFound).toBe(true);
    expect(result.id).toBe("cs-notfound-unique1");
  });

  it("does NOT throw on 404 — returns sentinel", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response,
    );
    await expect(getCardDetail("cs-404-no-throw-unique1")).resolves.not.toThrow();
  });

  it("returns parallels array from API response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(MOCK_DETAIL));
    const result = await getCardDetail("cs-parallel-test-unique1");
    expect(result.parallels).toHaveLength(2);
    expect(result.parallels[0].name).toBe("Refractor");
    expect(result.parallels[1].numberedTo).toBe(150);
  });

  it("returns { notFound: true } when CARDSIGHT_API_KEY is missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const result = await getCardDetail("cs-nokey-detail-unique1");
    expect(result.notFound).toBe(true);
  });

  it("returns { notFound: true } on non-OK server error (retries exhaust without throw)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch").mockResolvedValue(errorResponse(500));
    const pending = getCardDetail("cs-500-detail-unique1");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.notFound).toBe(true);
    vi.useRealTimers();
  });
});

// ─── getPricing ───────────────────────────────────────────────────────────────

describe("getPricing", () => {
  it("returns raw and graded records from API response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(MOCK_PRICING));
    const result = await getPricing("cs-pricing-full-unique1");
    expect(result.raw.records).toHaveLength(2);
    expect(result.graded).toHaveLength(1);
    expect(result.graded[0].company_name).toBe("PSA");
  });

  it("does NOT include parallel_id param when parallelId is not provided", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse(MOCK_PRICING);
    });
    await getPricing("cs-no-parallel-unique1");
    expect(capturedUrl).not.toContain("parallel_id");
  });

  it("includes parallel_id param when parallelId is provided", async () => {
    let capturedUrl = "";
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse(MOCK_PRICING);
    });
    await getPricing("cs-with-parallel-unique1", { parallelId: "par-001" });
    expect(capturedUrl).toContain("parallel_id=par-001");
  });

  it("returns { notFound: true } sentinel on 404", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response,
    );
    const result = await getPricing("cs-pricing-404-unique1");
    expect(result.notFound).toBe(true);
    expect(result.raw.records).toHaveLength(0);
    expect(result.graded).toHaveLength(0);
  });

  it("does NOT throw on 404 — returns sentinel", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response,
    );
    await expect(getPricing("cs-pricing-404-nothrow-unique1")).resolves.not.toThrow();
  });

  it("returns empty pricing shape when CARDSIGHT_API_KEY is missing", async () => {
    delete process.env.CARDSIGHT_API_KEY;
    const result = await getPricing("cs-nokey-pricing-unique1");
    expect(result.notFound).toBe(true);
    expect(result.raw.records).toHaveLength(0);
  });

  it("returns empty pricing after max retries on 500 (graceful degradation)", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      callCount++;
      return errorResponse(500);
    });
    const pending = getPricing("cs-500-exhausted-unique1");
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.raw.records).toHaveLength(0);
    expect(result.graded).toHaveLength(0);
    expect(callCount).toBe(4); // initial + 3 retries
    vi.useRealTimers();
  });
});

// ─── fetchWithRetry (unit) ────────────────────────────────────────────────────

describe("fetchWithRetry", () => {
  it("does not retry on 4xx client errors (except 429)", async () => {
    let callCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      callCount++;
      return errorResponse(400);
    });
    await expect(fetchWithRetry("https://api.cardsight.ai/v1/test")).rejects.toThrow(
      CardsightApiError,
    );
    expect(callCount).toBe(1);
  });

  it("throws CardsightApiError with correct status on non-retryable 4xx", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(errorResponse(403));
    await expect(fetchWithRetry("https://api.cardsight.ai/v1/test2")).rejects.toMatchObject({
      name: "CardsightApiError",
      status: 403,
    });
  });
});
