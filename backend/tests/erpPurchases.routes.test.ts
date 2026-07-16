// CF-PURCHASE-LEDGER-FOUNDATION (2026-07-12) — foundation route coverage.
// Locks the write-side idempotency, filter behavior, and totals math so
// downstream PRs (eBay import, /pnl COGS integration) can't silently break
// the shape.

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

describe("POST /api/portfolio/erp/purchases", () => {
  it("creates a manual purchase and computes totalCost = subtotal + tax + shipping + otherFees", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({
        purchaseDate: "2026-07-01T00:00:00Z",
        source: "manual",
        subtotal: 100,
        tax: 8.5,
        shipping: 4.99,
        otherFees: 1.5,
        vendor: "Local Card Shop",
        notes: "Test purchase",
      });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.replay).toBe(false);
    expect(r.body.purchase.source).toBe("manual");
    expect(r.body.purchase.subtotal).toBe(100);
    expect(r.body.purchase.tax).toBe(8.5);
    expect(r.body.purchase.shipping).toBe(4.99);
    expect(r.body.purchase.otherFees).toBe(1.5);
    // totalCost is the reader-authoritative field
    expect(r.body.purchase.totalCost).toBeCloseTo(114.99, 2);
    expect(r.body.purchase.vendor).toBe("Local Card Shop");
    expect(r.body.purchase.notes).toBe("Test purchase");
    expect(Array.isArray(r.body.purchase.holdingIds)).toBe(true);
    expect(r.body.purchase.holdingIds).toEqual([]);
    expect(typeof r.body.purchase.id).toBe("string");
    expect(typeof r.body.purchase.createdAt).toBe("string");
  });

  it("400 on missing purchaseDate", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ source: "manual", subtotal: 50 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/purchaseDate/);
  });

  it("400 on invalid purchaseDate", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "not-a-date", source: "manual", subtotal: 50 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a valid ISO date/);
  });

  it("400 on subtotal <= 0 (guards against zero-cost purchases)", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "2026-07-01T00:00:00Z", source: "manual", subtotal: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/subtotal must be > 0/);
  });

  it("400 on negative fee fields", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "2026-07-01T00:00:00Z", source: "manual", subtotal: 50, tax: -5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/tax must be a non-negative number/);
  });

  it("eBay idempotency: same (source=ebay, ebayOrderId) returns replay=true + 200", async () => {
    const session = await signIn();
    const body = {
      purchaseDate: "2026-07-05T00:00:00Z",
      source: "ebay",
      subtotal: 250,
      shipping: 10,
      ebayOrderId: "07-99999-11111",
      ebayTransactionId: "T-98765",
      vendor: "eBay seller X",
    };
    const first = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send(body);
    expect(first.status).toBe(201);
    expect(first.body.replay).toBe(false);
    const firstId = first.body.purchase.id;

    const second = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send(body);
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    // Same doc — id preserved
    expect(second.body.purchase.id).toBe(firstId);
  });

  it("manual purchases are ALWAYS new inserts (no idempotency key)", async () => {
    const session = await signIn();
    const body = {
      purchaseDate: "2026-07-02T00:00:00Z",
      source: "manual",
      subtotal: 100,
      vendor: "Same LCS",
    };
    const first = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send(body);
    const second = await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send(body);
    expect(first.body.purchase.id).not.toBe(second.body.purchase.id);
  });
});

describe("GET /api/portfolio/erp/purchases", () => {
  it("filters by date window + source, returns totals", async () => {
    // Use August 2027 — a window guaranteed to be untouched by other
    // tests in this file (test-mode uses a shared in-memory store).
    const session = await signIn();
    await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2027-07-25T00:00:00Z", source: "ebay", subtotal: 200, ebayOrderId: "before-aug-1",
    });
    await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2027-08-15T00:00:00Z", source: "manual", subtotal: 100,
    });
    await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2027-08-20T00:00:00Z", source: "ebay", subtotal: 300, shipping: 15, ebayOrderId: "in-aug-1",
    });

    const aug = await request(app)
      .get("/api/portfolio/erp/purchases?from=2027-08-01&to=2027-08-31")
      .set("x-session-id", session);
    expect(aug.status).toBe(200);
    // 2 purchases in August (manual $100 + eBay $315)
    expect(aug.body.totals.count).toBe(2);
    expect(aug.body.totals.totalCost).toBeCloseTo(100 + 315, 2);
    expect(aug.body.window).toEqual({ from: "2027-08-01", to: "2027-08-31" });
    // newest-first
    expect(aug.body.purchases[0].purchaseDate.startsWith("2027-08-20")).toBe(true);

    const ebayOnly = await request(app)
      .get("/api/portfolio/erp/purchases?source=ebay")
      .set("x-session-id", session);
    expect(ebayOnly.status).toBe(200);
    expect(ebayOnly.body.totals.count).toBeGreaterThanOrEqual(2);
    expect(ebayOnly.body.purchases.every((p: any) => p.source === "ebay")).toBe(true);
  });
});

describe("GET /api/portfolio/erp/purchases/:id", () => {
  it("404 on unknown id", async () => {
    const session = await signIn();
    const r = await request(app).get("/api/portfolio/erp/purchases/does-not-exist").set("x-session-id", session);
    expect(r.status).toBe(404);
  });

  it("200 with the purchase on valid id", async () => {
    const session = await signIn();
    const created = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "2026-07-10T00:00:00Z", source: "manual", subtotal: 42 });
    const id = created.body.purchase.id;
    const fetched = await request(app).get(`/api/portfolio/erp/purchases/${id}`).set("x-session-id", session);
    expect(fetched.status).toBe(200);
    expect(fetched.body.purchase.id).toBe(id);
  });
});

describe("PATCH /api/portfolio/erp/purchases/:id/link-holdings", () => {
  it("appends holdingIds without duplicates", async () => {
    const session = await signIn();
    const created = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "2026-07-11T00:00:00Z", source: "manual", subtotal: 500 });
    const id = created.body.purchase.id;
    const link1 = await request(app)
      .patch(`/api/portfolio/erp/purchases/${id}/link-holdings`)
      .set("x-session-id", session)
      .send({ holdingIds: ["h1", "h2"] });
    expect(link1.status).toBe(200);
    expect(link1.body.purchase.holdingIds).toEqual(["h1", "h2"]);
    // Second call with overlap + new id — idempotent merge
    const link2 = await request(app)
      .patch(`/api/portfolio/erp/purchases/${id}/link-holdings`)
      .set("x-session-id", session)
      .send({ holdingIds: ["h2", "h3"] });
    expect(link2.status).toBe(200);
    expect(new Set(link2.body.purchase.holdingIds)).toEqual(new Set(["h1", "h2", "h3"]));
    expect(link2.body.purchase.updatedAt).toBeTruthy();
  });

  it("400 when holdingIds is empty", async () => {
    const session = await signIn();
    const created = await request(app)
      .post("/api/portfolio/erp/purchases")
      .set("x-session-id", session)
      .send({ purchaseDate: "2026-07-11T00:00:00Z", source: "manual", subtotal: 500 });
    const id = created.body.purchase.id;
    const r = await request(app)
      .patch(`/api/portfolio/erp/purchases/${id}/link-holdings`)
      .set("x-session-id", session)
      .send({ holdingIds: [] });
    expect(r.status).toBe(400);
  });

  it("404 on unknown purchase id", async () => {
    const session = await signIn();
    const r = await request(app)
      .patch("/api/portfolio/erp/purchases/nope/link-holdings")
      .set("x-session-id", session)
      .send({ holdingIds: ["h1"] });
    expect(r.status).toBe(404);
  });
});
