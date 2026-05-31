// CF-PR-E-BACKEND-ENDPOINTS — PATCH /api/portfolio/ledger/:id coverage.
//
// Verifies the field-whitelist semantics, validation rules, and ownership
// guard for the new ledger-entry edit endpoint. The endpoint unblocks Mac-
// side completion of PR E (Phase 2 dismiss UI + Phase 3 entry forms for
// gradingCost / suppliesCost).
//
// Pattern mirrors backend/tests/portfolio.routes.test.ts: real signIn
// against admin-testing-hobbyiq, supertest, network fetch stubbed.

import request from "supertest";
import { afterEach, beforeEach, vi, describe, it, expect } from "vitest";
import app from "../src/app";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(username: string, password: string): Promise<string> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });

  expect(response.status).toBe(200);
  expect(response.body.sessionId).toBeTruthy();
  return response.body.sessionId as string;
}

// Helper: create a fresh holding + sell it to produce a known ledger entry,
// then return that entry's id. Uses a per-test uuid suffix so concurrent
// runs don't collide.
async function seedLedgerEntry(sessionId: string, suffix: string): Promise<string> {
  const holdingId = `patch-test-${suffix}`;
  const addRes = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id: holdingId,
      playerName: "Mike Trout",
      cardTitle: "2011 Topps Update Mike Trout Patch Test",
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
    });
  expect(addRes.status).toBe(201);

  const sellRes = await request(app)
    .post(`/api/portfolio/holdings/${holdingId}/sell`)
    .set("x-session-id", sessionId)
    .send({
      quantity: 1,
      salePrice: 150,
      fees: 5,
      tax: 0,
      shipping: 3,
      notes: "Test sell for PATCH coverage",
    });
  expect(sellRes.status).toBe(200);

  const ledgerRes = await request(app)
    .get("/api/portfolio/ledger")
    .set("x-session-id", sessionId);
  expect(ledgerRes.status).toBe(200);
  const entry = ledgerRes.body.entries.find((e: any) => e.holdingId === holdingId);
  expect(entry).toBeDefined();
  return entry.id as string;
}

describe("CF-PR-E-BACKEND-ENDPOINTS — PATCH /api/portfolio/ledger/:id", () => {
  it("accepts whitelisted fields (gradingCost, suppliesCost, dismissedAt, dismissedReason)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "whitelist-accept");

    const dismissedAt = new Date().toISOString();
    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({
        gradingCost: 25,
        suppliesCost: 3.5,
        dismissedAt,
        dismissedReason: "Don't have the eBay fee detail",
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Ledger entry updated");
    expect(res.body.entry).toBeDefined();
    expect(res.body.entry.id).toBe(entryId);
    expect(res.body.entry.gradingCost).toBe(25);
    expect(res.body.entry.suppliesCost).toBe(3.5);
    expect(res.body.entry.dismissedAt).toBe(dismissedAt);
    expect(res.body.entry.dismissedReason).toBe("Don't have the eBay fee detail");
  });

  it("persists the update — subsequent GET /ledger returns the patched values", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "persistence");

    await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 42 });

    const ledger = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", session);
    const entry = ledger.body.entries.find((e: any) => e.id === entryId);
    expect(entry?.gradingCost).toBe(42);
  });

  it("rejects non-whitelisted fields (e.g. cardTitle, fees, netProceeds)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "whitelist-reject");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({
        gradingCost: 10,
        cardTitle: "Hacked Title",
        netProceeds: 9999,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ALLOWED");
    expect(res.body.error.message).toMatch(/cardTitle|netProceeds/);
  });

  it("rejects negative gradingCost", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "negative-grading");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("rejects non-numeric gradingCost", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "non-numeric-grading");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: "not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("rejects dismissedReason >500 characters", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "long-reason");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ dismissedReason: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
    expect(res.body.error.message).toMatch(/500/);
  });

  it("accepts dismissedReason at exactly 500 characters (boundary)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "boundary-reason");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ dismissedReason: "x".repeat(500) });

    expect(res.status).toBe(200);
    expect(res.body.entry.dismissedReason).toBe("x".repeat(500));
  });

  it("rejects invalid dismissedAt format", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "bad-timestamp");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ dismissedAt: "not-a-real-date" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VALUE");
  });

  it("accepts explicit null to clear gradingCost / suppliesCost / dismissedAt / dismissedReason", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "null-clear");

    // Set
    await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 25, dismissedAt: new Date().toISOString(), dismissedReason: "test" });

    // Clear via null
    const clear = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: null, suppliesCost: null, dismissedAt: null, dismissedReason: null });

    expect(clear.status).toBe(200);
    expect(clear.body.entry.gradingCost).toBeNull();
    expect(clear.body.entry.suppliesCost).toBeNull();
    expect(clear.body.entry.dismissedAt).toBeNull();
    expect(clear.body.entry.dismissedReason).toBeNull();
  });

  it("returns 404 when entry id does not exist for this user", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");

    const res = await request(app)
      .patch("/api/portfolio/ledger/nonexistent-id-xyz")
      .set("x-session-id", session)
      .send({ gradingCost: 10 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when entry belongs to a DIFFERENT user (cross-user isolation)", async () => {
    // User B creates the entry; user A tries to patch it.
    const sessionA = await signIn("HobbyIQ", "Baseball25");
    const sessionB = await signIn("JusttheBoysandCards", "Carolina23");
    const entryIdB = await seedLedgerEntry(sessionB, "cross-user");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryIdB}`)
      .set("x-session-id", sessionA)
      .send({ gradingCost: 999 });

    // From user A's perspective the entry simply doesn't exist in their
    // user doc — 404 NOT_FOUND is the correct semantic (don't leak that
    // the id exists on another user).
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");

    // User B's entry must be unchanged.
    const ledgerB = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", sessionB);
    const entryB = ledgerB.body.entries.find((e: any) => e.id === entryIdB);
    // Pre-CF-PR-E-P&L-COST-RECOMPUTE, gradingCost was undefined on entries
    // never PATCHed. Post-fix, sellHolding writes gradingCost=null at create
    // time so the field exists explicitly. The test intent is "the cross-user
    // PATCH didn't write 999"; assert the cost stays null (the create-time
    // default), not undefined.
    expect(entryB?.gradingCost ?? null).toBeNull();
  });

  it("returns 401 without x-session-id header", async () => {
    const res = await request(app)
      .patch("/api/portfolio/ledger/anything")
      .send({ gradingCost: 10 });

    expect(res.status).toBe(401);
  });

  it("ignores empty body (no-op patch is a 200, returns existing entry)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "empty-body");

    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.entry.id).toBe(entryId);
  });

  it("does NOT modify needsReconciliation (it remains computed from fee state)", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "needs-reconciliation-unaffected");

    // Try to sneak needsReconciliation into the body — should be rejected.
    const res = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 5, needsReconciliation: false });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ALLOWED");

    // Confirm gradingCost wasn't partially applied — whole patch rejected.
    // Post-CF-PR-E-P&L-COST-RECOMPUTE: sellHolding writes gradingCost=null
    // at create time, so the field exists. Assert it stays null (the
    // create-time default), not the rejected value of 5.
    const ledger = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", session);
    const entry = ledger.body.entries.find((e: any) => e.id === entryId);
    expect(entry?.gradingCost ?? null).toBeNull();
  });
});
