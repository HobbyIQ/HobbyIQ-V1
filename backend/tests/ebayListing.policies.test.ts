/**
 * D.1 — Inline seller-policy resolution tests.
 *
 * Covers the four-state contract for resolveSellerPolicies():
 *   1. Zero policies of a type           → MissingSellerPolicyError("none_configured")
 *   2. Exactly one policy                → use it
 *   3. Multiple with one default-flagged → use the default
 *   4. Multiple, none default-flagged    → MissingSellerPolicyError("no_default_among_multiple")
 *
 * Plus:
 *   - Explicit input-side overrides (all three) bypass the inline fetch.
 *   - buildListingPreview never throws on policy gaps; surfaces warnings + missingPolicy.
 *
 * eBay HTTP traffic is faked by stubbing global.fetch. Auth token retrieval
 * is mocked via vi.mock on the auth service module so we don't touch Cosmos.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  EBAY_BASE_API: "https://api.sandbox.ebay.com",
  getAccessToken: vi.fn(async () => "fake-access-token"),
}));

import {
  resolveSellerPolicies,
  buildListingPreview,
  MissingSellerPolicyError,
  type HoldingListingInput,
} from "../src/services/ebay/ebayListing.service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

interface PolicyShape {
  paymentPolicies?: Array<{ paymentPolicyId: string; name: string; categoryTypes?: Array<{ default?: boolean }> }>;
  fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name: string; categoryTypes?: Array<{ default?: boolean }> }>;
  returnPolicies?: Array<{ returnPolicyId: string; name: string; categoryTypes?: Array<{ default?: boolean }> }>;
}

/**
 * Install a global.fetch stub that routes the three eBay account-policy URLs
 * to the corresponding payload from `shapes`.
 */
function stubEbayFetch(shapes: PolicyShape): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    let body: unknown;
    if (u.includes("/payment_policy"))         body = { paymentPolicies:     shapes.paymentPolicies     ?? [] };
    else if (u.includes("/fulfillment_policy")) body = { fulfillmentPolicies: shapes.fulfillmentPolicies ?? [] };
    else if (u.includes("/return_policy"))      body = { returnPolicies:      shapes.returnPolicies      ?? [] };
    else                                        body = {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  // Defensive defaults so a missing stub is obvious.
  global.fetch = vi.fn(async () => {
    throw new Error("fetch not stubbed");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveSellerPolicies
// ---------------------------------------------------------------------------

describe("resolveSellerPolicies — four-state contract", () => {
  it("uses explicit input overrides without any HTTP call when all three are provided", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveSellerPolicies("user-1", makeInput({
      paymentPolicyId:     "pay-X",
      returnPolicyId:      "ret-X",
      fulfillmentPolicyId: "ful-X",
    }));

    expect(result).toEqual({
      paymentPolicyId:     "pay-X",
      returnPolicyId:      "ret-X",
      fulfillmentPolicyId: "ful-X",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-picks the single policy when exactly one of each type exists", async () => {
    stubEbayFetch({
      paymentPolicies:     [{ paymentPolicyId:     "pay-1", name: "Default Pay" }],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard Ship" }],
      returnPolicies:      [{ returnPolicyId:      "ret-1", name: "30-day" }],
    });

    const result = await resolveSellerPolicies("user-1", makeInput());

    expect(result).toEqual({
      paymentPolicyId:     "pay-1",
      returnPolicyId:      "ret-1",
      fulfillmentPolicyId: "ful-1",
    });
  });

  it("picks the default-flagged policy when multiple exist", async () => {
    stubEbayFetch({
      paymentPolicies: [
        { paymentPolicyId: "pay-1", name: "Old",     categoryTypes: [{ default: false }] },
        { paymentPolicyId: "pay-2", name: "Current", categoryTypes: [{ default: true  }] },
      ],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard" }],
      returnPolicies:      [{ returnPolicyId:      "ret-1", name: "30-day"   }],
    });

    const result = await resolveSellerPolicies("user-1", makeInput());
    expect(result.paymentPolicyId).toBe("pay-2");
  });

  it("throws MissingSellerPolicyError(none_configured) when a type has zero policies", async () => {
    stubEbayFetch({
      paymentPolicies:     [],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard" }],
      returnPolicies:      [{ returnPolicyId:      "ret-1", name: "30-day"   }],
    });

    const err = await resolveSellerPolicies("user-1", makeInput()).catch(e => e);
    expect(err).toBeInstanceOf(MissingSellerPolicyError);
    expect((err as MissingSellerPolicyError).policyType).toBe("payment");
    expect((err as MissingSellerPolicyError).reason).toBe("none_configured");
  });

  it("throws MissingSellerPolicyError(no_default_among_multiple) when multiple exist with no default", async () => {
    stubEbayFetch({
      paymentPolicies:     [{ paymentPolicyId: "pay-1", name: "A" }],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard" }],
      returnPolicies: [
        { returnPolicyId: "ret-1", name: "30-day", categoryTypes: [{ default: false }] },
        { returnPolicyId: "ret-2", name: "60-day", categoryTypes: [{ default: false }] },
      ],
    });

    const err = await resolveSellerPolicies("user-1", makeInput()).catch(e => e);
    expect(err).toBeInstanceOf(MissingSellerPolicyError);
    expect((err as MissingSellerPolicyError).policyType).toBe("return");
    expect((err as MissingSellerPolicyError).reason).toBe("no_default_among_multiple");
  });
});

// ---------------------------------------------------------------------------
// buildListingPreview
// ---------------------------------------------------------------------------

describe("buildListingPreview — never throws on policy gaps", () => {
  it("attaches resolved policies when the user's account is fully configured", async () => {
    stubEbayFetch({
      paymentPolicies:     [{ paymentPolicyId:     "pay-1", name: "Default Pay" }],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard Ship" }],
      returnPolicies:      [{ returnPolicyId:      "ret-1", name: "30-day" }],
    });

    const preview = await buildListingPreview("user-1", makeInput());
    expect(preview.policies).toEqual({
      paymentPolicyId:     "pay-1",
      returnPolicyId:      "ret-1",
      fulfillmentPolicyId: "ful-1",
    });
    expect(preview.missingPolicy).toBeUndefined();
    expect(preview.warnings).toEqual([]);
    // Title contract is covered in ebayListing.buildTitle.test.ts —
    // CF-EBAY-TITLE-HONOR-AND-FALLBACK (910264d) reshaped buildTitle into
    // an HONOR/FALLBACK two-stage resolver, so a fixture that supplies
    // both cardTitle and playerName lands on the HONOR PATH and returns
    // cardTitle verbatim. These policy tests intentionally stay focused
    // on the policy plumbing.
  });

  it("surfaces missingPolicy + warning instead of throwing when a policy is missing", async () => {
    stubEbayFetch({
      paymentPolicies:     [],
      fulfillmentPolicies: [{ fulfillmentPolicyId: "ful-1", name: "Standard" }],
      returnPolicies:      [{ returnPolicyId:      "ret-1", name: "30-day"   }],
    });

    const preview = await buildListingPreview("user-1", makeInput());
    expect(preview.policies).toBeUndefined();
    expect(preview.missingPolicy).toEqual({ policyType: "payment", reason: "none_configured" });
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.warnings[0]).toMatch(/payment/i);
    // Preview body still rendered so iOS can show the card — sanity-check
    // by reading a non-title field rather than asserting title shape (the
    // title contract is owned by ebayListing.buildTitle.test.ts).
    expect(preview.price).toBe(19.99);
  });
});
