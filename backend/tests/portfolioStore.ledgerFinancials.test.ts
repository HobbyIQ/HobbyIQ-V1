// CF-PR-E-P&L-COST-RECOMPUTE — computeLedgerFinancials helper unit tests
// + integration tests for PATCH P&L recompute.
//
// The helper is the shared source of truth for netProceeds + realizedProfitLoss
// computation. Used by sellHolding (manual sale), markHoldingSoldFromEbay
// (eBay webhook), and updateLedgerEntry (PATCH /api/portfolio/ledger/:id).
//
// Critical invariant tested: gradingCost + suppliesCost reduce netProceeds.
// Pre-fix, these fields were stored but never deducted; users entered $25
// grading cost and saw no P&L change. Post-fix, the cost flows through to
// realizedProfitLoss in all three paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  computeLedgerFinancials,
} from "../src/services/portfolioiq/portfolioStore.service.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeLedgerFinancials — manual sale path", () => {
  it("returns grossProceeds - fees - tax - shipping - costBasis when no user costs", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      tax: 50,
      shipping: 10,
      gradingCost: null,
      suppliesCost: null,
      costBasisSold: 500,
    });
    // netProceeds = 1000 - 100 - 50 - 10 = 840
    expect(r.netProceeds).toBe(840);
    // realizedProfitLoss = 840 - 500 = 340
    expect(r.realizedProfitLoss).toBe(340);
    // pct = (340 / 500) * 100 = 68
    expect(r.realizedProfitLossPct).toBe(68);
  });

  it("subtracts gradingCost from netProceeds", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      tax: 0,
      shipping: 0,
      gradingCost: 25,
      suppliesCost: null,
      costBasisSold: 500,
    });
    expect(r.netProceeds).toBe(875);
    expect(r.realizedProfitLoss).toBe(375);
  });

  it("subtracts suppliesCost from netProceeds", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      tax: 0,
      shipping: 0,
      gradingCost: null,
      suppliesCost: 5,
      costBasisSold: 500,
    });
    expect(r.netProceeds).toBe(895);
    expect(r.realizedProfitLoss).toBe(395);
  });

  it("subtracts BOTH gradingCost and suppliesCost", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      tax: 0,
      shipping: 0,
      gradingCost: 25,
      suppliesCost: 5,
      costBasisSold: 500,
    });
    // 1000 - 100 - 25 - 5 = 870
    expect(r.netProceeds).toBe(870);
    expect(r.realizedProfitLoss).toBe(370);
  });

  it("treats undefined and null as 0 (no regression on entries missing these fields)", () => {
    const r1 = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 0,
      gradingCost: null,
      suppliesCost: null,
      costBasisSold: 0,
    });
    const r2 = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 0,
      // gradingCost, suppliesCost omitted entirely
      costBasisSold: 0,
    });
    expect(r1.netProceeds).toBe(1000);
    expect(r2.netProceeds).toBe(1000);
    expect(r1.realizedProfitLoss).toBe(1000);
    expect(r2.realizedProfitLoss).toBe(1000);
  });

  it("returns 0 pct when costBasisSold is 0 (avoid divide-by-zero)", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      gradingCost: 25,
      suppliesCost: 5,
      costBasisSold: 0,
    });
    expect(r.realizedProfitLossPct).toBe(0);
  });

  it("handles loss case (negative realizedProfitLoss)", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 100,
      feesTotal: 20,
      gradingCost: 30,
      suppliesCost: 10,
      costBasisSold: 200,
    });
    // netProceeds = 100 - 20 - 30 - 10 = 40
    // realizedProfitLoss = 40 - 200 = -160
    expect(r.netProceeds).toBe(40);
    expect(r.realizedProfitLoss).toBe(-160);
    expect(r.realizedProfitLossPct).toBe(-80); // -160 / 200 * 100
  });
});

describe("computeLedgerFinancials — eBay path (netPayoutOverride)", () => {
  it("uses netPayoutOverride as baseline when present, subtracts user costs on top", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100, // ignored when netPayoutOverride is set
      tax: 0,
      shipping: 0,
      gradingCost: 25,
      suppliesCost: 5,
      costBasisSold: 500,
      netPayoutOverride: 850, // eBay-authoritative
    });
    // netProceeds = 850 (eBay net) - 25 (grading) - 5 (supplies) = 820
    expect(r.netProceeds).toBe(820);
    expect(r.realizedProfitLoss).toBe(320);
  });

  it("netPayoutOverride alone (no user costs) equals netPayoutOverride", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 100,
      gradingCost: null,
      suppliesCost: null,
      costBasisSold: 500,
      netPayoutOverride: 850,
    });
    expect(r.netProceeds).toBe(850);
    expect(r.realizedProfitLoss).toBe(350);
  });

  it("netPayoutOverride=null falls through to grossProceeds - feesTotal path", () => {
    const r = computeLedgerFinancials({
      grossProceeds: 1000,
      feesTotal: 150, // sum of granular eBay fees
      tax: 0,
      shipping: 0,
      gradingCost: 25,
      suppliesCost: null,
      costBasisSold: 500,
      netPayoutOverride: null,
    });
    // netProceeds = 1000 - 150 - 25 = 825
    expect(r.netProceeds).toBe(825);
    expect(r.realizedProfitLoss).toBe(325);
  });
});

// ── PATCH endpoint integration: P&L recomputes on cost field change ──────────

