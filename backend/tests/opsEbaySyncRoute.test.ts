// CF-OPS-EBAY-PURCHASE-SYNC (Drew, 2026-07-14): pins the admin-gated
// eBay purchase-history sync route.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";
process.env.OPS_REPORT_TOKEN = "test-ops-token";

const importMock = vi.fn();
const backfillMock = vi.fn();
vi.mock("../src/services/ebay/ebayBuyerHistory.service.js", () => ({
  importEbayPurchaseHistory: (...args: unknown[]) => importMock(...args),
  runAutoHoldingBatch: (...args: unknown[]) => backfillMock(...args),
}));

const ROUTE = "/api/ops/purchases/ebay-sync";

let app: any;
beforeAll(async () => {
  app = (await import("../src/app")).default;
});
beforeEach(() => {
  importMock.mockReset();
  backfillMock.mockReset();
});

describe("POST /api/ops/purchases/ebay-sync — auth gate", () => {
  it("401 without ops token", async () => {
    const r = await request(app).post(ROUTE).send({ userId: "user-x", days: 30 });
    expect(r.status).toBe(401);
  });

  it("401 with wrong token", async () => {
    const r = await request(app).post(ROUTE).set("x-ops-token", "wrong").send({ userId: "user-x" });
    expect(r.status).toBe(401);
  });

  it("passes gate with x-admin-token OR x-ops-token", async () => {
    importMock.mockResolvedValue({ imported: 0, skipped: 0, purchaseCount: 0 });
    const r1 = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1" });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(ROUTE)
      .set("x-ops-token", "test-ops-token").send({ userId: "u-1" });
    expect(r2.status).toBe(200);
  });
});

describe("POST /api/ops/purchases/ebay-sync — validation", () => {
  it("400 without userId", async () => {
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ days: 30 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/userId/);
  });

  it("400 when days out of range (0)", async () => {
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1", days: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/days/);
  });

  it("400 when days > 90 (eBay cap)", async () => {
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1", days: 120 });
    expect(r.status).toBe(400);
  });

  it("defaults days to 30 when omitted", async () => {
    importMock.mockResolvedValue({ imported: 3, skipped: 2, purchaseCount: 39 });
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1" });
    expect(r.status).toBe(200);
    expect(importMock).toHaveBeenCalledWith("u-1", 30);
  });
});

describe("POST /api/ops/purchases/ebay-sync — behavior", () => {
  it("returns summary from importEbayPurchaseHistory", async () => {
    importMock.mockResolvedValue({ imported: 5, skipped: 34, purchaseCount: 39, ebayTotal: 39 });
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1", days: 60 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({
      success: true, userId: "u-1", days: 60,
      imported: 5, skipped: 34, purchaseCount: 39,
    }));
  });

  it("optional autoBackfillHoldings runs the batch after import", async () => {
    importMock.mockResolvedValue({ imported: 5, skipped: 0, purchaseCount: 5 });
    backfillMock.mockResolvedValue({ processed: 5, holdingsCreated: 4, skipped: 1 });
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token")
      .send({ userId: "u-1", days: 90, autoBackfillHoldings: true });
    expect(r.status).toBe(200);
    expect(backfillMock).toHaveBeenCalledWith("u-1");
    expect(r.body.backfill).toEqual({ processed: 5, holdingsCreated: 4, skipped: 1 });
  });

  it("does NOT run backfill when autoBackfillHoldings omitted (default off)", async () => {
    importMock.mockResolvedValue({ imported: 5, skipped: 0, purchaseCount: 5 });
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1" });
    expect(r.status).toBe(200);
    expect(backfillMock).not.toHaveBeenCalled();
    expect(r.body.backfill).toBeNull();
  });

  it("500 when eBay import throws — surfaces error message", async () => {
    importMock.mockRejectedValue(new Error("GetMyeBayBuying HTTP 401"));
    const r = await request(app).post(ROUTE)
      .set("x-admin-token", "test-ops-token").send({ userId: "u-1" });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/HTTP 401/);
  });
});
