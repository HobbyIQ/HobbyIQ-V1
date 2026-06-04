// CF-GROUP-A PART 3 (2026-06-04): synthetic end-to-end cascade verification.
//
// Drives the EXISTING eBay-sale cascade through the real route + service
// layer (no mocks of the cascade primitives themselves; just the auth
// surface). Validates:
//
//   1. POST /api/ebay/webhook with a synthetic ITEM_SOLD body that
//      matches extractOfferId's parse shape lands a ledger entry on the
//      pre-seeded holding (source=ebay, paymentMethod=ebay_managed, fees
//      ALL NULL, needsReconciliation=true).
//   2. POST /api/portfolio/erp/unreconciled/:id/override on that ledger
//      entry reconciles it (reconciledVia=manual_override, fee fields
//      written, feeAdjustments[] appended, needsReconciliation=false,
//      netProceeds + realizedProfitLoss recomputed).
//
// The Finances auto-enrichment arc does NOT exist in code today — that's
// the Group D follow-up. This test verifies the parts of the cascade
// that ARE wired without depending on any unbuilt component.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.EBAY_WEBHOOK_VERIFICATION_TOKEN = "test-token";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

// Use the portfolioStore's built-in NODE_ENV=test in-memory store; same
// pattern as the existing ERP-expansion integration tests.
import {
  readUserDoc as realReadUserDoc,
  writeUserDoc as realWriteUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";

async function seedUserDoc(userId: string, mutate: (doc: any) => void): Promise<void> {
  const doc = await realReadUserDoc(userId);
  mutate(doc);
  await realWriteUserDoc(userId, doc as any);
}

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;
  // Reset both the test user docs we touch
  await seedUserDoc("u-pro_seller", (doc) => { doc.holdings = {}; doc.ledger = []; doc.trades = undefined; });
});

function itemSoldEnvelope(opts: {
  notificationId: string;
  offerId: string;
  orderId: string;
  unitCost: number;
  buyerUsername?: string;
  saleDate?: string;
}) {
  return {
    metadata: { topic: "ITEM_SOLD" },
    notification: {
      notificationId: opts.notificationId,
      eventDate: opts.saleDate ?? "2026-06-04T00:00:00Z",
      data: {
        offerId: opts.offerId,
        orderId: opts.orderId,
        listingId: "listing-cascade-1",
        saleDate: opts.saleDate ?? "2026-06-04T00:00:00Z",
        buyer: { username: opts.buyerUsername ?? "buyer-cascade" },
        lineItems: [{
          offerId: opts.offerId,
          legacyItemId: "legacy-cascade-1",
          listingId: "listing-cascade-1",
          quantity: 1,
          lineItemCost: { value: opts.unitCost.toFixed(2), currency: "USD" },
          total: { value: opts.unitCost.toFixed(2), currency: "USD" },
        }],
      },
    },
  };
}

