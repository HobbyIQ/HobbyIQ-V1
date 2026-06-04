// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): scheduled job coverage.
//
// Pins:
//   1. Candidate filter (source=ebay + needsReconciliation + soldAt window).
//   2. Per-run cap.
//   3. SHADOW mode default ON: logs the enrichment proposal but DOES NOT
//      mutate the user doc (assert ledger doc is byte-unchanged).
//   4. Active mode (shadow=false): persists the enrichment + recomputes
//      financials via the netPayout-authoritative formula.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const listConnectedUserIdsMock = vi.fn(async () => ["u-1"]);
vi.mock("../src/services/ebay/ebayTokenStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    listConnectedUserIds: () => listConnectedUserIdsMock(),
  };
});

const getTransactionsForOrderMock = vi.fn(async (_userId: string, _orderId: string) => null as any);
vi.mock("../src/services/ebay/ebayFinances.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getTransactionsForOrder: (...args: unknown[]) =>
      getTransactionsForOrderMock(...(args as [string, string])),
  };
});

// In-memory user doc store. Captures both reads and writes so the test
// can assert byte-equality in shadow mode.
const userDocs = new Map<string, any>();
const readUserDocMock = vi.fn(async (userId: string) => {
  const doc = userDocs.get(userId);
  // Return a deep clone so callers can mutate without affecting the store.
  return doc ? JSON.parse(JSON.stringify(doc)) : { ledger: [], holdings: {} };
});
const writeUserDocMock = vi.fn(async (userId: string, doc: any) => {
  userDocs.set(userId, JSON.parse(JSON.stringify(doc)));
});
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: (...args: unknown[]) => readUserDocMock(...(args as [string])),
    writeUserDoc: (...args: unknown[]) =>
      writeUserDocMock(...(args as [string, any])),
  };
});

// ─── Import under test (after mocks) ────────────────────────────────────────

import { runFinancesEnrichmentSweep } from "../src/jobs/ebayFinancesEnrichment.job";

// ─── Test helpers ───────────────────────────────────────────────────────────

const NOW = new Date("2026-06-04T00:00:00Z");
const NOW_MS = NOW.getTime();
const D = 24 * 60 * 60 * 1000;

function ebayEntry(opts: {
  id: string;
  ageDays: number;
  needsRec?: boolean;
  source?: "ebay" | "manual";
  orderId?: string;
  gross?: number;
  costBasis?: number;
}): any {
  return {
    id: opts.id,
    userId: "u-1",
    holdingId: "h-1",
    playerName: "p", cardTitle: "c",
    quantitySold: 1, unitSalePrice: opts.gross ?? 250,
    grossProceeds: opts.gross ?? 250,
    fees: 0, tax: 0, shipping: 0,
    netProceeds: opts.gross ?? 250,
    costBasisSold: opts.costBasis ?? 80,
    realizedProfitLoss: (opts.gross ?? 250) - (opts.costBasis ?? 80),
    realizedProfitLossPct: 100,
    soldAt: new Date(NOW_MS - opts.ageDays * D).toISOString(),
    source: opts.source ?? "ebay",
    ebayOrderId: opts.orderId ?? "ORD-" + opts.id,
    finalValueFee: null,
    paymentProcessingFee: null,
    promotedListingFee: null,
    adFee: null,
    otherFees: null,
    netPayout: null,
    actualShippingCost: null,
    suppliesCost: null,
    gradingCost: null,
    needsReconciliation: opts.needsRec ?? true,
  };
}

