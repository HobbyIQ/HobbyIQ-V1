// CF-EBAY-AUTO-HOLDING (2026-07-12) — end-to-end integration.
// Covers: parser → auto-create → link on the purchase → holding visible
// on GET /api/portfolio/holdings + backfill endpoint over existing state.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<string> {
  const r = await request(app).post("/api/auth/signin").send({ username: "HobbyIQ", password: "Baseball25" });
  expect(r.status).toBe(200);
  return r.body.sessionId as string;
}

/**
 * Seed a purchase with a specific `notes` field (which the import flow
 * uses to store the eBay listing title). The routes-side POST is the
 * cleanest way to write the purchase deterministically without hitting
 * the eBay API.
 */
async function seedPurchase(session: string, opts: {
  notes: string;
  purchaseDate?: string;
  totalCost: number;
  ebayOrderId: string;
}) {
  const r = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
    purchaseDate: opts.purchaseDate ?? "2029-04-15T00:00:00Z",   // isolated year to avoid contamination
    source: "ebay",
    subtotal: opts.totalCost - 5,   // pretend $5 shipping
    tax: 0,
    shipping: 5,
    otherFees: 0,
    vendor: "test-seller",
    notes: opts.notes,
    ebayOrderId: opts.ebayOrderId,
  });
  expect(r.status).toBe(201);
  return r.body.purchase.id as string;
}

describe("POST /api/portfolio/erp/purchases/backfill-holdings", () => {
  it("high-confidence purchase → auto-created holding + linked back to purchase", async () => {
    const session = await signIn();
    const purchaseId = await seedPurchase(session, {
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT",
      totalCost: 200,
      ebayOrderId: "backfill-hi-1",
    });

    const r = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.processed).toBeGreaterThanOrEqual(1);
    expect(r.body.holdingsCreated).toBeGreaterThanOrEqual(1);

    // Purchase now has a non-empty holdingIds
    const pDetail = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    expect(pDetail.body.purchase.holdingIds.length).toBe(1);

    // Holding visible on GET /api/portfolio/holdings
    // CF-EBAY-REVIEW-QUEUE (2026-07-12): auto-created holdings land in
    // pending-review; use ?includePendingReview=true to see them via the
    // main list. Prod iOS reads from /holdings/pending-review instead.
    const holdings = await request(app).get("/api/portfolio/holdings?includePendingReview=true").set("x-session-id", session);
    const created = holdings.body.holdings.find((h: any) => h.playerName === "Mookie Betts" && h.cardYear === 2020);
    expect(created).toBeTruthy();
    expect(created.gradeCompany).toBe("PSA");
    expect(created.gradeValue).toBe(10);
    expect(created.cardNumber).toBe("275");
    expect(created.source).toBe("ebay-auto");
    expect(created.sourcePurchaseId).toBe(purchaseId);
    expect(created.parseConfidence).toBeGreaterThanOrEqual(0.7);
    expect(created.needsReview).toBe(false);   // >=0.90 confidence → not flagged for review
    // Cost basis rolled through
    expect(created.totalCostBasis).toBe(200);
  });

  it("low-confidence purchase → skipped, purchase.holdingIds stays empty", async () => {
    const session = await signIn();
    const purchaseId = await seedPurchase(session, {
      notes: "Base 1990 Score Bo Jackson (RC?) NM",
      totalCost: 30,
      ebayOrderId: "backfill-lo-1",
    });
    const r = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(r.status).toBe(200);
    // "processed" includes ALL eBay purchases seen, not just this one.
    // Assert that THIS specific purchase's holdingIds stays empty.
    const pDetail = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    expect(pDetail.body.purchase.holdingIds).toEqual([]);
  });

  it("zero-confidence purchase (junk lot listing) → no auto-create", async () => {
    const session = await signIn();
    const purchaseId = await seedPurchase(session, {
      notes: "lot of 500 penny sleeves and top loaders",
      totalCost: 20,
      ebayOrderId: "backfill-junk-1",
    });
    const r = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(r.status).toBe(200);
    const pDetail = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    expect(pDetail.body.purchase.holdingIds).toEqual([]);
  });

  it("idempotent — running backfill twice doesn't duplicate holdings on a purchase", async () => {
    const session = await signIn();
    const purchaseId = await seedPurchase(session, {
      notes: "2011 Topps Update Mike Trout #US175 Rookie RC BGS 9.5",
      totalCost: 500,
      ebayOrderId: "backfill-idempotent-1",
    });
    const first = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(first.status).toBe(200);
    const p1 = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    const linkedAfterFirst = p1.body.purchase.holdingIds.length;
    expect(linkedAfterFirst).toBe(1);

    const second = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(second.status).toBe(200);
    const p2 = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    // Still exactly 1 — the second run's autoCreateHoldingForPurchase saw
    // holdingIds already populated and returned skipped-already-linked.
    expect(p2.body.purchase.holdingIds.length).toBe(1);
  });

  it("only eBay purchases participate — manual purchases are untouched", async () => {
    const session = await signIn();
    // Manual purchase with a well-formed title — would auto-create IF the
    // filter didn't skip source=manual. It should NOT create a holding.
    const manualPurchaseR = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2029-04-15T00:00:00Z",
      source: "manual",
      subtotal: 200,
      vendor: "Local Card Shop",
      notes: "2020 Panini Prizm Mookie Betts #275 PSA 10 GEM MINT",
    });
    expect(manualPurchaseR.status).toBe(201);
    const manualPurchaseId = manualPurchaseR.body.purchase.id;

    await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    const p = await request(app).get(`/api/portfolio/erp/purchases/${manualPurchaseId}`).set("x-session-id", session);
    expect(p.body.purchase.holdingIds).toEqual([]);
  });

  it("real Drew title: Owen Carey Gold Refractor → auto-created", async () => {
    const session = await signIn();
    const purchaseId = await seedPurchase(session, {
      notes: "2026 Bowman Chrome 1st Owen Carey Prospect Auto Gold Refractor #14/50 M377",
      totalCost: 305.48,
      ebayOrderId: "backfill-real-drew-1",
    });
    const r = await request(app).post("/api/portfolio/erp/purchases/backfill-holdings").set("x-session-id", session);
    expect(r.status).toBe(200);
    const p = await request(app).get(`/api/portfolio/erp/purchases/${purchaseId}`).set("x-session-id", session);
    expect(p.body.purchase.holdingIds.length).toBe(1);
    // CF-EBAY-REVIEW-QUEUE (2026-07-12): auto-created holdings land in
    // pending-review; use ?includePendingReview=true to see them via the
    // main list. Prod iOS reads from /holdings/pending-review instead.
    const holdings = await request(app).get("/api/portfolio/holdings?includePendingReview=true").set("x-session-id", session);
    const created = holdings.body.holdings.find((h: any) => h.playerName === "Owen Carey");
    expect(created).toBeTruthy();
    expect(created.cardYear).toBe(2026);
    expect(created.setName).toBe("Bowman Chrome");
    expect(created.parallel).toMatch(/refractor|gold/i);
    expect(created.totalCostBasis).toBe(305.48);
  });
});
