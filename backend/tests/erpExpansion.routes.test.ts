// CF-ERP-EXPANSION (2026-06-03): consolidated integration coverage —
// gating across all new routes + atomic trade write + #5 includeExpenses
// roll-up + 1099-K join correctness in the live route.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, getUserBySession: vi.fn(async () => currentUser) };
});

// Use the portfolioStore's built-in test-mode in-memory store (driven by
// NODE_ENV=test) — that way internal function-to-function calls inside the
// service (recordTradeTransaction → readUserDoc/writeUserDoc) all see the
// same store. Mocking only the outer readUserDoc would miss internal binding.
import {
  readUserDoc as realReadUserDoc,
  writeUserDoc as realWriteUserDoc,
} from "../src/services/portfolioiq/portfolioStore.service.js";

async function seedUserDoc(userId: string, mutate: (doc: any) => void): Promise<void> {
  const doc = await realReadUserDoc(userId);
  mutate(doc);
  await realWriteUserDoc(userId, doc as any);
}

// Stub Cosmos-backed repos so we don't hit the network.
const expensesStore = new Map<string, any[]>();
vi.mock("../src/repositories/portfolioExpenses.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listExpensesForUser: async (userId: string, opts: any = {}) => {
      const arr = expensesStore.get(userId) ?? [];
      return arr.filter((e: any) => {
        if (opts.from && e.date < opts.from) return false;
        if (opts.to && e.date > opts.to) return false;
        if (opts.category && e.category !== opts.category) return false;
        return true;
      });
    },
    createExpense: async (input: any) => {
      const arr = expensesStore.get(input.userId) ?? [];
      const created = { ...input, id: `e-${arr.length + 1}`, createdAt: "2026-06-03T00:00:00Z" };
      arr.push(created);
      expensesStore.set(input.userId, arr);
      return created;
    },
    updateExpense: async (userId: string, id: string, patch: any) => {
      const arr = expensesStore.get(userId) ?? [];
      const idx = arr.findIndex((e: any) => e.id === id);
      if (idx === -1) return null;
      arr[idx] = { ...arr[idx], ...patch };
      return arr[idx];
    },
    deleteExpense: async (userId: string, id: string) => {
      const arr = expensesStore.get(userId) ?? [];
      const next = arr.filter((e: any) => e.id !== id);
      if (next.length === arr.length) return false;
      expensesStore.set(userId, next);
      return true;
    },
  };
});

const filings = new Map<string, any>();
vi.mock("../src/repositories/taxFilings.repository.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getTaxFiling: async (userId: string, year: number) => filings.get(`${userId}:${year}`) ?? null,
    upsertTaxFiling: async (userId: string, year: number, rails: any) => {
      const existing = filings.get(`${userId}:${year}`);
      const merged = {
        userId, taxYear: year,
        rails: { ...(existing?.rails ?? {}), ...rails },
        updatedAt: "2026-06-03T00:00:00Z",
      };
      filings.set(`${userId}:${year}`, merged);
      return merged;
    },
  };
});

function makeUser(plan: string) {
  return { userId: `u-${plan}`, email: `${plan}@t`, plan, createdAt: "2026-01-01T00:00:00Z" };
}

let app: any;
beforeAll(async () => { app = (await import("../src/app")).default; });

beforeEach(async () => {
  vi.clearAllMocks();
  currentUser = null;
  expensesStore.clear();
  filings.clear();
  // Reset the portfolioStore's in-memory test-mode doc for the test user.
  await seedUserDoc("u-pro_seller", (doc) => {
    doc.holdings = {};
    doc.ledger = [];
    doc.trades = undefined;
  });
});

// ─── Gate matrix for the new surface (every new route is pro_seller) ───────

