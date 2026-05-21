/**
 * D.6 — eBay ITEM_SOLD webhook handler tests.
 *
 * Covers the real ITEM_SOLD path wired in PR D.6 (Step 5):
 *
 *   POST /api/ebay/webhook  topic=ITEM_SOLD
 *     1. capture-before-process via webhook_events store
 *     2. extract ebayOfferId from envelope
 *     3. findHoldingByEbayOfferIdAcrossUsers
 *     4. markHoldingSoldFromEbay with NULL supplies/grading costs
 *        (those are user-entered, reconciled in PR E UX)
 *     5. markEventProcessed / markEventError, always 200 OK
 *
 * Idempotency:
 *   - eventExists + captureEvent dedup at the webhook layer
 *   - markHoldingSoldFromEbay also dedupes on (holdingId, ebayOrderId)
 *
 * Error context:
 *   - missing offerId → markEventError "missing ebayOfferId"
 *   - no holding match for offerId → markEventError with the descriptive
 *     "no holding found with ebayOfferId=<x> — possible race ..." string
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock token store so MARKETPLACE_ACCOUNT_DELETION shape is satisfied (unused here).
vi.mock("../src/services/ebay/ebayTokenStore.service.js", () => ({
  findUserIdByEbayUserId: vi.fn().mockResolvedValue(null),
  deleteTokenRecord: vi.fn().mockResolvedValue(undefined),
}));

import {
  _resetForTests as resetWebhookEvents,
  readEvent,
} from "../src/services/ebay/ebayWebhookEvents.service.js";
import * as portfolioStore from "../src/services/portfolioiq/portfolioStore.service.js";
import ebayWebhookRoutes from "../src/routes/ebayWebhook.routes.js";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/ebay/webhook", ebayWebhookRoutes);
  return app;
}

const findSpy = vi.spyOn(portfolioStore, "findHoldingByEbayOfferIdAcrossUsers");
const markSpy = vi.spyOn(portfolioStore, "markHoldingSoldFromEbay");

beforeEach(() => {
  process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN = "test-token";
  resetWebhookEvents();
  findSpy.mockReset();
  markSpy.mockReset();
});

function itemSoldEnvelope(overrides: {
  notificationId: string;
  offerId?: string;
  orderId?: string;
  listingId?: string;
  quantity?: number;
  unitCost?: number;
  buyerUsername?: string;
  saleDate?: string;
  eventDate?: string;
}) {
  return {
    metadata: { topic: "ITEM_SOLD" },
    notification: {
      notificationId: overrides.notificationId,
      eventDate: overrides.eventDate ?? "2026-05-20T00:00:00Z",
      data: {
        offerId: overrides.offerId,
        orderId: overrides.orderId,
        listingId: overrides.listingId,
        saleDate: overrides.saleDate,
        buyer: overrides.buyerUsername ? { username: overrides.buyerUsername } : undefined,
        lineItems: [
          {
            quantity: overrides.quantity ?? 1,
            lineItemCost: { value: overrides.unitCost ?? 100, currency: "USD" },
          },
        ],
      },
    },
  };
}

describe("POST /api/ebay/webhook — ITEM_SOLD", () => {
  it("happy path: extracts offerId, finds holding, calls markHoldingSoldFromEbay with NULL supplies/grading", async () => {
    findSpy.mockResolvedValue({
      userId: "user-1",
      holdingId: "holding-A",
      holding: { id: "holding-A", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "entry-1" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-itemsold-1",
          offerId: "OFFER-123",
          orderId: "ORDER-XYZ",
          listingId: "LST-555",
          quantity: 1,
          unitCost: 199.99,
          buyerUsername: "buyer42",
          saleDate: "2026-05-20T10:00:00Z",
        }),
      );

    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith("OFFER-123");
    expect(markSpy).toHaveBeenCalledTimes(1);
    const [uid, hid, payload] = markSpy.mock.calls[0];
    expect(uid).toBe("user-1");
    expect(hid).toBe("holding-A");
    expect(payload.ebayOrderId).toBe("ORDER-XYZ");
    expect(payload.ebayOfferId).toBe("OFFER-123");
    expect(payload.ebayListingId).toBe("LST-555");
    expect(payload.ebayBuyerUsername).toBe("buyer42");
    expect(payload.saleConfirmedAt).toBe("2026-05-20T10:00:00Z");
    expect(payload.quantitySold).toBe(1);
    expect(payload.unitSalePrice).toBeCloseTo(199.99);
    // Granular fees: webhook does not know them; reconcile via finance APIs.
    expect(payload.finalValueFee).toBeNull();
    expect(payload.paymentProcessingFee).toBeNull();
    expect(payload.netPayout).toBeNull();
    expect(payload.actualShippingCost).toBeNull();
    // CRITICAL: supplies/grading costs are user-entered (PR E UX) — must
    // be null, not 0, and there must be no inferred default.
    expect(payload.suppliesCost).toBeNull();
    expect(payload.gradingCost).toBeNull();

    // Capture-before-process landed.
    const captured = await readEvent("n-itemsold-1");
    expect(captured?.status).toBe("processed");
    expect(captured?.topic).toBe("ITEM_SOLD");
  });

  it("missing offerId: marks event error, does NOT call markHoldingSoldFromEbay, still 200", async () => {
    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-no-offer",
          orderId: "ORDER-NO-OFFER",
          // offerId omitted, lineItems present but no offerId on line either
        }),
      );

    expect(res.status).toBe(200);
    expect(findSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();

    const captured = await readEvent("n-no-offer");
    expect(captured?.status).toBe("error");
    expect(captured?.handlerError).toMatch(/missing ebayOfferId/i);
  });

  it("no holding match for offerId (race with end-listing): emits descriptive markEventError, 200", async () => {
    findSpy.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-race",
          offerId: "OFFER-GONE",
          orderId: "ORDER-RACE",
        }),
      );

    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith("OFFER-GONE");
    expect(markSpy).not.toHaveBeenCalled();

    const captured = await readEvent("n-race");
    expect(captured?.status).toBe("error");
    expect(captured?.handlerError).toContain("no holding found with ebayOfferId=OFFER-GONE");
    expect(captured?.handlerError).toContain("possible race with end-listing");
  });

  it("dedup at webhook layer: redelivered notificationId skips handler entirely", async () => {
    findSpy.mockResolvedValue({
      userId: "u",
      holdingId: "h",
      holding: { id: "h", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "e" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });

    const env = itemSoldEnvelope({
      notificationId: "n-dedup",
      offerId: "OFFER-DD",
      orderId: "ORDER-DD",
    });

    const r1 = await request(buildApp()).post("/api/ebay/webhook").send(env);
    const r2 = await request(buildApp()).post("/api/ebay/webhook").send(env);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledTimes(1);
  });

  it("missing orderId: marks event error, never calls find/mark, still 200", async () => {
    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-no-order",
          offerId: "OFFER-OK",
          // orderId omitted
        }),
      );

    expect(res.status).toBe(200);
    expect(findSpy).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();

    const captured = await readEvent("n-no-order");
    expect(captured?.status).toBe("error");
    expect(captured?.handlerError).toMatch(/missing orderId/i);
  });

  it("markHoldingSoldFromEbay returns invalid-input: error captured, 200", async () => {
    findSpy.mockResolvedValue({
      userId: "u",
      holdingId: "h",
      holding: { id: "h", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({ status: "invalid-input", reason: "invalid quantitySold" });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-invalid",
          offerId: "OFFER-X",
          orderId: "ORDER-X",
          quantity: 99, // larger than holding quantity in real world
        }),
      );

    expect(res.status).toBe(200);
    const captured = await readEvent("n-invalid");
    expect(captured?.status).toBe("error");
    expect(captured?.handlerError).toContain("invalid-input");
    expect(captured?.handlerError).toContain("invalid quantitySold");
  });

  it("envelope places offerId on the lineItem (not top-level data): still routes correctly", async () => {
    findSpy.mockResolvedValue({
      userId: "u2",
      holdingId: "h2",
      holding: { id: "h2", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold",
      entry: { id: "e2" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send({
        metadata: { topic: "ITEM_SOLD" },
        notification: {
          notificationId: "n-line-offer",
          eventDate: "2026-05-20T00:00:00Z",
          data: {
            orderId: "ORDER-LO",
            lineItems: [
              {
                offerId: "OFFER-FROM-LINE",
                quantity: 1,
                lineItemCost: { value: 50, currency: "USD" },
              },
            ],
          },
        },
      });

    expect(res.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith("OFFER-FROM-LINE");
    expect(markSpy).toHaveBeenCalledTimes(1);
  });

  it("dedup-marked-sold result still records markEventProcessed (not error)", async () => {
    findSpy.mockResolvedValue({
      userId: "u",
      holdingId: "h",
      holding: { id: "h", quantity: 1 } as any,
    });
    markSpy.mockResolvedValue({
      status: "marked-sold-deduped",
      entry: { id: "e-existing" } as any,
      holdingRemoved: true,
      remainingQuantity: 0,
    });

    const res = await request(buildApp())
      .post("/api/ebay/webhook")
      .send(
        itemSoldEnvelope({
          notificationId: "n-helper-dedup",
          offerId: "OFFER-HD",
          orderId: "ORDER-HD",
        }),
      );

    expect(res.status).toBe(200);
    const captured = await readEvent("n-helper-dedup");
    expect(captured?.status).toBe("processed");
    expect(captured?.handlerResult?.action).toBe("marked-sold-deduped");
  });
});
