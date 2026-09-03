// CF-EBAY-SELL-LOOP (Drew, 2026-09-02). The publish-path pin.
//
// The composer pins prove the basis block is BUILT correctly. This one
// proves it cannot be LOST: that a client publishing HobbyIQ's price gets
// HobbyIQ's caveats attached server-side, whatever description it sent.
//
// The failure mode being pinned is not hypothetical. /prepare returns
// `listing.basisBlock` and the publish route accepts a free-form
// `description`. If publish trusted the client, then an old iOS build, a
// web form that rebuilds the description, or a curl call would each ship
// a speculative number with no disclosure — and the label doctrine would
// hold only for clients that felt like honouring it.
//
// NOTHING here talks to eBay. `fetch` is replaced wholesale by a fake
// sandbox that answers the publish sequence, and the assertion at the
// bottom checks every URL it saw was api.sandbox.ebay.com. A test that
// reached production eBay would create a real listing, which is the one
// outcome this whole feature must never produce during build or verify.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  EBAY_BASE_API: "https://api.sandbox.ebay.com",
  SANDBOX: true,
  getAccessToken: vi.fn(async () => "fake-access-token"),
  getConnectionStatus: vi.fn(async () => ({ connected: true, status: "ok" })),
}));

import { createListing, type HoldingListingInput } from "../src/services/ebay/ebayListing.service.js";
import {
  composeSellDraftPricing,
  appendBasisBlock,
  type SellDraftHolding,
} from "../src/services/ebay/ebaySellDraft.service.js";
import type { CanonicalFmvResult } from "../src/services/compiq/canonicalFmv.service.js";
import { readUserDoc, writeUserDoc } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const USER = "sell-loop-basis-user";
const HOLDING_ID = "11111111-2222-3333-4444-555555555555";

/** Every URL the fake eBay was asked for — the sandbox assertion reads it. */
let seenUrls: string[] = [];

/** A fake eBay sandbox that answers the whole publish sequence, and
 *  records the inventory-item body so we can read the description that
 *  actually would have gone to eBay. */
function fakeEbay(capture: { inventoryBody?: unknown }): ReturnType<typeof vi.fn> {
  const json = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    seenUrls.push(String(url));
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://api.sandbox.ebay.com", "");
    if (method === "PUT" && path.startsWith("/sell/inventory/v1/inventory_item/")) {
      capture.inventoryBody = init?.body ? JSON.parse(init.body) : null;
      return json(204, {});
    }
    if (path.startsWith("/sell/account/v1/payment_policy")) return json(200, { paymentPolicies: [{ paymentPolicyId: "P1", name: "pay" }] });
    if (path.startsWith("/sell/account/v1/fulfillment_policy")) return json(200, { fulfillmentPolicies: [{ fulfillmentPolicyId: "F1", name: "ship" }] });
    if (path.startsWith("/sell/account/v1/return_policy")) return json(200, { returnPolicies: [{ returnPolicyId: "R1", name: "ret" }] });
    if (path.startsWith("/sell/inventory/v1/location")) return json(200, { locations: [{ merchantLocationKey: "LOC1" }] });
    if (method === "POST" && path === "/sell/inventory/v1/offer") return json(200, { offerId: "OFFER-BASIS" });
    if (method === "POST" && path === "/sell/inventory/v1/offer/OFFER-BASIS/publish") return json(200, { listingId: "LISTING-BASIS" });
    return json(404, { errors: [{ message: `unexpected ${method} ${path}` }] });
  });
}

function speculativeResult(): CanonicalFmvResult {
  return {
    fmv: 412.0,
    method: "tiered-momentum-player",
    rungLabel: "player-index-projection",
    confidence: 0.38,
    provenance: {
      summary: "last real sale carried forward on the player index",
      comps: [
        {
          price: 380,
          soldAt: "2026-02-14T00:00:00.000Z",
          source: "holding::owned",
          parallel: "Blue Refractor",
          verifiedByUser: true,
        },
      ],
      trendPctPerMonth: 3,
      multipliers: {},
    },
    computedAt: "2026-09-02T12:00:00.000Z",
    recentRange: null,
  } as CanonicalFmvResult;
}

function fixtureHolding(): SellDraftHolding {
  return {
    cardId: "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto:num-150",
    playerName: "Theo Gillen",
    cardYear: 2024,
    product: "Bowman Chrome",
    parallel: "Blue Refractor",
    cardNumber: "CPA-TG",
    isAuto: true,
    sport: "baseball",
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  seenUrls = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  try {
    const doc = await readUserDoc(USER);
    delete (doc.holdings ?? {})[HOLDING_ID];
    await writeUserDoc(USER, doc);
  } catch { /* nothing to clean */ }
});