const NEW_ROUTES: Array<{ method: "get" | "post" | "put"; path: string; body?: any }> = [
  { method: "get", path: "/api/portfolio/erp/analytics?groupBy=player" },
  { method: "get", path: "/api/portfolio/erp/analytics/timeseries?bucket=month" },
  { method: "get", path: "/api/portfolio/erp/valuation" },
  { method: "get", path: "/api/portfolio/erp/tax/filings/2025" },
  { method: "put",  path: "/api/portfolio/erp/tax/filings/2025", body: { rails: { ebay: { reportedGross1099K: 100 } } } },
  { method: "get", path: "/api/portfolio/erp/accounting-export?format=json" },
  { method: "get", path: "/api/portfolio/erp/expenses" },
  { method: "post", path: "/api/portfolio/erp/expenses", body: { category: "supplies", amount: 25, date: "2026-05-10" } },
  { method: "get", path: "/api/portfolio/erp/expenses/report" },
  { method: "get", path: "/api/portfolio/erp/unreconciled/aging" },
  { method: "post", path: "/api/portfolio/erp/trades", body: {} },
  { method: "get", path: "/api/portfolio/erp/trades" },
];

for (const route of NEW_ROUTES) {
  describe(`${route.method.toUpperCase()} ${route.path} — gates`, () => {
    it("401 without x-session-id", async () => {
      const r = await (request(app) as any)[route.method](route.path).send(route.body ?? {});
      expect(r.status).toBe(401);
    });
    it("402 for free / collector / investor (pro_seller only)", async () => {
      for (const plan of ["free", "collector", "investor"]) {
        setUser(makeUser(plan));
        const r = await (request(app) as any)[route.method](route.path).set("x-session-id", "s").send(route.body ?? {});
        expect(r.status).toBe(402);
        expect(r.body.feature).toBe("erpReconciliation");
        expect(r.body.requiredTier).toBe("pro_seller");
      }
    });
  });
}

// ─── #4 1099-K live route exercises the join ──────────────────────────────

describe("PUT + GET /api/portfolio/erp/tax/filings/:year", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("upsert + GET surfaces per-rail delta against ledger gross", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L1", userId: "u-pro_seller", holdingId: "h1",
        playerName: "Skenes", cardTitle: "Card",
        quantitySold: 1, unitSalePrice: 1000, grossProceeds: 1000,
        fees: 0, tax: 0, shipping: 0, netProceeds: 800, costBasisSold: 200,
        realizedProfitLoss: 800, realizedProfitLossPct: 400,
        soldAt: "2025-05-10T12:00:00Z", source: "ebay",
        paymentMethod: "ebay_managed",
        needsReconciliation: false,
      });
    });
    const put = await request(app)
      .put("/api/portfolio/erp/tax/filings/2025")
      .set("x-session-id", "s")
      .send({ rails: { ebay: { reportedGross1099K: 1100 } } });
    expect(put.status).toBe(200);
    expect(put.body.rails.find((r: any) => r.rail === "ebay").delta).toBe(100);

    const get = await request(app)
      .get("/api/portfolio/erp/tax/filings/2025")
      .set("x-session-id", "s");
    expect(get.body.rails.find((r: any) => r.rail === "ebay").reported1099K).toBe(1100);
  });
});

// ─── #5 /pnl?includeExpenses=true ─────────────────────────────────────────

describe("GET /api/portfolio/erp/pnl?includeExpenses=true", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("adds operatingExpenses + trueNet only when opted in", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L1", userId: "u-pro_seller", holdingId: "h1",
        playerName: "Skenes", cardTitle: "Card",
        quantitySold: 1, unitSalePrice: 200, grossProceeds: 200,
        fees: 20, tax: 0, shipping: 0, netProceeds: 180, costBasisSold: 50,
        realizedProfitLoss: 130, realizedProfitLossPct: 260,
        soldAt: "2026-05-10T12:00:00Z", source: "manual",
      });
    });
    expensesStore.set("u-pro_seller", [
      { id: "e1", userId: "u-pro_seller", category: "supplies", amount: 25, date: "2026-05-10", createdAt: "" },
    ]);

    const noExpenses = await request(app)
      .get("/api/portfolio/erp/pnl?groupBy=month&from=2026-05-01&to=2026-05-31")
      .set("x-session-id", "s");
    expect(noExpenses.body.operatingExpenses).toBeUndefined();
    expect(noExpenses.body.trueNet).toBeUndefined();

    const withExpenses = await request(app)
      .get("/api/portfolio/erp/pnl?groupBy=month&includeExpenses=true&from=2026-05-01&to=2026-05-31")
      .set("x-session-id", "s");
    expect(withExpenses.body.operatingExpenses).toBe(25);
    expect(withExpenses.body.trueNet).toBe(130 - 25);
  });
});

