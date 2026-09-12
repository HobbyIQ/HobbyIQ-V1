// CF-EBAY-FETCH-TIMEOUTS (2026-09-12, follow-up to PR #2072's
// deal-scanner-silent fix). Pins that defaultFetchPage — the REAL
// getOrders fetch implementation, not the swappable _fetchPageImpl test
// seam — now carries an AbortSignal.
//
// ebayOrderPoll.test.ts deliberately never stubs global fetch (see its own
// header comment); every test there swaps __ebayOrderPollInternals's
// fetch-page impl instead, which is the right call for testing
// pollEbayOrdersForUser's orchestration. But that means nothing exercises
// defaultFetchPage itself — the function that actually talks to eBay and is
// the one this incident's fix touches. This file is the deliberate
// exception: it stubs global fetch, on purpose, to look past that seam.

import { describe, it, expect, vi, afterEach } from "vitest";
import { __ebayOrderPollInternals } from "../src/services/ebay/ebayOrderPoll.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ebayOrderPoll.service — defaultFetchPage carries a timeout signal", () => {
  it("passes an AbortSignal to fetch", async () => {
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ orders: [] }),
    }));
    vi.stubGlobal("fetch", fetchStub);

    const result = await __ebayOrderPollInternals.defaultFetchPage(
      "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?limit=50",
      "mock-token",
    );
    expect(result).toEqual({ orders: [] });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an abort/timeout error throws the same way any other getOrders HTTP failure already does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }));

    await expect(
      __ebayOrderPollInternals.defaultFetchPage(
        "https://api.sandbox.ebay.com/sell/fulfillment/v1/order?limit=50",
        "mock-token",
      ),
    ).rejects.toThrow();
  });
});
