// CF-MUTATION-ENVELOPE-PARITY (2026-07-12) — every inventory mutation
// route returns the updated holding so iOS doesn't need to refetch to
// see the effect of its own write. Both `holding` (top-level, legacy-
// compatible) and `entry.holding` (nested, iOS decoder path) are
// present.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app.js";

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

async function seedHolding(session: string, id: string, extra: Record<string, unknown> = {}) {
  const r = await request(app).post("/api/portfolio/holdings").set("x-session-id", session).send({
    id,
    playerName: "Test Player",
    cardYear: 2020,
    setName: "Test Set",
    product: "Test Set",
    cardNumber: "1",
    gradeCompany: "PSA",
    gradeValue: 10,
    quantity: 5,
    purchasePrice: 100,
    totalCostBasis: 500,
    isAuto: false,
    ...extra,
  });
  expect(r.status).toBeLessThan(400);
}

function assertEnvelopeHasHolding(body: any, expectedId: string) {
  expect(body.holding).toBeTruthy();
  expect(body.holding.id).toBe(expectedId);
  expect(body.entry).toBeTruthy();
  expect(body.entry.holding).toBeTruthy();
  expect(body.entry.holding.id).toBe(expectedId);
}

describe("Mutation response envelope parity — every route returns updated holding", () => {
  it("PATCH /holdings/:id → holding + entry.holding present", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-patch");
    const r = await request(app)
      .patch("/api/portfolio/holdings/envelope-patch")
      .set("x-session-id", session)
      .send({ notes: "updated" });
    expect(r.status).toBe(200);
    assertEnvelopeHasHolding(r.body, "envelope-patch");
    expect(r.body.holding.notes).toBe("updated");
  });

  it("POST /holdings/:id/regrade → holding + entry.holding present (updatedHolding preserved)", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-regrade");
    const r = await request(app)
      .post("/api/portfolio/holdings/envelope-regrade/regrade")
      .set("x-session-id", session)
      .send({ gradeCompany: "BGS", gradeValue: 9.5, gradingCost: 25 });
    expect(r.status).toBe(200);
    assertEnvelopeHasHolding(r.body, "envelope-regrade");
    expect(r.body.updatedHolding).toBeTruthy();   // legacy field preserved
    expect(r.body.holding.gradeCompany).toBe("BGS");
    expect(r.body.holding.gradeValue).toBe(9.5);
  });

  it("POST /holdings/:id/refresh → holding + entry.holding present", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-refresh");
    const r = await request(app)
      .post("/api/portfolio/holdings/envelope-refresh/refresh")
      .set("x-session-id", session)
      .send({});
    expect(r.status).toBe(200);
    assertEnvelopeHasHolding(r.body, "envelope-refresh");
  });

  it("POST /holdings/:id/expenses → holding + entry.holding present", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-expense-add");
    const r = await request(app)
      .post("/api/portfolio/holdings/envelope-expense-add/expenses")
      .set("x-session-id", session)
      .send({ kind: "grading", amount: 25 });
    expect(r.status).toBe(201);
    assertEnvelopeHasHolding(r.body, "envelope-expense-add");
    expect(r.body.expense.kind).toBe("grading");
    expect(r.body.newTotalCostBasis).toBeGreaterThanOrEqual(500);
  });

  it("DELETE /holdings/:id/expenses/:expenseId → holding + entry.holding present", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-expense-del");
    const add = await request(app)
      .post("/api/portfolio/holdings/envelope-expense-del/expenses")
      .set("x-session-id", session)
      .send({ kind: "grading", amount: 25 });
    const expenseId = add.body.expense.id;

    const r = await request(app)
      .delete(`/api/portfolio/holdings/envelope-expense-del/expenses/${expenseId}`)
      .set("x-session-id", session);
    expect(r.status).toBe(200);
    assertEnvelopeHasHolding(r.body, "envelope-expense-del");
  });

  it("POST /holdings/:id/sell partial-quantity → holding present with new quantity", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-sell-partial", { quantity: 5, totalCostBasis: 500 });
    const r = await request(app)
      .post("/api/portfolio/holdings/envelope-sell-partial/sell")
      .set("x-session-id", session)
      .send({ quantity: 2, salePrice: 150 });
    expect(r.status).toBe(200);
    expect(r.body.holdingRemoved).toBe(false);
    expect(r.body.remainingQuantity).toBe(3);
    assertEnvelopeHasHolding(r.body, "envelope-sell-partial");
    expect(r.body.holding.quantity).toBe(3);
  });

  it("POST /holdings/:id/sell full-quantity → holdingRemoved=true, holding is null", async () => {
    const session = await signIn();
    await seedHolding(session, "envelope-sell-full", { quantity: 1 });
    const r = await request(app)
      .post("/api/portfolio/holdings/envelope-sell-full/sell")
      .set("x-session-id", session)
      .send({ quantity: 1, salePrice: 150 });
    expect(r.status).toBe(200);
    expect(r.body.holdingRemoved).toBe(true);
    expect(r.body.remainingQuantity).toBe(0);
    // No holding when the row is gone — but iOS still has the sold ledger entry
    expect(r.body.holding).toBeNull();
    expect(r.body.entry).toBeUndefined();
    expect(r.body.sold).toBeTruthy();
  });
});