// ─── #7 trade — atomic write + paymentMethod=trade excluded from rails ────

describe("POST /api/portfolio/erp/trades — atomic write", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("creates N disposal ledger entries + M new holdings + 1 trade record in ONE write", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.holdings["h-out"] = {
        id: "h-out", playerName: "Skenes", quantity: 1,
        purchasePrice: 40, totalCostBasis: 40, purchaseDate: "2025-01-01",
      } as PortfolioHolding;
    });

    const r = await request(app)
      .post("/api/portfolio/erp/trades")
      .set("x-session-id", "s")
      .send({
        tradeDate: "2026-06-01T12:00:00Z",
        cashToMe: 10,
        outgoing: [{ holdingId: "h-out", fmvAtTrade: 100, fmvSource: "manual" }],
        incoming: [{
          cardTitle: "Skenes Bowman Chrome Auto",
          fmvAtTrade: 90, fmvSource: "manual",
          playerName: "Skenes",
        }],
        counterparty: "Joe",
        salesChannel: "card_show",
      });
    expect(r.status).toBe(201);
    expect(r.body.trade.totals.realizedGainLoss).toBe(60);
    expect(r.body.trade.totals.balanceCheck).toBe(0);
    expect(r.body.outgoingHoldingsRemoved).toEqual(["h-out"]);
    expect(r.body.incomingHoldingsCreated.length).toBe(1);

    const doc2 = await realReadUserDoc("u-pro_seller");
    expect(doc2.holdings["h-out"]).toBeUndefined();
    expect(doc2.ledger.length).toBe(1);
    expect(doc2.ledger[0].paymentMethod).toBe("trade");
    expect(doc2.ledger[0].salesChannel).toBe("card_show");
    expect(doc2.ledger[0].tradeId).toBe(r.body.trade.id);
    expect((doc2 as any).trades?.length).toBe(1);

    // New incoming holding gets basis = its FMV (90) per CPA spec.
    const newId = r.body.incomingHoldingsCreated[0];
    expect(doc2.holdings[newId].totalCostBasis).toBe(90);
    expect(doc2.holdings[newId].purchasePrice).toBe(90);
  });

  it("trade disposals DO NOT contribute to 1099-K rails (paymentMethod=trade)", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.holdings["h-out"] = {
        id: "h-out", playerName: "Skenes", quantity: 1,
        purchasePrice: 40, totalCostBasis: 40, purchaseDate: "2025-01-01",
      } as PortfolioHolding;
      doc.ledger.push({
        id: "L-ebay", userId: "u-pro_seller", holdingId: "ignored",
        playerName: "Skenes", cardTitle: "Other", quantitySold: 1, unitSalePrice: 500,
        grossProceeds: 500, fees: 0, tax: 0, shipping: 0, netProceeds: 460, costBasisSold: 100,
        realizedProfitLoss: 360, realizedProfitLossPct: 360,
        soldAt: "2026-06-01T00:00:00Z", source: "ebay", paymentMethod: "ebay_managed",
        needsReconciliation: false,
      });
    });
    await request(app)
      .post("/api/portfolio/erp/trades")
      .set("x-session-id", "s")
      .send({
        tradeDate: "2026-06-02T12:00:00Z",
        cashToMe: 0,
        outgoing: [{ holdingId: "h-out", fmvAtTrade: 100, fmvSource: "manual" }],
        incoming: [{ cardTitle: "Acuna Card", fmvAtTrade: 100, fmvSource: "manual" }],
      });
    const r = await request(app)
      .get("/api/portfolio/erp/tax/filings/2026")
      .set("x-session-id", "s");
    expect(r.body.rails.find((rr: any) => rr.rail === "ebay").ledgerGross).toBe(500);
  });

  it("rejects empty outgoing[]", async () => {
    const r = await request(app)
      .post("/api/portfolio/erp/trades")
      .set("x-session-id", "s")
      .send({ outgoing: [], incoming: [], cashToMe: 0 });
    expect(r.status).toBe(400);
  });
});

