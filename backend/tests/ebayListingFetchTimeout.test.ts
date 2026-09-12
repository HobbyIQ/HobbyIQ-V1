// CF-EBAY-FETCH-TIMEOUTS (2026-09-12, follow-up to PR #2072's
// deal-scanner-silent fix). Pins that ebayRequest's fetch — the shared
// primitive every seller-listing operation funnels through — now carries an
// AbortSignal, and that an abort/timeout error propagates the same way any
// other thrown error from ebayRequest already does today: every call site
// (resolveSellerPolicies included) awaits it directly with no local
// try/catch, so a raw network failure was never narrowed to EbayApiError
// only — an AbortError/TimeoutError is just one more "thrown error
// propagates" case, not a new failure shape.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  EBAY_BASE_API: "https://api.sandbox.ebay.com",
  getAccessToken: vi.fn(async () => "fake-access-token"),
}));

import { resolveSellerPolicies, type HoldingListingInput } from "../src/services/ebay/ebayListing.service.js";

function makeInput(overrides: Partial<HoldingListingInput> = {}): HoldingListingInput {
  return {
    holdingId:        "h1",
    playerName:       "Test Player",
    cardTitle:        "Test Card",
    cardYear:         2024,
    brand:            "Topps",
    setName:          "Chrome",
    product:          "Chrome",
    isAuto:           false,
    isPatch:          false,
    isRookie:         false,
    quantity:         1,
    listingPrice:     19.99,
    bestOfferEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  global.fetch = vi.fn(async () => {
    throw new Error("fetch not stubbed");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ebayListing.service — ebayRequest carries a timeout signal", () => {
  it("passes an AbortSignal to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      paymentPolicies: [{ paymentPolicyId: "pay-1", name: "Default" }],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard" }],
      returnPolicies: [{ returnPolicyId: "ret-1", name: "30-day" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await resolveSellerPolicies("user-1", makeInput());
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an abort/timeout error propagates the same way any other thrown ebayRequest error already does", async () => {
    global.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    }) as unknown as typeof fetch;

    await expect(resolveSellerPolicies("user-1", makeInput())).rejects.toThrow();
  });
});
