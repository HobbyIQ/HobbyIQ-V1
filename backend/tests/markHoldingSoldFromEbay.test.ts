import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import {
  markHoldingSoldFromEbay,
  type EbaySaleData,
} from "../src/services/portfolioiq/portfolioStore.service.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const response = await request(app)
    .post("/api/auth/signin")
    .send({ username: "HobbyIQ", password: "Baseball25" });
  expect(response.status).toBe(200);
  return {
    sessionId: response.body.sessionId as string,
    userId: response.body.user?.userId as string,
  };
}

async function addHolding(
  sessionId: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const res = await request(app)
    .post("/api/portfolio/holdings")
    .set("x-session-id", sessionId)
    .send({
      id,
      playerName: "Paul Skenes",
      // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
      cardYear: 2024,
      product: "Bowman Chrome",
      cardTitle: "2024 Bowman Chrome Auto",
      quantity: 1,
      purchasePrice: 100,
      totalCostBasis: 100,
      ...overrides,
    });
  expect(res.status).toBe(201);
}

async function getLedger(sessionId: string): Promise<any[]> {
  const res = await request(app).get("/api/portfolio/ledger").set("x-session-id", sessionId);
  expect(res.status).toBe(200);
  return (res.body.entries ?? res.body.ledger ?? res.body) as any[];
}

function fullEbayData(overrides: Partial<EbaySaleData> = {}): EbaySaleData {
  return {
    ebayOrderId: "ORDER-AAA-1",
    ebayOfferId: "OFFER-AAA-1",
    ebayListingId: "LIST-AAA-1",
    ebayBuyerUsername: "buyer_jane",
    saleConfirmedAt: "2026-05-21T18:00:00.000Z",
    quantitySold: 1,
    unitSalePrice: 250,
    finalValueFee: 25,
    paymentProcessingFee: 7.5,
    promotedListingFee: 5,
    adFee: 0,
    otherFees: 0,
    netPayout: 200,
    actualShippingCost: 12,
    suppliesCost: 1.5,
    gradingCost: 25,
    ...overrides,
  };
}