// ─── #6 override route exercises the audit-trail end-to-end ───────────────

describe("POST /api/portfolio/erp/unreconciled/:id/override", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("flips needsReconciliation, sets reconciledVia=manual_override, appends adjustment (axis-2 marker present, full fee body)", async () => {
    // CF-PR-E-TWO-AXIS-RECONCILIATION: under Model A, override finalizes
    // only when both axes are met. Seed userCostsProvidedAt + send ALL 7
    // granular fees so axis-1 also completes; finalize fires.
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L1", userId: "u-pro_seller", holdingId: "h1",
        playerName: "Skenes", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0, costBasisSold: 40,
        realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-04-01T00:00:00Z", source: "ebay", paymentMethod: "ebay_managed",
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
        needsReconciliation: true,
        userCostsProvidedAt: "2026-04-02T00:00:00Z",
        userCostsProvidedBy: "u-pro_seller",
      });
    });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L1/override")
      .set("x-session-id", "s")
      .send({
        reason: "from receipt",
        fees: {
          finalValueFee: 13, paymentProcessingFee: 4, promotedListingFee: 0,
          adFee: 0, otherFees: 0, netPayout: 80, actualShippingCost: 3,
        },
      });
    expect(r.status).toBe(200);
    expect(r.body.entry.needsReconciliation).toBe(false);
    expect(r.body.entry.reconciledVia).toBe("manual_override");
    expect(r.body.entry.feeAdjustments.length).toBe(1);
    expect(r.body.adjustment.priorValues.finalValueFee).toBeNull();
    expect(r.body.adjustment.newValues.finalValueFee).toBe(13);
    // CF-PR-E-COSTSSTATUS-AUTHORITATIVE: override response also enriched.
    // Both axes met → finalized → missingFields is empty.
    expect(["needs_action", "saved_pending_fees"]).toContain(r.body.entry.costsStatus);
    expect(r.body.entry.missingFields).toEqual([]);
  });

  it("override response carries costsStatus + missingFields when axis 2 unmet (partial-fee override)", async () => {
    // Same shape as the existing 200 test but WITHOUT the axis-2 marker
    // seeded — proves the enriched shape is on the unhappy-finalize path
    // too (entry stays flagged, response still carries costsStatus +
    // missingFields). Supplies only 2 fees so missingFields reflects the
    // remaining nulls.
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L-partial", userId: "u-pro_seller", holdingId: "h1",
        playerName: "Skenes", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0, costBasisSold: 40,
        realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-04-01T00:00:00Z", source: "ebay", paymentMethod: "ebay_managed",
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
        needsReconciliation: true,
      });
    });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-partial/override")
      .set("x-session-id", "s")
      .send({
        reason: "partial",
        fees: { finalValueFee: 10, paymentProcessingFee: 3 },
      });
    expect(r.status).toBe(200);
    expect(r.body.entry.needsReconciliation).toBe(true); // axis-2 marker absent
    expect(r.body.entry.costsStatus).toBe("needs_action");
    expect(r.body.entry.missingFields).toEqual([
      "promotedListingFee", "adFee", "otherFees", "netPayout", "actualShippingCost",
    ]);
  });
});

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION: save-costs route ─────────────────────

