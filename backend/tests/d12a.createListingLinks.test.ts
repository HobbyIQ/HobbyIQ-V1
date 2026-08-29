// CF-EVERY-PUBLISH-LINKS-THE-HOLDING (2026-08-29, checklist D12a).
//
// ebayOrderPoll matches a sold order to a holding by
// findHoldingByEbayListingIdAcrossUsers(listingId) — the ebayListingId /
// ebayOfferId back-references on the holding. Those were written by ONE of
// the two publish routes (/api/ebay/listings/publish called linkEbayListing
// after createListing) and not the other (/api/portfolio/holdings/:id/ebay/
// listing returned createListing's result untouched). A card listed through
// the portfolio route could sell on eBay and never be marked sold.
//
// The link now happens inside createListing, once, on every successful
// publish — so there is no route that can forget it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/ebay/ebayAuth.service.js", () => ({
  EBAY_BASE_API: "https://api.sandbox.ebay.com",
  getAccessToken: vi.fn(async () => "fake-access-token"),
}));

import { createListing, type HoldingListingInput } from "../src/services/ebay/ebayListing.service.js";
import { readUserDoc, writeUserDoc, findHoldingByEbayOfferId } from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const USER = "d12a-link-user";

/** A fake eBay that answers the publish sequence. */
function ebayFetch(): ReturnType<typeof vi.fn> {
  const json = (status: number, body: unknown) => ({
    status, ok: status >= 200 && status < 300,
    async json() { return body; },
  });
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://api.sandbox.ebay.com", "");
    if (method === "PUT" && path.startsWith("/sell/inventory/v1/inventory_item/")) return json(204, {});
    if (path.startsWith("/sell/account/v1/payment_policy")) return json(200, { paymentPolicies: [{ paymentPolicyId: "P1", name: "pay" }] });
    if (path.startsWith("/sell/account/v1/fulfillment_policy")) return json(200, { fulfillmentPolicies: [{ fulfillmentPolicyId: "F1", name: "ship" }] });
    if (path.startsWith("/sell/account/v1/return_policy")) return json(200, { returnPolicies: [{ returnPolicyId: "R1", name: "ret" }] });
    if (path.startsWith("/sell/inventory/v1/location")) return json(200, { locations: [{ merchantLocationKey: "LOC1" }] });
    if (method === "POST" && path === "/sell/inventory/v1/offer") return json(200, { offerId: "OFFER-D12A" });
    if (method === "POST" && path === "/sell/inventory/v1/offer/OFFER-D12A/publish") return json(200, { listingId: "LISTING-D12A" });
    return json(404, { errors: [{ message: `unexpected ${method} ${path}` }] });
  });
}

function input(holdingId: string): HoldingListingInput {
  return {
    holdingId,
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
    listingPrice: 729,
    bestOfferEnabled: false,
  };
}

async function seed(holdingId: string): Promise<void> {
  const doc = await readUserDoc(USER);
  doc.holdings[holdingId] = {
    id: holdingId, playerName: "Theo Gillen", cardYear: 2024, product: "Bowman Chrome", quantity: 1, purchasePrice: 100,
  } as unknown as PortfolioHolding;
  await writeUserDoc(USER, doc);
}

beforeEach(() => vi.stubGlobal("fetch", ebayFetch()));
afterEach(() => vi.unstubAllGlobals());

describe("createListing links the holding on every successful publish", () => {
  it("the holding carries ebayOfferId / ebayListingId after publish, and the result says so", async () => {
    const holdingId = "d12a-listed-1";
    await seed(holdingId);

    const result = await createListing(USER, input(holdingId));
    expect(result.success).toBe(true);
    expect(result.offerId).toBe("OFFER-D12A");
    expect(result.listingId).toBe("LISTING-D12A");
    expect(result.linked).toBe(true);

    const h = (await readUserDoc(USER)).holdings[holdingId];
    // Mutation check: the pre-fix createListing returned without linking, so
    // these were undefined for any route that did not link on its own.
    expect(h.ebayOfferId).toBe("OFFER-D12A");
    expect(h.ebayListingId).toBe("LISTING-D12A");
    expect(typeof h.ebayListingPublishedAt).toBe("string");

    // What the sale poll needs: the listing resolves back to the holding.
    const found = await findHoldingByEbayOfferId(USER, "OFFER-D12A");
    expect(found?.id).toBe(holdingId);
  });

  it("a publish for a holding that does not exist is still a live listing — reported as unlinked, never unwound", async () => {
    const result = await createListing(USER, input("d12a-no-such-holding"));
    expect(result.success).toBe(true);
    expect(result.listingId).toBe("LISTING-D12A");
    expect(result.linked).toBe(false);
  });
});
