// CF-EBAY-SOLD-COMPS-FOUNDATION (2026-07-12).
//
// Verifies the ITEM_SOLD webhook fires Browse enrichment on the freshly-
// marked sale as fire-and-forget after markHoldingSoldFromEbay returns.
// Coverage:
//   - marked-sold + ebayListingId present → enrichment fires
//   - marked-sold + no ebayListingId       → enrichment does NOT fire
//   - marked-sold-deduped (idempotent replay) → does NOT fire
//   - enrichment throw → webhook still returns 200

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/services/ebay/ebayTokenStore.service.js", () => ({
  findUserIdByEbayUserId: vi.fn().mockResolvedValue(null),
  deleteTokenRecord: vi.fn().mockResolvedValue(undefined),
}));

import { _resetForTests as resetWebhookEvents } from "../src/services/ebay/ebayWebhookEvents.service.js";
import * as portfolioStore from "../src/services/portfolioiq/portfolioStore.service.js";
import * as saleEnrichment from "../src/services/portfolioiq/ebaySaleEnrichment.service.js";
import ebayWebhookRoutes from "../src/routes/ebayWebhook.routes.js";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/ebay/webhook", ebayWebhookRoutes);
  return app;
}

const findSpy = vi.spyOn(portfolioStore, "findHoldingByEbayOfferIdAcrossUsers");
const markSpy = vi.spyOn(portfolioStore, "markHoldingSoldFromEbay");
const enrichSpy = vi.spyOn(saleEnrichment, "enrichSaleFromBrowse");

beforeEach(() => {
  process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN = "test-token";
  resetWebhookEvents();
  findSpy.mockReset();
  markSpy.mockReset();
  enrichSpy.mockReset();
});

function itemSoldEnvelope(opts: {
  notificationId: string;
  offerId: string;
  orderId: string;
  listingId?: string;
}) {
  return {
    metadata: { topic: "ITEM_SOLD" },
    notification: {
      notificationId: opts.notificationId,
      eventDate: "2026-07-12T00:00:00Z",
      data: {
        offerId: opts.offerId,
        orderId: opts.orderId,
        listingId: opts.listingId,
        saleDate: "2026-07-12T00:00:00Z",
        lineItems: [{ quantity: 1, lineItemCost: { value: 100, currency: "USD" } }],
      },
    },
  };
}

/**
 * Fire-and-forget wait — the webhook returns before enrichment finishes.
 * Schedule a microtask after the webhook response so any queued .then()
 * chain resolves before our assertion.
 */
async function tick() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("ITEM_SOLD webhook → Browse enrichment fire-and-forget", () => {
  it("marked-sold + listingId present → enrichSaleFromBrowse fires", async () => {
    findSpy.mockResolvedValue({
      userId: "user-1",
      holdingId: "holding-A",
      holding: { id: "holding-A", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "ledger-777", ebayListingId: "407015594876" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });
    enrichSpy.mockResolvedValue({ status: "enriched", entry: {} as any });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(itemSoldEnvelope({
        notificationId: "n-enrich-1",
        offerId: "OFFER-1",
        orderId: "ORDER-1",
        listingId: "407015594876",
      }));

    expect(res.status).toBe(200);
    await tick();
    expect(enrichSpy).toHaveBeenCalledTimes(1);
    expect(enrichSpy).toHaveBeenCalledWith("user-1", "ledger-777");
  });

  it("marked-sold + no ebayListingId on ledger entry → does NOT fire enrichment", async () => {
    findSpy.mockResolvedValue({
      userId: "user-1",
      holdingId: "holding-A",
      holding: { id: "holding-A", quantity: 1 } as any,
    });
    // Ledger entry lacks listingId (e.g., legacy webhook missing the field).
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "ledger-777", ebayListingId: null } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(itemSoldEnvelope({
        notificationId: "n-enrich-2",
        offerId: "OFFER-2",
        orderId: "ORDER-2",
      }));

    expect(res.status).toBe(200);
    await tick();
    expect(enrichSpy).not.toHaveBeenCalled();
  });

  it("marked-sold-deduped (replay) → does NOT re-fire enrichment", async () => {
    findSpy.mockResolvedValue({
      userId: "user-1",
      holdingId: "holding-A",
      holding: { id: "holding-A", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold-deduped",
      entry: { id: "ledger-777", ebayListingId: "407015594876" } as any,
      holdingRemoved: false,
      remainingQuantity: 0,
    });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(itemSoldEnvelope({
        notificationId: "n-enrich-3",
        offerId: "OFFER-3",
        orderId: "ORDER-3",
        listingId: "407015594876",
      }));

    expect(res.status).toBe(200);
    await tick();
    // Idempotent replay: the sale is already there — enrichment either
    // fired the first time, or was skipped then. Either way, don't refire.
    expect(enrichSpy).not.toHaveBeenCalled();
  });

  it("enrichment throw → webhook STILL returns 200 (fire-and-forget swallow)", async () => {
    findSpy.mockResolvedValue({
      userId: "user-1",
      holdingId: "holding-A",
      holding: { id: "holding-A", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "ledger-777", ebayListingId: "407015594876" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });
    enrichSpy.mockRejectedValue(new Error("Browse fetch exploded"));

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(itemSoldEnvelope({
        notificationId: "n-enrich-4",
        offerId: "OFFER-4",
        orderId: "ORDER-4",
        listingId: "407015594876",
      }));

    // Webhook must return 200 regardless of async enrichment failure —
    // eBay treats non-2xx as delivery failure and retries.
    expect(res.status).toBe(200);
    await tick();
    expect(enrichSpy).toHaveBeenCalledTimes(1);
  });
});