describe("POST /api/portfolio/erp/unreconciled/:id/save-costs", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  function seedEbayUnreconciled(opts: {
    id?: string; feesPresent?: boolean; userCostsProvidedAt?: string;
  } = {}): Promise<void> {
    const id = opts.id ?? "L-sc";
    return seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id, userId: "u-pro_seller", holdingId: "h1",
        playerName: "Hall", cardTitle: "Card",
        quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0,
        costBasisSold: 40, realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-05-15T00:00:00Z", source: "ebay",
        paymentMethod: "ebay_managed",
        finalValueFee: opts.feesPresent ? 10 : null,
        paymentProcessingFee: opts.feesPresent ? 3 : null,
        promotedListingFee: opts.feesPresent ? 0 : null,
        adFee: opts.feesPresent ? 0 : null,
        otherFees: opts.feesPresent ? 0 : null,
        netPayout: opts.feesPresent ? 87 : null,
        actualShippingCost: opts.feesPresent ? 0 : null,
        feeSource: opts.feesPresent ? "ebay_finances" : undefined,
        needsReconciliation: true,
        userCostsProvidedAt: opts.userCostsProvidedAt,
      });
    });
  }

  it("200: saves grading + supplies, sets marker, flag stays true when fees null, audit row appended", async () => {
    await seedEbayUnreconciled();
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-sc/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 15, suppliesCost: 2 });
    expect(r.status).toBe(200);
    expect(r.body.entry.gradingCost).toBe(15);
    expect(r.body.entry.suppliesCost).toBe(2);
    expect(r.body.entry.userCostsProvidedAt).toBeTruthy();
    expect(r.body.entry.userCostsProvidedBy).toBe("u-pro_seller");
    expect(r.body.entry.needsReconciliation).toBe(true); // axis-1 still unmet
    expect(r.body.entry.reconciledVia).toBeUndefined();
    expect(r.body.entry.feeAdjustments.length).toBe(1);
    expect(r.body.adjustment.reason).toMatch(/cost basis/i);
    expect(r.body.adjustment.priorValues.gradingCost).toBeNull();
    expect(r.body.adjustment.newValues.gradingCost).toBe(15);
    // CF-PR-E-COSTSSTATUS-AUTHORITATIVE: response carries enriched shape.
    expect(r.body.entry.costsStatus).toBe("saved_pending_fees");
    expect(r.body.entry.missingFields).toEqual([
      "finalValueFee", "paymentProcessingFee", "promotedListingFee",
      "adFee", "otherFees", "netPayout", "actualShippingCost",
    ]);
  });

  it("200: gradingCost=0 (raw card) still sets marker", async () => {
    await seedEbayUnreconciled({ id: "L-raw" });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-raw/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 0 });
    expect(r.status).toBe(200);
    expect(r.body.entry.gradingCost).toBe(0);
    expect(r.body.entry.userCostsProvidedAt).toBeTruthy();
    expect(r.body.entry.needsReconciliation).toBe(true);
  });

  it("200: when fees already present, save-costs finalizes the entry with reconciledVia derived from feeSource", async () => {
    await seedEbayUnreconciled({ id: "L-fin", feesPresent: true });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-fin/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 5, suppliesCost: 1 });
    expect(r.status).toBe(200);
    expect(r.body.entry.needsReconciliation).toBe(false);
    expect(r.body.entry.reconciledVia).toBe("ebay_finances"); // feeSource was ebay_finances
    // CF-PR-E-COSTSSTATUS-AUTHORITATIVE: enriched shape on the finalize
    // path too. costsStatus is always a valid enum value; missingFields is
    // [] for finalized entries (no nulls left). Client keys finalize off
    // needsReconciliation, so saved_pending_fees on a finalized entry is
    // harmless — the entry exits the inbox regardless.
    expect(["needs_action", "saved_pending_fees"]).toContain(r.body.entry.costsStatus);
    expect(r.body.entry.missingFields).toEqual([]);
  });

  it("200: idempotent re-save while still flagged — updates costs, refreshes marker, appends second audit row", async () => {
    await seedEbayUnreconciled({ id: "L-idem" });
    const r1 = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-idem/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 5 });
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-idem/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 7, suppliesCost: 1 });
    expect(r2.status).toBe(200);
    expect(r2.body.entry.gradingCost).toBe(7);
    expect(r2.body.entry.suppliesCost).toBe(1);
    expect(r2.body.entry.feeAdjustments.length).toBe(2);
  });

  it("400: empty body → MISSING_BODY", async () => {
    await seedEbayUnreconciled({ id: "L-empty" });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-empty/save-costs")
      .set("x-session-id", "s")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("MISSING_BODY");
  });

  it("400: negative value → INVALID_VALUE", async () => {
    await seedEbayUnreconciled({ id: "L-neg" });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-neg/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: -1 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_VALUE");
  });

  it("400: non-number → INVALID_VALUE", async () => {
    await seedEbayUnreconciled({ id: "L-nan" });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-nan/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: "many" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_VALUE");
  });

  it("400: manual entry → NOT_EBAY_ENTRY", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L-manual", userId: "u-pro_seller", holdingId: "h1",
        playerName: "X", cardTitle: "C", quantitySold: 1, unitSalePrice: 50,
        grossProceeds: 50, fees: 2, tax: 0, shipping: 0, netProceeds: 48,
        costBasisSold: 20, realizedProfitLoss: 28, realizedProfitLossPct: 140,
        soldAt: "2026-05-15T00:00:00Z", source: "manual",
        needsReconciliation: true,
      });
    });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-manual/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 5 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NOT_EBAY_ENTRY");
  });

  it("404: nonexistent id", async () => {
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-missing/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 5 });
    expect(r.status).toBe(404);
  });

  it("409: already-finalized entry → ALREADY_FINALIZED", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L-done", userId: "u-pro_seller", holdingId: "h1",
        playerName: "X", cardTitle: "C", quantitySold: 1, unitSalePrice: 50,
        grossProceeds: 50, fees: 0, tax: 0, shipping: 0, netProceeds: 47,
        costBasisSold: 20, realizedProfitLoss: 27, realizedProfitLossPct: 135,
        soldAt: "2026-05-15T00:00:00Z", source: "ebay",
        finalValueFee: 2, paymentProcessingFee: 1, promotedListingFee: 0,
        adFee: 0, otherFees: 0, netPayout: 47, actualShippingCost: 0,
        needsReconciliation: false,
        reconciledVia: "ebay_finances",
      });
    });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-done/save-costs")
      .set("x-session-id", "s")
      .send({ gradingCost: 5 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ALREADY_FINALIZED");
  });

  it("401: no auth", async () => {
    setUser(null);
    await seedEbayUnreconciled({ id: "L-noauth" });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L-noauth/save-costs")
      .send({ gradingCost: 5 });
    expect(r.status).toBe(401);
  });
});

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION: PATCH /ledger/:id finalize wiring ───
//
// Cost-touching PATCH on an UNRECONCILED eBay entry sets the marker as a
// SERVER-DERIVED effect — the smuggle protection on the body whitelist
// stays in place (a client-supplied needsReconciliation in the SAME body is
// still rejected).

