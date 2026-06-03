// CF-ERP-RECONCILIATION (2026-06-03): /api/portfolio/erp gate + integration.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type {
  HoldingsById,
  LedgerEntryForErp,
} from "../src/services/portfolioiq/erpReconciliation.service.js";

process.env.NODE_ENV = "test";
process.env.COMPIQ_CORPUS_DISABLED = "1";

let currentUser: any = null;
function setUser(u: any) { currentUser = u; }

vi.mock("../src/services/authService.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getUserBySession: vi.fn(async () => currentUser),
  };
});

const readUserDocMock = vi.fn(async (_userId: string) => ({
  id: "u",
  userId: "u",
  holdings: {} as HoldingsById,
  ledger: [] as LedgerEntryForErp[],
  priceHistoryByHolding: {},
  alerts: [],
  recommendationFeedback: [],
}));
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: (...args: unknown[]) => readUserDocMock(...(args as [string])),
  };
});

function makeUser(plan: string) {
  return {
    userId: `u-${plan}`,
    email: `${plan}@t`,
    username: null,
    fullName: null,
    plan,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeLedgerSet(): {
  ledger: LedgerEntryForErp[];
  holdings: HoldingsById;
} {
  return {
    ledger: [
      {
        id: "L1",
        userId: "u",
        holdingId: "h1",
        playerName: "Skenes",
        cardTitle: "2024 Topps Chrome",
        quantitySold: 1,
        unitSalePrice: 300,
        grossProceeds: 300,
        fees: 0,
        tax: 0,
        shipping: 0,
        netProceeds: 240,
        costBasisSold: 100,
        realizedProfitLoss: 140,
        realizedProfitLossPct: 140,
        soldAt: "2026-05-10T12:00:00Z",
        source: "ebay",
        ebayOrderId: "O1",
        finalValueFee: 35,
        paymentProcessingFee: 8,
        promotedListingFee: 0,
        adFee: 0,
        otherFees: 0,
        netPayout: 257,
        actualShippingCost: 17,
        needsReconciliation: false,
      },
      {
        id: "L2",
        userId: "u",
        holdingId: "h2",
        playerName: "Judge",
        cardTitle: "2017 Topps Update RC",
        quantitySold: 1,
        unitSalePrice: 1000,
        grossProceeds: 1000,
        fees: 0,
        tax: 0,
        shipping: 0,
        netProceeds: 0,
        costBasisSold: 200,
        realizedProfitLoss: 0,
        realizedProfitLossPct: 0,
        soldAt: "2026-06-01T12:00:00Z",
        source: "ebay",
        ebayOrderId: "O2",
        finalValueFee: null,
        paymentProcessingFee: null,
        netPayout: null,
        actualShippingCost: null,
        needsReconciliation: true,
      },
    ],
    holdings: {
      h1: { id: "h1", playerName: "Skenes", cardYear: 2024, setName: "Topps Chrome", purchaseDate: "2025-09-15" },
      h2: { id: "h2", playerName: "Judge", cardYear: 2017, setName: "Topps Update", purchaseDate: "2018-01-01", gradeCompany: "PSA", gradeValue: 10 },
    },
  };
}

let app: any;

beforeAll(async () => {
  app = (await import("../src/app")).default;
});

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  readUserDocMock.mockReset().mockResolvedValue({
    id: "u",
    userId: "u",
    holdings: {} as HoldingsById,
    ledger: [] as LedgerEntryForErp[],
    priceHistoryByHolding: {},
    alerts: [],
    recommendationFeedback: [],
  });
});

// ─── Gate matrix ────────────────────────────────────────────────────────────

const ROUTES: Array<{ name: string; path: string }> = [
  { name: "unreconciled", path: "/api/portfolio/erp/unreconciled" },
  { name: "pnl", path: "/api/portfolio/erp/pnl?groupBy=month" },
  { name: "tax-export json", path: "/api/portfolio/erp/tax-export?format=json" },
];

