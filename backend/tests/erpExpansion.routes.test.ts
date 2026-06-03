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

  it("flips needsReconciliation, sets reconciledVia=manual_override, appends adjustment", async () => {
    await seedUserDoc("u-pro_seller", (doc) => {
      doc.ledger.push({
        id: "L1", userId: "u-pro_seller", holdingId: "h1",
        playerName: "Skenes", cardTitle: "C", quantitySold: 1, unitSalePrice: 100,
        grossProceeds: 100, fees: 0, tax: 0, shipping: 0, netProceeds: 0, costBasisSold: 40,
        realizedProfitLoss: 0, realizedProfitLossPct: 0,
        soldAt: "2026-04-01T00:00:00Z", source: "ebay", paymentMethod: "ebay_managed",
        finalValueFee: null, paymentProcessingFee: null, netPayout: null, actualShippingCost: null,
        needsReconciliation: true,
      });
    });
    const r = await request(app)
      .post("/api/portfolio/erp/unreconciled/L1/override")
      .set("x-session-id", "s")
      .send({ reason: "from receipt", fees: { finalValueFee: 13, paymentProcessingFee: 4, actualShippingCost: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.entry.needsReconciliation).toBe(false);
    expect(r.body.entry.reconciledVia).toBe("manual_override");
    expect(r.body.entry.feeAdjustments.length).toBe(1);
    expect(r.body.adjustment.priorValues.finalValueFee).toBeNull();
    expect(r.body.adjustment.newValues.finalValueFee).toBe(13);
  });
});