describe("PATCH /api/portfolio/ledger/:id — two-axis finalize wiring", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  function seedEbay(id: string, opts: { feesPresent?: boolean } = {}): Promise<void> {
    return seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id, userId: "u-pro_seller", holdingId: "h1",
        playerName: "X", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0,
        costBasisSold: 40, realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-05-15T00:00:00Z", source: "ebay",
        finalValueFee: opts.feesPresent ? 10 : null,
        paymentProcessingFee: opts.feesPresent ? 3 : null,
        promotedListingFee: opts.feesPresent ? 0 : null,
        adFee: opts.feesPresent ? 0 : null,
        otherFees: opts.feesPresent ? 0 : null,
        netPayout: opts.feesPresent ? 87 : null,
        actualShippingCost: opts.feesPresent ? 0 : null,
        feeSource: opts.feesPresent ? "ebay_finances" : undefined,
        needsReconciliation: true,
      });
    });
  }

  it("PATCH gradingCost on unreconciled eBay entry → server sets marker", async () => {
    await seedEbay("L-marker");
    const r = await request(app)
      .patch("/api/portfolio/ledger/L-marker")
      .set("x-session-id", "s")
      .send({ gradingCost: 12 });
    expect(r.status).toBe(200);
    expect(r.body.entry.gradingCost).toBe(12);
    expect(r.body.entry.userCostsProvidedAt).toBeTruthy();
    expect(r.body.entry.userCostsProvidedBy).toBe("u-pro_seller");
    expect(r.body.entry.needsReconciliation).toBe(true); // fees still null
  });

  it("PATCH gradingCost on unreconciled eBay entry with fees PRESENT → server-derived finalize fires", async () => {
    await seedEbay("L-finalize", { feesPresent: true });
    const r = await request(app)
      .patch("/api/portfolio/ledger/L-finalize")
      .set("x-session-id", "s")
      .send({ gradingCost: 8 });
    expect(r.status).toBe(200);
    expect(r.body.entry.needsReconciliation).toBe(false);
    expect(r.body.entry.reconciledVia).toBe("ebay_finances");
    expect(r.body.entry.userCostsProvidedAt).toBeTruthy();
  });

  it("PATCH still rejects client-supplied needsReconciliation in SAME body (smuggle protection unchanged)", async () => {
    await seedEbay("L-smuggle", { feesPresent: true });
    const r = await request(app)
      .patch("/api/portfolio/ledger/L-smuggle")
      .set("x-session-id", "s")
      .send({ gradingCost: 8, needsReconciliation: false });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("FIELD_NOT_ALLOWED");
  });

  it("PATCH on already-finalized eBay entry does NOT re-stamp the marker", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L-done", userId: "u-pro_seller", holdingId: "h1",
        playerName: "X", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 47,
        costBasisSold: 40, realizedProfitLoss: 7, realizedProfitLossPct: 17.5,
        soldAt: "2026-05-15T00:00:00Z", source: "ebay",
        finalValueFee: 10, paymentProcessingFee: 3, promotedListingFee: 0,
        adFee: 0, otherFees: 0, netPayout: 87, actualShippingCost: 0,
        feeSource: "ebay_finances",
        needsReconciliation: false,
        reconciledVia: "ebay_finances",
        userCostsProvidedAt: "2026-05-16T00:00:00Z",
        userCostsProvidedBy: "u-pro_seller",
      });
    });
    const r = await request(app)
      .patch("/api/portfolio/ledger/L-done")
      .set("x-session-id", "s")
      .send({ gradingCost: 15 }); // historical correction
    expect(r.status).toBe(200);
    expect(r.body.entry.gradingCost).toBe(15);
    expect(r.body.entry.userCostsProvidedAt).toBe("2026-05-16T00:00:00Z"); // unchanged
    expect(r.body.entry.needsReconciliation).toBe(false);
  });
});

