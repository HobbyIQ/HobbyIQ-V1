// CF-PNL-COGS-INTEGRATION (2026-07-12) — locks the new `cogs` shape on
// /erp/pnl and the buildCogsView math. Focus: purchase-side aggregation,
// inventory-on-hand snapshot, cash-flow math, and window filtering.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { buildCogsView, type PnlTotals } from "../src/services/portfolioiq/erpReconciliation.service";

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

const EMPTY_PNL: PnlTotals = {
  grossProceeds: 0, feesTotal: 0, shipping: 0, netProceeds: 0,
  costBasisSold: 0, realizedProfitLoss: 0, entryCount: 0,
};

describe("buildCogsView — pure aggregation", () => {
  it("empty inputs → all zero + grossMarginPct=null (no netProceeds)", () => {
    const c = buildCogsView(EMPTY_PNL, [], {}, {});
    expect(c.purchaseSpend).toBe(0);
    expect(c.purchaseCount).toBe(0);
    expect(c.inventoryOnHandCost).toBe(0);
    expect(c.inventoryOnHandCount).toBe(0);
    expect(c.cashFlow).toBe(0);
    expect(c.grossMarginPct).toBeNull();
  });

  it("purchaseSpend aggregates only purchases in the window", () => {
    const purchases = [
      { purchaseDate: "2026-06-15T00:00:00Z", totalCost: 200, subtotal: 180, tax: 10, shipping: 10, otherFees: 0 },
      { purchaseDate: "2026-07-05T00:00:00Z", totalCost: 500, subtotal: 480, tax: 20, shipping: 0, otherFees: 0 },
      { purchaseDate: "2026-07-20T00:00:00Z", totalCost: 100, subtotal: 90, tax: 5, shipping: 5, otherFees: 0 },
    ];
    const c = buildCogsView(EMPTY_PNL, purchases, {}, { from: "2026-07-01", to: "2026-07-31" });
    expect(c.purchaseCount).toBe(2);        // June excluded
    expect(c.purchaseSpend).toBe(600);      // 500 + 100
    expect(c.purchaseSubtotal).toBe(570);   // 480 + 90
    expect(c.purchaseTax).toBe(25);
    expect(c.purchaseShipping).toBe(5);
  });

  it("inventoryOnHand snapshot: current holdings NOT window-scoped", () => {
    const holdings = {
      h1: { totalCostBasis: 500, quantity: 1 },
      h2: { purchasePrice: 100, quantity: 3 },     // totalCostBasis derived: 300
      h3: { totalCostBasis: 200, quantity: 1 },
    };
    const c = buildCogsView(EMPTY_PNL, [], holdings, { from: "2020-01-01", to: "2020-12-31" });
    expect(c.inventoryOnHandCount).toBe(3);
    expect(c.inventoryOnHandCost).toBe(1000);
  });

  it("cashFlow = grossProceeds - purchaseSpend (both window-scoped)", () => {
    const pnl: PnlTotals = { ...EMPTY_PNL, grossProceeds: 800 };
    const purchases = [{ purchaseDate: "2026-07-15", totalCost: 300 }];
    const c = buildCogsView(pnl, purchases, {}, { from: "2026-07-01", to: "2026-07-31" });
    expect(c.cashFlow).toBe(500);   // 800 - 300
  });

  it("grossMarginPct = realizedProfitLoss / netProceeds × 100", () => {
    const pnl: PnlTotals = { ...EMPTY_PNL, netProceeds: 800, realizedProfitLoss: 200 };
    const c = buildCogsView(pnl, [], {}, {});
    expect(c.grossMarginPct).toBe(25); // 200/800 = 25%
  });

  it("grossMarginPct null when netProceeds <= 0 (avoid divide-by-zero)", () => {
    const pnl: PnlTotals = { ...EMPTY_PNL, netProceeds: 0, realizedProfitLoss: -50 };
    const c = buildCogsView(pnl, [], {}, {});
    expect(c.grossMarginPct).toBeNull();
  });

  it("rounds all money fields to 2 dp", () => {
    const purchases = [{ purchaseDate: "2026-07-15", totalCost: 100.333, subtotal: 90.111, tax: 5.222 }];
    const c = buildCogsView(EMPTY_PNL, purchases, {}, {});
    expect(c.purchaseSpend).toBe(100.33);
    expect(c.purchaseSubtotal).toBe(90.11);
    expect(c.purchaseTax).toBe(5.22);
  });
});

describe("GET /erp/pnl includes cogs field", () => {
  it("emits cogs with zeros on a portfolio with no purchases + no holdings", async () => {
    const session = await signIn();
    // Some earlier tests may have left purchases/holdings; scope to a
    // date range that guarantees no purchases (year 2019).
    const r = await request(app).get("/api/portfolio/erp/pnl?from=2019-01-01&to=2019-12-31").set("x-session-id", session);
    expect(r.status).toBe(200);
    expect(r.body.cogs).toBeTruthy();
    expect(r.body.cogs.purchaseCount).toBe(0);
    expect(r.body.cogs.purchaseSpend).toBe(0);
    // inventoryOnHand IS current-snapshot (not window-scoped) so it may
    // reflect whatever tests earlier left in the shared testMemStore.
    expect(typeof r.body.cogs.inventoryOnHandCost).toBe("number");
    expect(typeof r.body.cogs.inventoryOnHandCount).toBe("number");
  });

  it("cogs reflects a fresh POST /erp/purchases immediately", async () => {
    const session = await signIn();
    // Isolated window to avoid contamination from other tests
    await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2028-05-15T00:00:00Z", source: "manual", subtotal: 400, tax: 30, shipping: 10,
    });
    await request(app).post("/api/portfolio/erp/purchases").set("x-session-id", session).send({
      purchaseDate: "2028-05-20T00:00:00Z", source: "ebay", subtotal: 250, shipping: 15, ebayOrderId: "cogs-test-1",
    });
    const r = await request(app).get("/api/portfolio/erp/pnl?from=2028-05-01&to=2028-05-31").set("x-session-id", session);
    expect(r.status).toBe(200);
    expect(r.body.cogs.purchaseCount).toBe(2);
    // 440 + 265 = 705 total spend
    expect(r.body.cogs.purchaseSpend).toBe(705);
    expect(r.body.cogs.purchaseSubtotal).toBe(650);
  });
});
