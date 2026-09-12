// CF-EBAY-FETCH-TIMEOUTS (2026-09-12, follow-up to PR #2072's
// deal-scanner-silent fix). Pins that fetchEbayItemDetails' fetch now
// carries an AbortSignal, and that an abort/timeout error surfaces exactly
// like any other thrown network error already does: fetchEbayItemDetails
// propagates it, and fetchEbayItemDetailsBatch already catches per-item and
// converts to null so one stalled item can't take the whole batch down.

import { describe, it, expect, vi, afterEach } from "vitest";

function mockAuth() {
  vi.doMock("../src/services/ebay/ebayAuth.service.js", async (orig) => {
    const actual = await orig<any>();
    return { ...actual, getAccessToken: async () => "mock-token" };
  });
}

afterEach(() => {
  vi.doUnmock("../src/services/ebay/ebayAuth.service.js");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("ebayItemDetails.service — fetch carries a timeout signal", () => {
  it("fetchEbayItemDetails passes an AbortSignal to fetch", async () => {
    mockAuth();
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ itemId: "v1|123|0", title: "Test Card" }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    const { fetchEbayItemDetails } = await import("../src/services/ebay/ebayItemDetails.service.js");
    const result = await fetchEbayItemDetails("user-1", "v1|123|0");
    expect(result?.title).toBe("Test Card");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchEbayItemDetailsBatch turns a hung/aborted item into null, not a batch failure", async () => {
    mockAuth();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }));

    const { fetchEbayItemDetailsBatch } = await import("../src/services/ebay/ebayItemDetails.service.js");
    const results = await fetchEbayItemDetailsBatch("user-1", ["v1|1|0", "v1|2|0"], 2);
    expect(results).toEqual([null, null]);
  });
});