function financesPayloadForOrder(): any[] {
  return [
    {
      transactionId: "T1",
      orderId: "any",
      amount: { value: "210", currency: "USD" },
      fees: [
        { feeType: "FINAL_VALUE_FEE", amount: { value: "32", currency: "USD" } },
        { feeType: "PAYMENT_PROCESSING_FEE", amount: { value: "8", currency: "USD" } },
      ],
      transactionType: "SALE",
      transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
      transactionDate: "2026-05-12T00:00:00Z",
    },
    {
      transactionId: "T2",
      orderId: "any",
      amount: { value: "-5", currency: "USD" },
      fees: [],
      transactionType: "SHIPPING_LABEL",
      transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
      transactionDate: "2026-05-12T00:00:00Z",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  userDocs.clear();
  delete process.env.EBAY_FINANCES_ENRICHMENT_SHADOW;
  delete process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN;
});
afterEach(() => {
  delete process.env.EBAY_FINANCES_ENRICHMENT_SHADOW;
  delete process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ebayFinancesEnrichment.job — candidate filter", () => {
  it("targets only source=ebay + needsReconciliation=true + soldAt in (now-90d, now-2d)", async () => {
    userDocs.set("u-1", {
      ledger: [
        ebayEntry({ id: "e-good",      ageDays: 30 }), // candidate
        ebayEntry({ id: "e-too-fresh", ageDays: 1 }),  // skip-fresh
        ebayEntry({ id: "e-too-old",   ageDays: 95 }), // skip-over
        ebayEntry({ id: "e-already-reconciled", ageDays: 30, needsRec: false }), // not candidate
        ebayEntry({ id: "e-manual",    ageDays: 30, source: "manual" }), // not candidate
      ],
      holdings: {},
    });
    getTransactionsForOrderMock.mockResolvedValue(financesPayloadForOrder());

    const summary = await runFinancesEnrichmentSweep({ now: NOW });

    expect(summary.candidatesEvaluated).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(summary.skippedFresh).toBe(1);
    expect(summary.skippedOverWindow).toBe(1);
    expect(summary.shadow).toBe(true); // default
  });

  it("respects the per-run cap", async () => {
    const ledger = Array.from({ length: 5 }, (_, i) =>
      ebayEntry({ id: "e-" + i, ageDays: 10 + i, orderId: "O-" + i }),
    );
    userDocs.set("u-1", { ledger, holdings: {} });
    getTransactionsForOrderMock.mockResolvedValue(financesPayloadForOrder());

    process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN = "2";
    const summary = await runFinancesEnrichmentSweep({ now: NOW });

    expect(summary.candidatesEvaluated).toBe(2);
    expect(getTransactionsForOrderMock).toHaveBeenCalledTimes(2);
  });

  it("noFinancesData counter increments when getTransactionsForOrder returns null", async () => {
    userDocs.set("u-1", { ledger: [ebayEntry({ id: "e-1", ageDays: 30 })], holdings: {} });
    getTransactionsForOrderMock.mockResolvedValueOnce(null);

    const summary = await runFinancesEnrichmentSweep({ now: NOW });

    expect(summary.noFinancesData).toBe(1);
    expect(summary.enriched).toBe(0);
  });
});

describe("ebayFinancesEnrichment.job — SHADOW mode (default ON)", () => {
  it("logs the proposal but does NOT mutate the user doc", async () => {
    // EBAY_FINANCES_ENRICHMENT_SHADOW unset → defaults to true.
    userDocs.set("u-1", {
      ledger: [ebayEntry({ id: "e-1", ageDays: 30 })],
      holdings: {},
    });
    const docBefore = JSON.parse(JSON.stringify(userDocs.get("u-1")));
    getTransactionsForOrderMock.mockResolvedValue(financesPayloadForOrder());

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await runFinancesEnrichmentSweep({ now: NOW });
    logSpy.mockRestore();

    expect(summary.shadow).toBe(true);
    expect(summary.enriched).toBe(1); // counted as "would-have-enriched"
    expect(writeUserDocMock).not.toHaveBeenCalled();
    // Byte-equal check: the in-memory store is untouched.
    expect(userDocs.get("u-1")).toEqual(docBefore);
  });

  it("emits a structured shadow_enrichment log line carrying the proposal", async () => {
    userDocs.set("u-1", {
      ledger: [ebayEntry({ id: "e-1", ageDays: 30 })],
      holdings: {},
    });
    getTransactionsForOrderMock.mockResolvedValue(financesPayloadForOrder());

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runFinancesEnrichmentSweep({ now: NOW });
    const lines = logSpy.mock.calls.map((c) => String(c[0] ?? ""));
    logSpy.mockRestore();

    const shadowLine = lines.find((l) =>
      l.includes("[ebay][ebay.finances.enrichment.job] shadow_enrichment"),
    );
    expect(shadowLine).toBeDefined();
    expect(shadowLine).toContain('"finalValueFee":32');
    expect(shadowLine).toContain('"netPayout":210');
    expect(shadowLine).toContain('"actualShippingCost":5');
    // wouldBeNetProceeds = 210 - 0 (grading) - 0 (supplies) = 210
    expect(shadowLine).toContain('"wouldBeNetProceeds":210');
  });

  it("heartbeat line carries shadow=true marker", async () => {
    userDocs.set("u-1", { ledger: [], holdings: {} });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runFinancesEnrichmentSweep({ now: NOW });
    const lines = logSpy.mock.calls.map((c) => String(c[0] ?? ""));
    logSpy.mockRestore();

    const hb = lines.find((l) =>
      l.includes("[ebay.finances.enrichment.job] done"),
    );
    expect(hb).toBeDefined();
    expect(hb).toContain("shadow=true");
  });
});

describe("ebayFinancesEnrichment.job — ACTIVE mode (shadow=false)", () => {
  it("persists the enrichment + reconciledVia='ebay_finances' + recomputes netProceeds via netPayout-authoritative formula", async () => {
    process.env.EBAY_FINANCES_ENRICHMENT_SHADOW = "false";

    userDocs.set("u-1", {
      ledger: [
        ebayEntry({ id: "e-1", ageDays: 30, gross: 250, costBasis: 80 }),
      ],
      holdings: {},
    });
    getTransactionsForOrderMock.mockResolvedValue(financesPayloadForOrder());

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = await runFinancesEnrichmentSweep({ now: NOW });
    logSpy.mockRestore();

    expect(summary.shadow).toBe(false);
    expect(summary.enriched).toBe(1);
    expect(writeUserDocMock).toHaveBeenCalledTimes(1);

    const persisted = userDocs.get("u-1");
    const entry = persisted.ledger[0];
    expect(entry.needsReconciliation).toBe(false);
    expect(entry.reconciledVia).toBe("ebay_finances");
    expect(entry.finalValueFee).toBe(32);
    expect(entry.netPayout).toBe(210);
    expect(entry.actualShippingCost).toBe(5);
    // Authoritative branch: 210 - 0 - 0 = 210
    expect(entry.netProceeds).toBe(210);
    // realizedPL = 210 - 80 = 130
    expect(entry.realizedProfitLoss).toBe(130);
    // Audit row appended:
    expect(entry.feeAdjustments).toHaveLength(1);
    expect(entry.feeAdjustments[0].adjustedBy).toBe("system:ebay_finances");
  });
});
