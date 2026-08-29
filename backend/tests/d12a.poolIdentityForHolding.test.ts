// CF-ONE-IDENTITY-IN-THE-POOL (2026-08-29, checklist D12a). A user's sale and
// a user's purchase reach the pool under the card's hiq: slug — the pin the
// holding already carries — never under the vendor id that `holding.cardId`
// holds on a vendor-sourced holding. One helper decides; every emit site uses
// it; a holding with no hiq identity does not emit at all, and says so
// (user_comp_withheld_no_identity).
//
// Before: markHoldingSoldFromEbay (fed by the eBay order poll), sellHolding
// and emitUserEbayPurchaseComp (addHolding / updateHolding) all wrote
// `recordSoldComp({ cardId: String(holding.cardId), ... })` — a CardHedge
// bubble.io id, confidence 1.0, verifiedByUser — and never read
// holding.hobbyiqCardId.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const matcher = vi.hoisted(() => ({ canonicalize: vi.fn(), catalogSlugIfExists: vi.fn() }));
vi.mock("../src/services/catalog/catalogMatcher.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, canonicalize: matcher.canonicalize, catalogSlugIfExists: matcher.catalogSlugIfExists };
});
const pool = vi.hoisted(() => ({
  recordSoldComp: vi.fn(async () => ({ written: true, id: "row-1", deduped: false, hobbyiqCardId: null })),
}));
vi.mock("../src/services/portfolioiq/soldCompsStore.service.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, recordSoldComp: pool.recordSoldComp };
});

import app from "../src/app";
import {
  poolIdentityForHolding,
  markHoldingSoldFromEbay,
  readUserDoc,
  writeUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const VENDOR_ID = "1606922959335x293409091214639100";
const PIN = "hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150";
const OTHER = "hiq:baseball:2024:bowman-chrome:cpa-tg:blue-refractor:auto";

const identityFields = {
  playerName: "Theo Gillen",
  cardYear: 2024,
  product: "Bowman Chrome",
  cardNumber: "CPA-TG",
  parallel: "Blue Refractor",
  isAuto: true,
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  // The catalog disagrees below the pin gate, and knows the pinned slug.
  matcher.canonicalize.mockReset().mockResolvedValue({ slug: OTHER, found: true, confidence: 0.72, matchedBy: "fuzzy-parallel" });
  matcher.catalogSlugIfExists.mockReset().mockImplementation(async (slug: string) => slug);
  pool.recordSoldComp.mockClear();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
});

function withheldEvents(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
    .filter((e): e is Record<string, unknown> => !!e && e.event === "user_comp_withheld_no_identity");
}

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return { sessionId: response.body.sessionId as string, userId: response.body.user?.userId as string };
}

async function seedHolding(userId: string, holding: Record<string, unknown>): Promise<void> {
  const doc = await readUserDoc(userId);
  doc.holdings[String(holding.id)] = { quantity: 1, purchasePrice: 100, totalCostBasis: 100, ...holding } as unknown as PortfolioHolding;
  await writeUserDoc(userId, doc);
}

const settle = () => new Promise((r) => setTimeout(r, 80));

const saleData = (ebayOrderId: string, unitSalePrice: number) => ({
  ebayOrderId,
  ebayOfferId: null, ebayListingId: `LIST-${ebayOrderId}`, ebayBuyerUsername: null,
  saleConfirmedAt: "2026-08-20T18:00:00.000Z",
  quantitySold: 1, unitSalePrice,
  finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null, adFee: null, otherFees: null,
  netPayout: null, actualShippingCost: null, suppliesCost: null, gradingCost: null,
});

describe("poolIdentityForHolding — the one resolution", () => {
  it("a pinned hobbyiqCardId wins; the vendor cardId becomes metadata; the print run rides along", () => {
    const r = poolIdentityForHolding({ id: "h", cardId: VENDOR_ID, hobbyiqCardId: PIN, printRun: 150 } as unknown as PortfolioHolding);
    expect(r).toEqual({ cardId: PIN, hobbyiqCardId: PIN, printRun: 150, vendorCardId: VENDOR_ID, via: "hobbyiqCardId" });
  });

  it("an hiq: cardId is the pin when hobbyiqCardId is absent", () => {
    const r = poolIdentityForHolding({ id: "h", cardId: PIN } as PortfolioHolding);
    expect(r).toEqual({ cardId: PIN, hobbyiqCardId: PIN, printRun: null, vendorCardId: null, via: "cardId" });
  });

  it("a vendor-only holding has NO pool identity — the vendor id is never the fallback", () => {
    const r = poolIdentityForHolding({ id: "h", cardId: VENDOR_ID, ...identityFields } as unknown as PortfolioHolding);
    expect(r).toEqual({ cardId: null, hobbyiqCardId: null, printRun: null, vendorCardId: VENDOR_ID, via: "none" });
  });

  it("is synchronous and never asks the catalog — the store reconciles the slug", () => {
    poolIdentityForHolding({ id: "h", cardId: VENDOR_ID, ...identityFields } as unknown as PortfolioHolding);
    expect(matcher.canonicalize).not.toHaveBeenCalled();
  });
});