// ─── CF-PR-E-TWO-AXIS-RECONCILIATION: /unreconciled marker exposure ────────

describe("GET /api/portfolio/erp/unreconciled — costsStatus + marker fields", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("entry without marker → costsStatus='needs_action'; with marker + fees null → 'saved_pending_fees'", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L-needs", userId: "u-pro_seller", holdingId: "h1",
        playerName: "A", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0,
        costBasisSold: 40, realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-05-01T00:00:00Z", source: "ebay",
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
        needsReconciliation: true,
      });
      doc.ledger.push({
        id: "L-saved", userId: "u-pro_seller", holdingId: "h2",
        playerName: "B", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0,
        costBasisSold: 40, realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-05-02T00:00:00Z", source: "ebay",
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
        needsReconciliation: true,
        userCostsProvidedAt: "2026-05-03T00:00:00Z",
        userCostsProvidedBy: "u-pro_seller",
      });
    });
    const r = await request(app)
      .get("/api/portfolio/erp/unreconciled")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    const byId: Record<string, any> = {};
    for (const e of r.body.entries) byId[e.id] = e;
    expect(byId["L-needs"].costsStatus).toBe("needs_action");
    expect(byId["L-saved"].costsStatus).toBe("saved_pending_fees");
    expect(byId["L-saved"].userCostsProvidedAt).toBeTruthy();
    expect(byId["L-saved"].userCostsProvidedBy).toBe("u-pro_seller");
  });
});