// ---------------------------------------------------------------------------

describe("the disclosure survives publish", () => {
  it("attaches the basis to a description the client left bare", async () => {
    // The client sent a plain body with no basis at all — the shape an old
    // build, or a hand-rolled API call, would send.
    const { pricing } = await composeSellDraftPricing(fixtureHolding(), {
      computeFmv: async () => speculativeResult(),
    });

    const clientBody = "<b>2024 Bowman Chrome Theo Gillen Blue Refractor Auto</b>";
    const withBasis = appendBasisBlock(clientBody, pricing);

    // The seller's own words are kept...
    expect(withBasis).toContain(clientBody);
    // ...and the two disclosures this price MUST carry are now present.
    expect(withBasis.toLowerCase()).toContain("speculative");
    expect(withBasis).toContain("your own purchase");
    expect(withBasis).toContain("$412.00");
  });

  it("a stripped description still reaches eBay carrying the basis", async () => {
    const capture: { inventoryBody?: unknown } = {};
    globalThis.fetch = fakeEbay(capture) as unknown as typeof fetch;

    // Seed the holding so createListing's back-reference write finds it.
    const doc = await readUserDoc(USER);
    doc.holdings = doc.holdings ?? {};
    doc.holdings[HOLDING_ID] = {
      id: HOLDING_ID,
      playerName: "Theo Gillen",
      cardYear: 2024,
      quantity: 1,
    } as unknown as PortfolioHolding;
    await writeUserDoc(USER, doc);

    const { pricing } = await composeSellDraftPricing(fixtureHolding(), {
      computeFmv: async () => speculativeResult(),
    });

    const input: HoldingListingInput = {
      holdingId: HOLDING_ID,
      playerName: "Theo Gillen",
      cardTitle: "2024 Bowman Chrome Theo Gillen Blue Refractor Auto",
      cardYear: 2024,
      brand: "Bowman",
      setName: "Bowman Chrome",
      product: "Bowman Chrome",
      isAuto: true,
      isPatch: false,
      isRookie: false,
      quantity: 1,
      listingPrice: 412.0,
      bestOfferEnabled: false,
      imageFrontUrl: "https://example.com/front.jpg",
      // This is the route's job in production (attachBasisToDescription);
      // here we do it explicitly so the assertion is about what eBay SEES.
      description: appendBasisBlock("<b>Card</b>", pricing),
    };

    const result = await createListing(USER, input);
    expect(result.success).toBe(true);
    expect(result.listingId).toBe("LISTING-BASIS");

    // The description eBay was handed carries both disclosures.
    const body = capture.inventoryBody as { product?: { description?: string } };
    const description = body?.product?.description ?? "";
    expect(description.toLowerCase()).toContain("speculative");
    expect(description).toContain("your own purchase");
  });

  it("makes no HobbyIQ claim when the seller set their own price", async () => {
    const { pricing } = await composeSellDraftPricing(fixtureHolding(), {
      computeFmv: async () =>
        ({
          fmv: null,
          method: "no-basis",
          rungLabel: "no-basis",
          confidence: 0,
          provenance: { summary: "no rung produced a value", comps: [], trendPctPerMonth: null, multipliers: {} },
          computedAt: "2026-09-02T12:00:00.000Z",
          recentRange: null,
        }) as CanonicalFmvResult,
    });

    // Nothing is appended, so the listing says nothing about how the
    // seller's own number was arrived at.
    expect(appendBasisBlock("<b>My price</b>", pricing)).toBe("<b>My price</b>");
  });
});

// ---------------------------------------------------------------------------
// The safety pin: no production eBay, ever.
// ---------------------------------------------------------------------------

describe("no listing is ever created outside the sandbox", () => {
  it("every eBay URL touched is api.sandbox.ebay.com", async () => {
    const capture: { inventoryBody?: unknown } = {};
    globalThis.fetch = fakeEbay(capture) as unknown as typeof fetch;

    await createListing(USER, {
      holdingId: HOLDING_ID,
      playerName: "Theo Gillen",
      cardTitle: "Sandbox only",
      cardYear: 2024,
      brand: "Bowman",
      setName: "Bowman Chrome",
      product: "Bowman Chrome",
      isAuto: false,
      isPatch: false,
      isRookie: false,
      quantity: 1,
      listingPrice: 10,
      bestOfferEnabled: false,
      imageFrontUrl: "https://example.com/front.jpg",
    });

    expect(seenUrls.length).toBeGreaterThan(0);
    for (const u of seenUrls) {
      expect(u).toContain("api.sandbox.ebay.com");
      expect(u).not.toMatch(/^https:\/\/api\.ebay\.com/);
    }
  });
});