describe("markHoldingSoldFromEbay — the order poll's sale", () => {
  it("files the sale under the pinned slug and carries the vendor id as metadata", async () => {
    const { userId } = await signIn();
    const id = "d12a-sold-pinned";
    await seedHolding(userId, { id, cardId: VENDOR_ID, hobbyiqCardId: PIN, printRun: 150, ...identityFields });

    const result = await markHoldingSoldFromEbay(userId, id, saleData("ORDER-D12A-1", 729));
    expect(result.status).toBe("marked-sold");

    await vi.waitFor(() => expect(pool.recordSoldComp).toHaveBeenCalledTimes(1));
    const written = pool.recordSoldComp.mock.calls[0][0] as unknown as Record<string, unknown>;
    // Mutation check: the pre-fix emit passed `cardId: VENDOR_ID`.
    expect(written.cardId).toBe(PIN);
    expect(written.vendorCardId).toBe(VENDOR_ID);
    expect(written.printRun).toBe(150);
    expect(written.source).toBe("ebay-user-sale");
    expect(written.sourceExternalId).toBe("ORDER-D12A-1");
    expect(withheldEvents()).toEqual([]);
  });

  it("a vendor-only holding does NOT emit — the sale is still marked sold, and the withhold is logged", async () => {
    const { userId } = await signIn();
    const id = "d12a-sold-vendor-only";
    await seedHolding(userId, { id, cardId: VENDOR_ID, ...identityFields });

    const result = await markHoldingSoldFromEbay(userId, id, saleData("ORDER-D12A-2", 300));
    expect(result.status).toBe("marked-sold");
    await settle();
    expect(pool.recordSoldComp).not.toHaveBeenCalled();
    const events = withheldEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "portfolioStore.markHoldingSoldFromEbay", holdingId: id, vendorCardId: VENDOR_ID });
  });
});

describe("sellHolding — the manual sale", () => {
  it("POST /holdings/:id/sell files the sale under the pinned slug, not the vendor cardId", async () => {
    const { sessionId, userId } = await signIn();
    const id = "d12a-sell-pinned";
    await seedHolding(userId, { id, cardId: VENDOR_ID, hobbyiqCardId: PIN, ...identityFields });
    const res = await request(app)
      .post(`/api/portfolio/holdings/${id}/sell`)
      .set("x-session-id", sessionId)
      .send({ quantity: 1, salePrice: 500, soldAt: "2026-08-21T00:00:00.000Z" });
    expect(res.status).toBeLessThan(300);

    await vi.waitFor(() => expect(pool.recordSoldComp).toHaveBeenCalled());
    const sales = pool.recordSoldComp.mock.calls
      .map((c) => c[0] as unknown as Record<string, unknown>)
      .filter((w) => w.source === "ebay-user-sale");
    expect(sales).toHaveLength(1);
    expect(sales[0].cardId).toBe(PIN);
    expect(sales[0].vendorCardId).toBe(VENDOR_ID);
    expect(sales[0].price).toBe(500);
  });

  it("a vendor-only holding sells fine but nothing is pooled", async () => {
    const { sessionId, userId } = await signIn();
    const id = "d12a-sell-vendor-only";
    await seedHolding(userId, { id, cardId: VENDOR_ID, ...identityFields });
    const res = await request(app)
      .post(`/api/portfolio/holdings/${id}/sell`)
      .set("x-session-id", sessionId)
      .send({ quantity: 1, salePrice: 500 });
    expect(res.status).toBeLessThan(300);
    await settle();
    expect(pool.recordSoldComp).not.toHaveBeenCalled();
    expect(withheldEvents().map((e) => e.source)).toEqual(["portfolioStore.sellHolding"]);
  });
});

describe("emitUserEbayPurchaseComp — the Add Card purchase", () => {
  it("POST /api/portfolio/holdings with an eBay purchase files it under the pinned slug, keyed holding::<id> when no eBay ids exist", async () => {
    const { sessionId } = await signIn();
    const id = "d12a-purchase-pinned";
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id,
        ...identityFields,
        cardId: VENDOR_ID,
        hobbyiqCardId: PIN,
        quantity: 1,
        purchasePrice: 650,
        totalCostBasis: 650,
        purchaseSource: "ebay",
        purchaseDate: "2026-08-01",
      });
    expect(res.status).toBe(201);

    await vi.waitFor(() => expect(pool.recordSoldComp).toHaveBeenCalled());
    const purchases = pool.recordSoldComp.mock.calls
      .map((c) => c[0] as unknown as Record<string, unknown>)
      .filter((w) => w.source === "ebay-user-purchase");
    expect(purchases.length).toBeGreaterThanOrEqual(1);
    for (const w of purchases) {
      // Mutation check: the pre-fix emit passed `cardId: VENDOR_ID`.
      expect(w.cardId).toBe(PIN);
      expect(w.vendorCardId).toBe(VENDOR_ID);
      expect(w.price).toBe(650);
      expect(w.sourceExternalId).toBe(`holding::${id}`);
    }
  });

  it("a purchase that carries an eBay order id is keyed by it — the import (D9 purchaseSaleIdentity) and this emit converge on one row", async () => {
    const { sessionId } = await signIn();
    const res = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: "d12a-purchase-order",
        ...identityFields,
        hobbyiqCardId: PIN,
        ebayOrderId: "12-34567-89012",
        ebayItemId: "ITEM-1",
        quantity: 1,
        purchasePrice: 650,
        totalCostBasis: 650,
        purchaseSource: "ebay",
        purchaseDate: "2026-08-01",
      });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(pool.recordSoldComp).toHaveBeenCalled());
    const purchase = pool.recordSoldComp.mock.calls
      .map((c) => c[0] as unknown as Record<string, unknown>)
      .find((w) => w.source === "ebay-user-purchase");
    expect(purchase?.sourceExternalId).toBe("12-34567-89012");
    expect(purchase?.cardId).toBe(PIN);
  });
  // The vendor-only purchase (no pin anywhere) is pinned in
  // d12a.slugFillOnly.test.ts, next to the rule that stops a minted slug
  // from standing in for a pin (D12-a s.2).
});
