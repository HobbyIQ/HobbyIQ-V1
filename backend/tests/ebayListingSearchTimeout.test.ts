// CF-DEAL-SCANNER-SILENT (2026-09-12): the BuyerIQ deal scanner went silent
// from 07:37Z because fetchCardActiveListings' underlying fetch() carried no
// AbortSignal. A stalled TCP connection to eBay Browse hangs the await
// forever; runBuyerIqDealScan is a plain sequential for-loop with no
// cycle-level deadline, so the whole cycle — and the heartbeat write at its
// end — never completes. Every other fetch in the backend times out via
// AbortSignal.timeout (see cardhedge.client.ts's DEFAULT_TIMEOUT_MS); this
// file pins that the eBay listing-search fetches (and the app-token mint
// they depend on) now carry the same guard, and that a hung connection
// rejects instead of hanging the caller forever.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCardActiveListings,
  fetchPlayerListingsSummary,
} from "../src/services/ebay/ebayListingSearch.service.js";
import { _resetAppScopeTokenForTests, _setAppScopeTokenForTests } from "../src/services/ebay/ebayAppToken.service.js";

beforeEach(() => {
  _resetAppScopeTokenForTests();
  _setAppScopeTokenForTests("test-token", Date.now() + 3_600_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  _resetAppScopeTokenForTests();
});

function stubFetchOk(body: unknown) {
  const fetchStub = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("ebayListingSearch — fetch carries a timeout signal", () => {
  it("fetchCardActiveListings passes an AbortSignal to fetch", async () => {
    const fetchStub = stubFetchOk({ total: 0, itemSummaries: [] });
    await fetchCardActiveListings({ player: "Mike Trout", year: 2018, set: "Topps Chrome" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetchPlayerListingsSummary passes an AbortSignal to fetch", async () => {
    const fetchStub = stubFetchOk({ total: 0, itemSummaries: [] });
    await fetchPlayerListingsSummary("user-1", "Mike Trout");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null (never hangs) when fetch rejects with an abort/timeout error", async () => {
    const abortError = new DOMException("The operation was aborted.", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abortError; }));
    const result = await fetchCardActiveListings({ player: "Mike Trout" });
    expect(result).toBeNull();
  });
});