async function signIn(username: string, password: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signin")
    .send({ username, password });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

async function seedLedgerEntry(sessionId: string, suffix: string, costBasis = 100): Promise<string> {
  const holdingId = `pl-recompute-${suffix}`;
  const addRes = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id: holdingId,
      playerName: "Mike Trout",
      cardTitle: "2011 Topps Update Mike Trout P&L Test",
      quantity: 1,
      purchasePrice: costBasis,
      totalCostBasis: costBasis,
      currentValue: 200,
    });
  expect(addRes.status).toBe(201);

  const sellRes = await request(app)
    .post(`/api/portfolio/holdings/${holdingId}/sell`)
    .set("x-session-id", sessionId)
    .send({
      quantity: 1,
      salePrice: 200,
      fees: 20,
      tax: 0,
      shipping: 5,
    });
  expect(sellRes.status).toBe(200);

  const ledgerRes = await request(app)
    .get("/api/portfolio/ledger")
    .set("x-session-id", sessionId);
  const entry = ledgerRes.body.entries.find((e: any) => e.holdingId === holdingId);
  expect(entry).toBeDefined();
  return entry.id as string;
}

describe("CF-PR-E-P&L-COST-RECOMPUTE — PATCH triggers P&L recompute", () => {
  it("PATCH gradingCost reduces realizedProfitLoss by the cost amount", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "patch-grading", 100);

    // Initial state via GET — baseline.
    const before = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", session);
    const beforeEntry = before.body.entries.find((e: any) => e.id === entryId);
    const baselinePL = beforeEntry.realizedProfitLoss;
    // baseline = (200 - 20 - 0 - 5) - 100 = 75
    expect(baselinePL).toBe(75);

    // PATCH gradingCost = 25.
    const patch = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 25 });
    expect(patch.status).toBe(200);

    // Response carries the updated entry with recomputed P&L.
    expect(patch.body.entry.gradingCost).toBe(25);
    expect(patch.body.entry.netProceeds).toBe(75 + 100 - 25); // 175 - 25 = 150
    expect(patch.body.entry.realizedProfitLoss).toBe(75 - 25); // 50
  });

  it("PATCH suppliesCost reduces realizedProfitLoss by the cost amount", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "patch-supplies", 100);

    const patch = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ suppliesCost: 5 });
    expect(patch.status).toBe(200);

    expect(patch.body.entry.suppliesCost).toBe(5);
    expect(patch.body.entry.realizedProfitLoss).toBe(75 - 5); // 70
  });

  it("PATCH both costs accumulates the deduction", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "patch-both", 100);

    const patch = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 25, suppliesCost: 5 });
    expect(patch.status).toBe(200);

    expect(patch.body.entry.realizedProfitLoss).toBe(75 - 25 - 5); // 45
  });

  it("PATCH gradingCost back to null restores baseline P&L", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "patch-restore", 100);

    await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 25 });

    const restore = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: null });
    expect(restore.status).toBe(200);

    expect(restore.body.entry.gradingCost).toBeNull();
    expect(restore.body.entry.realizedProfitLoss).toBe(75); // baseline restored
  });

  it("PATCH of dismissedAt (non-financial field) does NOT recompute P&L", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");
    const entryId = await seedLedgerEntry(session, "patch-non-financial", 100);

    // First, set gradingCost so we have a non-default P&L baseline.
    await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ gradingCost: 25 });

    // Verify P&L = 50 post-gradingCost.
    const mid = await request(app)
      .get("/api/portfolio/ledger")
      .set("x-session-id", session);
    expect(mid.body.entries.find((e: any) => e.id === entryId).realizedProfitLoss).toBe(50);

    // Now PATCH only dismissedAt.
    const patch = await request(app)
      .patch(`/api/portfolio/ledger/${entryId}`)
      .set("x-session-id", session)
      .send({ dismissedAt: new Date().toISOString() });
    expect(patch.status).toBe(200);

    // P&L unchanged (recompute didn't fire for dismissedAt).
    expect(patch.body.entry.realizedProfitLoss).toBe(50);
    expect(patch.body.entry.gradingCost).toBe(25);
  });
});

describe("CF-PR-E-P&L-COST-RECOMPUTE — sellHolding deducts costs at create time", () => {
  it("POST /sell with gradingCost in body produces correct P&L at entry create", async () => {
    const session = await signIn("HobbyIQ", "Baseball25");

    const holdingId = "sell-with-grading";
    await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", session)
      .send({
        id: holdingId,
        playerName: "Mike Trout",
        cardTitle: "Test card",
        quantity: 1,
        purchasePrice: 100,
        totalCostBasis: 100,
        currentValue: 200,
      });

    const sell = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/sell`)
      .set("x-session-id", session)
      .send({
        quantity: 1,
        salePrice: 200,
        fees: 20,
        tax: 0,
        shipping: 5,
        gradingCost: 25,
        suppliesCost: 3,
      });
    expect(sell.status).toBe(200);

    // 200 - 20 - 0 - 5 - 25 - 3 = 147 netProceeds; 147 - 100 = 47 P&L
    expect(sell.body.sold.netProceeds).toBe(147);
    expect(sell.body.sold.realizedProfitLoss).toBe(47);
    expect(sell.body.sold.gradingCost).toBe(25);
    expect(sell.body.sold.suppliesCost).toBe(3);
  });
});
