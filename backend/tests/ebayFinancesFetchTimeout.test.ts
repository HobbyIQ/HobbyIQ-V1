// CF-EBAY-FETCH-TIMEOUTS (2026-09-12, follow-up to PR #2072's
// deal-scanner-silent fix). Pins that fetchFinancesPage — the REAL fetch
// implementation getTransactionsForOrder uses by default — now carries an
// AbortSignal, and that an abort/timeout error is treated exactly like any
// other page-fetch failure the function already handles: null when no pages
// succeeded yet, or the partial list when at least one page had already
// landed.
//
// Every other Finances test exercises the pure mapper only (see
// ebayFinances.mapper.test.ts / ebayFinances.d34FeeLines.test.ts) or swaps
// _fetchPageImpl directly (see ebayFinancesEnrichmentJob*.test.ts) — neither
// touches the real fetchFinancesPage, which is what this file pins.

import { describe, it, expect, vi, afterEach } from "vitest";

function mockAuth(token: string | null = "mock-token") {
  vi.doMock("../src/services/ebay/ebayAuth.service.js", async (orig) => {
    const actual = await orig<any>();
    return {
      ...actual,
      getAccessToken: token
        ? async () => token
        : async () => { throw new Error("not connected"); },
    };
  });
}

afterEach(() => {
  vi.doUnmock("../src/services/ebay/ebayAuth.service.js");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("ebayFinances.service — fetchFinancesPage carries a timeout signal", () => {
  it("passes an AbortSignal to fetch", async () => {
    mockAuth();
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ transactions: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    const { getTransactionsForOrder } = await import("../src/services/ebay/ebayFinances.service.js");
    const result = await getTransactionsForOrder("user-1", "order-1");
    expect(result).toEqual([]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an abort/timeout on the first page returns null (same shape as any other first-page failure)", async () => {
    mockAuth();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }));

    const { getTransactionsForOrder } = await import("../src/services/ebay/ebayFinances.service.js");
    const result = await getTransactionsForOrder("user-1", "order-1");
    expect(result).toBeNull();
  });
});