for (const route of ROUTES) {
  describe(`GET ${route.path} — gates`, () => {
    it("401 without x-session-id", async () => {
      const r = await request(app).get(route.path);
      expect(r.status).toBe(401);
    });
    it("402 for free (lacks erpReconciliation)", async () => {
      setUser(makeUser("free"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.feature).toBe("erpReconciliation");
      expect(r.body.requiredTier).toBe("pro_seller");
    });
    it("402 for collector", async () => {
      setUser(makeUser("collector"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.requiredTier).toBe("pro_seller");
    });
    it("402 for investor (investor lacks erpReconciliation)", async () => {
      setUser(makeUser("investor"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(402);
      expect(r.body.feature).toBe("erpReconciliation");
      expect(r.body.requiredTier).toBe("pro_seller");
    });
    it("pro_seller passes", async () => {
      setUser(makeUser("pro_seller"));
      const r = await request(app).get(route.path).set("x-session-id", "s");
      expect(r.status).toBe(200);
    });
  });
}

// ─── /unreconciled payload ──────────────────────────────────────────────────

describe("GET /api/portfolio/erp/unreconciled", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("returns unreconciled entries with missingFields + counts", async () => {
    const { ledger, holdings } = makeLedgerSet();
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/unreconciled")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBe(1);
    expect(r.body.entries[0].id).toBe("L2");
    expect(r.body.entries[0].missingFields).toContain("finalValueFee");
    expect(r.body.counts.unreconciledTotal).toBe(1);
    expect(r.body.counts.dismissedHidden).toBe(0);
  });
});

// ─── /pnl payload ───────────────────────────────────────────────────────────

describe("GET /api/portfolio/erp/pnl", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("400 on unknown groupBy", async () => {
    const r = await request(app)
      .get("/api/portfolio/erp/pnl?groupBy=banana")
      .set("x-session-id", "s");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/groupBy/);
  });

  it("excludes unreconciled from totals, surfaces excluded counter", async () => {
    const { ledger, holdings } = makeLedgerSet();
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/pnl?groupBy=source")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    // Reconciled: 1 ebay entry (L1) — gross 300, gain 140, count 1.
    // L2 (NULL fees + needsReconciliation=true) excluded.
    expect(r.body.totals.entryCount).toBe(1);
    expect(r.body.totals.grossProceeds).toBeCloseTo(300, 2);
    expect(r.body.totals.realizedProfitLoss).toBeCloseTo(140, 2);
    expect(r.body.excluded.unreconciledCount).toBe(1);
    expect(r.body.excluded.unreconciledOldestSoldAt).toBe("2026-06-01T12:00:00Z");
  });

  it("groupBy=month + window clamps", async () => {
    const { ledger, holdings } = makeLedgerSet();
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/pnl?groupBy=month&from=2026-05-01&to=2026-05-31")
      .set("x-session-id", "s");
    expect(r.body.groups.map((g: any) => g.key)).toEqual(["2026-05"]);
    expect(r.body.window.from).toBe("2026-05-01");
    expect(r.body.window.to).toBe("2026-05-31");
  });
});

// ─── /tax-export ────────────────────────────────────────────────────────────

describe("GET /api/portfolio/erp/tax-export", () => {
  beforeEach(() => setUser(makeUser("pro_seller")));

  it("CSV: row 0 is the header (NO banner); X-Unreconciled-Excluded header set", async () => {
    const { ledger, holdings } = makeLedgerSet();
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/tax-export")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.headers["x-unreconciled-excluded"]).toBe("1");
    expect(r.headers["content-disposition"]).toMatch(/attachment; filename=/);
    const lines = r.text.split("\n");
    // Header row is row 0 — no banner, no "# TAX EXPORT" preamble.
    expect(lines[0].split(",")).toContain("sale_date");
    expect(lines[0].split(",")).toContain("date_acquired");
    expect(lines[0].startsWith("#")).toBe(false);
    // Body: 1 reconciled row (L1); L2 excluded.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("2026-05-10");
    expect(lines[1]).toContain("2025-09-15"); // date_acquired
  });

  it("JSON sibling surfaces excluded counter + columns + rows", async () => {
    const { ledger, holdings } = makeLedgerSet();
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/tax-export?format=json")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.headers["x-unreconciled-excluded"]).toBe("1");
    expect(r.body.rows.length).toBe(1);
    expect(r.body.rows[0].date_acquired).toBe("2025-09-15");
    expect(r.body.excluded.count).toBe(1);
    expect(r.body.columns[0]).toBe("sale_date");
    expect(r.body.columns[1]).toBe("date_acquired");
  });

  it("dismissed-but-flagged stays excluded from CSV", async () => {
    const { ledger, holdings } = makeLedgerSet();
    ledger[1].dismissedAt = "2026-06-02T00:00:00Z";
    readUserDocMock.mockResolvedValueOnce({
      id: "u", userId: "u", holdings, ledger,
      priceHistoryByHolding: {}, alerts: [], recommendationFeedback: [],
    } as any);
    const r = await request(app)
      .get("/api/portfolio/erp/tax-export?format=json")
      .set("x-session-id", "s");
    expect(r.body.rows.length).toBe(1);
    expect(r.body.excluded.count).toBe(1);
    expect(r.headers["x-unreconciled-excluded"]).toBe("1");
  });

  it("empty ledger: header-only CSV + zero excluded", async () => {
    const r = await request(app)
      .get("/api/portfolio/erp/tax-export")
      .set("x-session-id", "s");
    expect(r.status).toBe(200);
    expect(r.headers["x-unreconciled-excluded"]).toBe("0");
    expect(r.text.split("\n").length).toBe(1);
  });
});
