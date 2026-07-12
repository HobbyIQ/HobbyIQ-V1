// CF-HELD-EXPENSES (2026-07-12) — per-hold expense capture route coverage.
// Locks: cost-basis roll-in math, validation, delete-reverses-cost math,
// and that expenses correctly participate in the eventual /sell realized
// P&L calculation.

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

async function addHolding(session: string, id: string, purchasePrice: number): Promise<void> {
  const r = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", session)
    .send({
      id, playerName: "Bobby Witt Jr", cardYear: 2022, product: "Bowman Chrome",
      cardTitle: `2022 Bowman Chrome Bobby Witt Jr (test-${id})`,
      quantity: 1, purchasePrice, totalCostBasis: purchasePrice,
    });
  expect(r.status).toBe(201);
}

describe("POST /api/portfolio/holdings/:id/expenses", () => {
  it("adds a grading expense and rolls the amount into totalCostBasis", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-basic";
    await addHolding(session, holdingId, 100);

    const r = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/expenses`)
      .set("x-session-id", session)
      .send({ kind: "grading", amount: 50, notes: "PSA 10-day" });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.expense.kind).toBe("grading");
    expect(r.body.expense.amount).toBe(50);
    expect(r.body.expense.notes).toBe("PSA 10-day");
    expect(typeof r.body.expense.id).toBe("string");
    expect(typeof r.body.expense.createdAt).toBe("string");
    expect(typeof r.body.expense.incurredAt).toBe("string");
    // 100 base + 50 grading = 150 all-in
    expect(r.body.newTotalCostBasis).toBe(150);
    expect(r.body.holding.totalCostBasis).toBe(150);
    expect(r.body.holding.heldExpenses).toHaveLength(1);
  });

  it("400 on unknown expense kind", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-badkind";
    await addHolding(session, holdingId, 100);
    const r = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/expenses`)
      .set("x-session-id", session)
      .send({ kind: "random-thing", amount: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/kind must be one of/);
  });

  it("400 on amount <= 0", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-zeroamount";
    await addHolding(session, holdingId, 100);
    const r = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/expenses`)
      .set("x-session-id", session)
      .send({ kind: "supplies", amount: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/amount must be a positive number/);
  });

  it("404 on unknown holding id", async () => {
    const session = await signIn();
    const r = await request(app)
      .post("/api/portfolio/holdings/nope-not-here/expenses")
      .set("x-session-id", session)
      .send({ kind: "grading", amount: 50 });
    expect(r.status).toBe(404);
  });

  it("supports all 6 expense kinds", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-allkinds";
    await addHolding(session, holdingId, 100);
    for (const kind of ["grading", "supplies", "shipping_to_grader", "insurance", "storage", "other"]) {
      const r = await request(app)
        .post(`/api/portfolio/holdings/${holdingId}/expenses`)
        .set("x-session-id", session)
        .send({ kind, amount: 5 });
      expect(r.status).toBe(201);
    }
    // 100 + 6 * 5 = 130
    const list = await request(app).get(`/api/portfolio/holdings/${holdingId}/expenses`).set("x-session-id", session);
    expect(list.body.total).toBe(30);
    expect(list.body.expenses).toHaveLength(6);
  });

  it("multiple expenses accumulate into totalCostBasis", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-multi";
    await addHolding(session, holdingId, 200);
    await request(app).post(`/api/portfolio/holdings/${holdingId}/expenses`).set("x-session-id", session)
      .send({ kind: "grading", amount: 50 });
    await request(app).post(`/api/portfolio/holdings/${holdingId}/expenses`).set("x-session-id", session)
      .send({ kind: "supplies", amount: 10 });
    const final = await request(app).post(`/api/portfolio/holdings/${holdingId}/expenses`).set("x-session-id", session)
      .send({ kind: "shipping_to_grader", amount: 15.50 });
    // 200 + 50 + 10 + 15.50 = 275.50
    expect(final.body.newTotalCostBasis).toBe(275.5);
    expect(final.body.holding.heldExpenses).toHaveLength(3);
  });
});

describe("DELETE /api/portfolio/holdings/:id/expenses/:expenseId", () => {
  it("removes an expense and reverses its cost-basis contribution", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-delete";
    await addHolding(session, holdingId, 100);
    const add = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/expenses`)
      .set("x-session-id", session)
      .send({ kind: "grading", amount: 50 });
    const expenseId = add.body.expense.id;
    expect(add.body.newTotalCostBasis).toBe(150);

    const del = await request(app)
      .delete(`/api/portfolio/holdings/${holdingId}/expenses/${expenseId}`)
      .set("x-session-id", session);
    expect(del.status).toBe(200);
    expect(del.body.newTotalCostBasis).toBe(100);
    expect(del.body.holding.heldExpenses).toHaveLength(0);
  });

  it("404 on unknown expense id", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-badexp";
    await addHolding(session, holdingId, 100);
    const r = await request(app)
      .delete(`/api/portfolio/holdings/${holdingId}/expenses/nope-does-not-exist`)
      .set("x-session-id", session);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/Expense not found/);
  });
});

describe("GET /api/portfolio/holdings/:id/expenses", () => {
  it("returns an empty list + $0 total for a holding with no expenses", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-empty";
    await addHolding(session, holdingId, 100);
    const r = await request(app)
      .get(`/api/portfolio/holdings/${holdingId}/expenses`)
      .set("x-session-id", session);
    expect(r.status).toBe(200);
    expect(r.body.expenses).toEqual([]);
    expect(r.body.total).toBe(0);
  });
});

describe("Held expenses flow into /sell realized P&L", () => {
  it("expenses added during hold correctly reduce realizedProfitLoss on sell", async () => {
    const session = await signIn();
    const holdingId = "hold-exp-sell-integration";
    await addHolding(session, holdingId, 100);   // base cost $100
    // Add $50 grading during hold
    await request(app).post(`/api/portfolio/holdings/${holdingId}/expenses`).set("x-session-id", session)
      .send({ kind: "grading", amount: 50 });
    // Now totalCostBasis should be $150
    // Sell for $200 → realized P&L should be $200 - $150 = $50 (not $100!)
    const sell = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/sell`)
      .set("x-session-id", session)
      .send({ quantity: 1, salePrice: 200 });
    expect(sell.status).toBe(200);
    // Full-cost accounting: sale $200 - all-in $150 = $50 realized
    expect(sell.body.sold.costBasisSold).toBe(150);
    expect(sell.body.sold.realizedProfitLoss).toBe(50);
  });
});