describe("markHoldingSoldFromEbay (PR D.6)", () => {
  it("happy path full-quantity sale: returns marked-sold, deletes holding, persists ledger entry", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-1";
    await addHolding(sessionId, holdingId);

    const result = await markHoldingSoldFromEbay(userId, holdingId, fullEbayData());
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;
    expect(result.holdingRemoved).toBe(true);
    expect(result.remainingQuantity).toBe(0);

    const e = result.entry;
    expect(e.source).toBe("ebay");
    expect(e.ebayOrderId).toBe("ORDER-AAA-1");
    expect(e.ebayOfferId).toBe("OFFER-AAA-1");
    expect(e.ebayListingId).toBe("LIST-AAA-1");
    expect(e.ebayBuyerUsername).toBe("buyer_jane");
    expect(e.ebaySaleConfirmedAt).toBe("2026-05-21T18:00:00.000Z");
    expect(e.soldAt).toBe("2026-05-21T18:00:00.000Z");
    // Granular fees stored verbatim
    expect(e.finalValueFee).toBe(25);
    expect(e.paymentProcessingFee).toBe(7.5);
    expect(e.netPayout).toBe(200);
    expect(e.actualShippingCost).toBe(12);
    expect(e.suppliesCost).toBe(1.5);
    expect(e.gradingCost).toBe(25);
    // Legacy aggregates zeroed
    expect(e.fees).toBe(0);
    expect(e.tax).toBe(0);
    expect(e.shipping).toBe(0);
    expect(e.needsReconciliation).toBe(false);
    // netProceeds: starts from eBay-authoritative netPayout=200, then
    // subtracts user-side costs (gradingCost=25 + suppliesCost=1.5).
    // Pre-CF-PR-E-P&L-COST-RECOMPUTE this was 200 flat (bug: user costs
    // were stored but never deducted). Post-fix: 200 - 25 - 1.5 = 173.5.
    expect(e.netProceeds).toBe(173.5);
    expect(e.grossProceeds).toBe(250);
    expect(e.costBasisSold).toBe(100);
    // realizedProfitLoss = netProceeds (173.5) - costBasisSold (100) = 73.5
    expect(e.realizedProfitLoss).toBe(73.5);

    // Holding deleted from inventory
    const inv = await request(app).get("/api/portfolio/holdings").set("x-session-id", sessionId);
    const holdings = (inv.body.holdings ?? inv.body) as any[];
    expect(holdings.find((h) => h.id === holdingId)).toBeUndefined();
  });

  it("happy path partial sale: prorates costBasis and currentValue, holdingRemoved=false", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-partial";
    // CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase A: setup expresses the holding's
    // value via stored facts (fairMarketValue × quantity = 100 × 4 = $400 total)
    // instead of pre-caching currentValue. Post-sale assertion at 300 stands.
    await addHolding(sessionId, holdingId, {
      quantity: 4,
      purchasePrice: 25, // unit cost
      totalCostBasis: 100,
      fairMarketValue: 100,
    });

    const result = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-PARTIAL-1", quantitySold: 1, unitSalePrice: 120, netPayout: 100 }),
    );
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;
    expect(result.holdingRemoved).toBe(false);
    expect(result.remainingQuantity).toBe(3);
    expect(result.entry.quantitySold).toBe(1);
    expect(result.entry.costBasisSold).toBe(25);
    // netPayout=100 then -25 gradingCost -1.5 suppliesCost = 73.5
    // (CF-PR-E-P&L-COST-RECOMPUTE deducts user-side costs from netProceeds)
    expect(result.entry.netProceeds).toBe(73.5);

    // Inventory still has 3 with prorated cost basis
    const inv = await request(app).get("/api/portfolio/holdings").set("x-session-id", sessionId);
    const h = ((inv.body.holdings ?? inv.body) as any[]).find((x) => x.id === holdingId);
    expect(h.quantity).toBe(3);
    expect(h.totalCostBasis).toBe(75);
    expect(h.currentValue).toBe(300);
  });

  it("NULL-not-zero on FEE fields: omitting all eBay fee fields stores null; needsReconciliation=true", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-null";
    await addHolding(sessionId, holdingId);

    const result = await markHoldingSoldFromEbay(userId, holdingId, {
      ebayOrderId: "ORDER-NULL-1",
      saleConfirmedAt: "2026-05-21T18:00:00.000Z",
      quantitySold: 1,
      unitSalePrice: 250,
      // Every fee field omitted.
    });
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;

    const e = result.entry;
    // Fee fields (eBay-side): still NULL-not-zero — those come from the
    // Finances API and NULL faithfully represents "unknown."
    expect(e.finalValueFee).toBeNull();
    expect(e.paymentProcessingFee).toBeNull();
    expect(e.promotedListingFee).toBeNull();
    expect(e.adFee).toBeNull();
    expect(e.otherFees).toBeNull();
    expect(e.actualShippingCost).toBeNull();
    expect(e.netPayout).toBeNull();
    // CF-AUTO-RECONCILE-LAYER-1 (2026-07-12): user costs (grading/supplies)
    // auto-zero-fill on the safe path (no heldExpenses, no prior regrade).
    // The `userCostsProvidedAt` marker + `userCostsProvidedBy` provenance
    // distinguish auto-zero from user-set — audit trail stays clean.
    expect(e.suppliesCost).toBe(0);
    expect(e.gradingCost).toBe(0);
    expect((e as any).userCostsProvidedBy).toBe("system:auto-zero-costs");
    expect((e as any).userCostsProvidedAt).toMatch(/^\d{4}-/);
    // Entry stays needsReconciliation=true because axis 1 (fees) is
    // completely empty — Layer 2's netPayout+shipping shortcut isn't
    // satisfied either. Finances arrival will finalize automatically.
    expect(e.needsReconciliation).toBe(true);
    expect(e.netProceeds).toBe(250);
    expect(e.grossProceeds).toBe(250);
  });

  // CF-AUTO-RECONCILE (2026-07-12): the partial-Finances case Drew hit
  // pre-#389 — netPayout + shipping arrive but the granular breakdown
  // stays null. With Layer 1 auto-zero-costs + Layer 2 relaxed fees axis,
  // this shape now auto-closes the moment the webhook fires.
  it("Layer 1 + 2: partial Finances (netPayout + shipping only) + fresh holding → auto-closes on write", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-partial-auto-close";
    await addHolding(sessionId, holdingId);

    const result = await markHoldingSoldFromEbay(userId, holdingId, {
      ebayOrderId: "ORDER-AUTO-CLOSE-1",
      saleConfirmedAt: "2026-07-01T00:00:00Z",
      quantitySold: 1,
      unitSalePrice: 250,
      netPayout: 220,
      actualShippingCost: 5,
      // Granular breakdown deliberately omitted — the shape Drew's 4
      // stuck entries had.
    });
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;
    const e = result.entry;
    // Auto-closed on webhook write — no user action needed.
    expect(e.needsReconciliation).toBe(false);
    expect(e.reconciledVia).toBe("ebay_finances");
    // Auto-zero-costs marker
    expect(e.gradingCost).toBe(0);
    expect(e.suppliesCost).toBe(0);
    expect((e as any).userCostsProvidedBy).toBe("system:auto-zero-costs");
    // Financials from netPayout
    expect(e.netProceeds).toBe(220);
  });

  it("netPayout is authoritative: overrides what granular fees would imply", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-netpayout";
    await addHolding(sessionId, holdingId);

    const result = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({
        ebayOrderId: "ORDER-NP-1",
        unitSalePrice: 250,
        finalValueFee: 99, // would imply much lower net if used
        paymentProcessingFee: 99,
        promotedListingFee: 99,
        adFee: 99,
        otherFees: 99,
        actualShippingCost: 99,
        netPayout: 42,
      }),
    );
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;
    // netPayout=42 then -25 gradingCost -1.5 suppliesCost = 15.5
    // (CF-PR-E-P&L-COST-RECOMPUTE deducts user-side costs from netProceeds)
    expect(result.entry.netProceeds).toBe(15.5);
    expect(result.entry.needsReconciliation).toBe(false);
  });

  it("partial reconciliation: some fees null, no netPayout → needsReconciliation=true and netProceeds is computed but should not be trusted", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-partial-recon";
    await addHolding(sessionId, holdingId);

    const result = await markHoldingSoldFromEbay(userId, holdingId, {
      ebayOrderId: "ORDER-RECON-1",
      saleConfirmedAt: "2026-05-21T18:00:00.000Z",
      quantitySold: 1,
      unitSalePrice: 250,
      finalValueFee: 25,
      paymentProcessingFee: 7.5,
      // promotedListingFee, adFee, otherFees, actualShippingCost all omitted
    });
    expect(result.status).toBe("marked-sold");
    if (result.status !== "marked-sold") return;

    const e = result.entry;
    expect(e.finalValueFee).toBe(25);
    expect(e.paymentProcessingFee).toBe(7.5);
    expect(e.promotedListingFee).toBeNull();
    expect(e.adFee).toBeNull();
    expect(e.otherFees).toBeNull();
    expect(e.actualShippingCost).toBeNull();
    expect(e.netPayout).toBeNull();
    // Computed from known fees only — null fees contribute 0 to the sum.
    expect(e.netProceeds).toBe(250 - 25 - 7.5);
    // ...but the entry is flagged so downstream readers know it's incomplete.
    expect(e.needsReconciliation).toBe(true);
  });

  it("idempotent on (holdingId, ebayOrderId): replay returns marked-sold-deduped, no duplicate ledger, no state change", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-idem";
    await addHolding(sessionId, holdingId, { quantity: 4, purchasePrice: 25, totalCostBasis: 100 });

    const first = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-IDEM-1", quantitySold: 1, unitSalePrice: 120, netPayout: 100 }),
    );
    expect(first.status).toBe("marked-sold");
    if (first.status !== "marked-sold") return;
    const firstEntryId = first.entry.id;

    // Snapshot ledger length
    const ledgerBefore = await getLedger(sessionId);
    expect(ledgerBefore.filter((e) => e.ebayOrderId === "ORDER-IDEM-1")).toHaveLength(1);

    // Replay with the SAME ebayOrderId
    const replay = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-IDEM-1", quantitySold: 1, unitSalePrice: 120, netPayout: 100 }),
    );
    expect(replay.status).toBe("marked-sold-deduped");
    if (replay.status !== "marked-sold-deduped") return;
    expect(replay.entry.id).toBe(firstEntryId);

    // Ledger length unchanged
    const ledgerAfter = await getLedger(sessionId);
    expect(ledgerAfter.filter((e) => e.ebayOrderId === "ORDER-IDEM-1")).toHaveLength(1);

    // Holding still has 3 left (replay did not double-decrement)
    const inv = await request(app).get("/api/portfolio/holdings").set("x-session-id", sessionId);
    const h = ((inv.body.holdings ?? inv.body) as any[]).find((x) => x.id === holdingId);
    expect(h.quantity).toBe(3);
  });

  it("idempotency does NOT collide on different orderIds for the same holding", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-multi-order";
    await addHolding(sessionId, holdingId, { quantity: 4, purchasePrice: 25, totalCostBasis: 100 });

    const a = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-MO-A", quantitySold: 1, unitSalePrice: 120, netPayout: 100 }),
    );
    const b = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-MO-B", quantitySold: 1, unitSalePrice: 130, netPayout: 110 }),
    );
    expect(a.status).toBe("marked-sold");
    expect(b.status).toBe("marked-sold");

    const ledger = await getLedger(sessionId);
    const orderIds = ledger.filter((e) => e.holdingId === holdingId).map((e) => e.ebayOrderId);
    expect(orderIds).toContain("ORDER-MO-A");
    expect(orderIds).toContain("ORDER-MO-B");
  });

  it("holding-not-found: returns structured result, never throws, ledger unchanged", async () => {
    const { userId } = await signIn();
    const result = await markHoldingSoldFromEbay(
      userId,
      "this-holding-does-not-exist",
      fullEbayData({ ebayOrderId: "ORDER-MISSING-1" }),
    );
    expect(result.status).toBe("holding-not-found");
  });

  it("invalid-input: empty ebayOrderId, invalid quantity, invalid sale price all return invalid-input", async () => {
    const { sessionId, userId } = await signIn();
    const holdingId = "ebay-sale-invalid";
    await addHolding(sessionId, holdingId);

    const empty = await markHoldingSoldFromEbay(userId, holdingId, fullEbayData({ ebayOrderId: "" }));
    expect(empty.status).toBe("invalid-input");

    const whitespace = await markHoldingSoldFromEbay(userId, holdingId, fullEbayData({ ebayOrderId: "   " }));
    expect(whitespace.status).toBe("invalid-input");

    const overQty = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-QTY-1", quantitySold: 999 }),
    );
    expect(overQty.status).toBe("invalid-input");

    const zeroPrice = await markHoldingSoldFromEbay(
      userId,
      holdingId,
      fullEbayData({ ebayOrderId: "ORDER-PRICE-1", unitSalePrice: 0 }),
    );
    expect(zeroPrice.status).toBe("invalid-input");

    // Missing userId / holdingId
    const noUser = await markHoldingSoldFromEbay("", holdingId, fullEbayData({ ebayOrderId: "ORDER-NOUSER" }));
    expect(noUser.status).toBe("invalid-input");
    const noHolding = await markHoldingSoldFromEbay(userId, "", fullEbayData({ ebayOrderId: "ORDER-NOHOLDING" }));
    expect(noHolding.status).toBe("invalid-input");
  });

  it("manual sellHolding flow is unaffected: emits source='manual' + no eBay fields + default fees=0", async () => {
    const { sessionId } = await signIn();
    const holdingId = "manual-sale-untouched";
    const add = await request(app)
      .post("/api/portfolio/holdings")
      .set("x-session-id", sessionId)
      .send({
        id: holdingId,
        playerName: "Wyatt Langford",
        // CF-PORTFOLIO-HOLDING-IDENTITY-VALIDATION (2026-06-01).
        cardYear: 2024,
        product: "Topps Chrome",
        cardTitle: "2024 Topps Chrome RC",
        quantity: 1,
        purchasePrice: 30,
        totalCostBasis: 30,
      });
    expect(add.status).toBe(201);

    const sale = await request(app)
      .post(`/api/portfolio/holdings/${holdingId}/sell`)
      .set("x-session-id", sessionId)
      .send({ quantity: 1, salePrice: 80 });
    expect(sale.status).toBe(200);

    const ledger = await getLedger(sessionId);
    const entry = ledger.find((e) => e.holdingId === holdingId);
    expect(entry).toBeDefined();
    // CF-MANUAL-SELL-EXPLICIT-SOURCE (2026-07-11, PR #373): manual entries
    // now emit source='manual' explicitly (was omitted; readers still
    // default absent → 'manual' for legacy entries). The write-side change
    // gives Cosmos queries a positive marker to filter on without OR-null
    // clauses and gives iOS a positive value to assert against.
    expect(entry.source).toBe("manual");
    expect(Object.prototype.hasOwnProperty.call(entry, "ebayOrderId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entry, "needsReconciliation")).toBe(false);
    // Manual flow still defaults fee aggregates to 0.
    expect(entry.fees).toBe(0);
    expect(entry.tax).toBe(0);
    expect(entry.shipping).toBe(0);
  });
});