describe("eBay ITEM_SOLD → ledger → manual-override reconcile (synthetic end-to-end)", () => {
  const USER_ID = "u-pro_seller";
  const HOLDING_ID = "h-cascade-1";
  const OFFER_ID = "off-cascade-7";
  const ORDER_ID = "ord-cascade-7";
  const SALE_PRICE = 250;
  const COST_BASIS = 80;

  it("drives the full real cascade end-to-end", async () => {
    // ── Step 1: seed a holding with the known ebayOfferId ────────────────
    await seedUserDoc(USER_ID, (doc) => {
      doc.holdings[HOLDING_ID] = {
        id: HOLDING_ID,
        playerName: "Cascade Test Player",
        cardTitle: "2024 Topps Chrome RC — Cascade Test",
        cardYear: 2024,
        setName: "Topps Chrome",
        quantity: 1,
        purchasePrice: COST_BASIS,
        totalCostBasis: COST_BASIS,
        purchaseDate: "2025-01-15",
        ebayOfferId: OFFER_ID,
      } as PortfolioHolding;
    });

    // ── Step 2: POST synthetic ITEM_SOLD ──────────────────────────────────
    const envelope = itemSoldEnvelope({
      notificationId: "notif-cascade-1",
      offerId: OFFER_ID,
      orderId: ORDER_ID,
      unitCost: SALE_PRICE,
    });
    const webhookResp = await request(app)
      .post("/api/ebay/webhook")
      .send(envelope);
    expect(webhookResp.status).toBe(200);

    // ── Step 3: verify the ledger row landed with the expected shape ────
    const doc1 = await realReadUserDoc(USER_ID);
    expect(doc1.ledger.length).toBe(1);
    const entry = doc1.ledger[0] as any;
    expect(entry.source).toBe("ebay");
    expect(entry.paymentMethod).toBe("ebay_managed");
    expect(entry.ebayOrderId).toBe(ORDER_ID);
    expect(entry.grossProceeds).toBe(SALE_PRICE);
    expect(entry.costBasisSold).toBe(COST_BASIS);
    expect(entry.needsReconciliation).toBe(true);
    // Granular fees should ALL be null (Finances enrichment doesn't exist)
    expect(entry.finalValueFee).toBeNull();
    expect(entry.paymentProcessingFee).toBeNull();
    expect(entry.promotedListingFee).toBeNull();
    expect(entry.adFee).toBeNull();
    expect(entry.otherFees).toBeNull();
    expect(entry.netPayout).toBeNull();
    expect(entry.actualShippingCost).toBeNull();
    // Legacy aggregate fields are 0 for eBay rows
    expect(entry.fees).toBe(0);
    expect(entry.tax).toBe(0);
    expect(entry.shipping).toBe(0);

    const entryId = entry.id;

    // ── Step 4: POST manual override to reconcile ────────────────────────
    setUser({ userId: USER_ID, email: "u@t", plan: "pro_seller", createdAt: "2026-01-01T00:00:00Z" });
    const overrideResp = await request(app)
      .post(`/api/portfolio/erp/unreconciled/${entryId}/override`)
      .set("x-session-id", "s")
      .send({
        reason: "Synthetic cascade test — fees from buyer receipt",
        fees: {
          finalValueFee: 32,
          paymentProcessingFee: 8,
          promotedListingFee: 0,
          adFee: 0,
          otherFees: 0,
          actualShippingCost: 5,
        },
      });
    expect(overrideResp.status).toBe(200);

    // ── Step 5: verify the reconciliation result ─────────────────────────
    const doc2 = await realReadUserDoc(USER_ID);
    const recon = doc2.ledger[0] as any;
    expect(recon.needsReconciliation).toBe(false);
    expect(recon.reconciledVia).toBe("manual_override");
    expect(recon.finalValueFee).toBe(32);
    expect(recon.paymentProcessingFee).toBe(8);
    expect(recon.actualShippingCost).toBe(5);
    // feeAdjustments[] APPENDED — exactly one row
    expect(recon.feeAdjustments).toHaveLength(1);
    expect(recon.feeAdjustments[0].reason).toMatch(/Synthetic cascade/);
    expect(recon.feeAdjustments[0].priorValues.finalValueFee).toBeNull();
    expect(recon.feeAdjustments[0].newValues.finalValueFee).toBe(32);
    expect(recon.feeAdjustments[0].newValues.needsReconciliation).toBe(false);
    expect(recon.feeAdjustments[0].newValues.reconciledVia).toBe("manual_override");

    // CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): net-basis fix.
    // The override path now INCLUDES actualShippingCost in the granular-fee
    // deduction (was a Group A follow-up). Aligns the manual-override
    // formula with the Finances enrichment formula:
    //   manual fallback: gross - (FVF + PP + promoted + ad + other +
    //                             actualShippingCost) - gradingCost - suppliesCost
    //   Finances/netPayout: netPayout - gradingCost - suppliesCost
    // Both produce identical netProceeds given identical inputs (operator
    // can also supply netPayout directly to skip the fallback derivation).
    //
    // = 250 - (32 + 8 + 0 + 0 + 0 + 5) = 205
    //
    // For calculated/buyer-pays-shipping listings where the buyer's shipping
    // payment approximately offsets the seller's label cost (and that buyer
    // shipping is NOT in our grossProceeds), the operator should supply
    // netPayout directly OR set actualShippingCost: 0 — keeps the derivation
    // honest. For free-shipping listings (this test's implicit case), the
    // actualShippingCost is a real reduction in seller net.
    expect(recon.netProceeds).toBe(205);
    // realizedProfitLoss = netProceeds - costBasis = 205 - 80 = 125
    expect(recon.realizedProfitLoss).toBe(125);
  });
});
