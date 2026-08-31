// D34 (2026-08-31) — job-level coverage for the two behaviours that kept
// Drew's Griffey stuck and the Ohtani breakdown empty:
//   1. A fresh (<2d) order is FETCHED, not silently skipped.
//   2. MODE=refill-fee-lines re-processes already-reconciled rows so a
//      stored sale gains the breakdown, idempotently, without restating
//      a payout that has already closed a row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

const listConnectedUserIdsMock = vi.fn(async () => ["u-1"]);
vi.mock("../src/services/ebay/ebayTokenStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, listConnectedUserIds: () => listConnectedUserIdsMock() };
});

const getTransactionsForOrderMock = vi.fn(async (_u: string, _o: string) => null as any);
vi.mock("../src/services/ebay/ebayFinances.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    getTransactionsForOrder: (...a: unknown[]) =>
      getTransactionsForOrderMock(...(a as [string, string])),
  };
});

const userDocs = new Map<string, any>();
const readUserDocMock = vi.fn(async (userId: string) => {
  const doc = userDocs.get(userId);
  return doc ? JSON.parse(JSON.stringify(doc)) : { ledger: [], holdings: {} };
});
const writeUserDocMock = vi.fn(async (userId: string, doc: any) => {
  userDocs.set(userId, JSON.parse(JSON.stringify(doc)));
});
vi.mock("../src/services/portfolioiq/portfolioStore.service.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    readUserDoc: (...a: unknown[]) => readUserDocMock(...(a as [string])),
    writeUserDoc: (...a: unknown[]) => writeUserDocMock(...(a as [string, any])),
  };
});

import { runFinancesEnrichmentSweep, resolveMode } from "../src/jobs/ebayFinancesEnrichment.job";

const NOW = new Date("2026-08-31T22:00:00.000Z");

/** A SALE carrying its fees where eBay really puts them. */
function saleTxns(gross: string, totalFee: string, fees: Array<[string, string]>) {
  return [
    {
      transactionId: "T1",
      orderId: "O",
      transactionType: "SALE",
      transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
      transactionDate: "2026-08-30T02:00:00.000Z",
      amount: { value: gross, currency: "USD" },
      totalFeeAmount: { value: totalFee, currency: "USD" },
      orderLineItems: [
        {
          marketplaceFees: fees.map(([feeType, value]) => ({
            feeType,
            amount: { value, currency: "USD" },
          })),
        },
      ],
    },
  ];
}

beforeEach(() => {
  userDocs.clear();
  vi.clearAllMocks();
  delete process.env.MODE;
  process.env.EBAY_FINANCES_ENRICHMENT_SHADOW = "false";
});
afterEach(() => {
  delete process.env.EBAY_FINANCES_ENRICHMENT_SHADOW;
  delete process.env.MODE;
});

describe("D34 — the Griffey case: a fresh order is fetched", () => {
  // Sold 2026-08-30T01:42:30Z, swept 2026-08-31T22:00Z => ~1.85 days old,
  // under the 2-day floor that skipped it every time.
  const griffey = {
    id: "griffey",
    source: "ebay",
    ebayOrderId: "11-15096-50302",
    playerName: "Ken Griffey Jr. Mariners",
    soldAt: "2026-08-30T01:42:30.000Z",
    needsReconciliation: true,
    userCostsProvidedAt: "2026-08-31T21:45:26.010Z",
    grossProceeds: 250,
    costBasisSold: 150,
    finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
    adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
  };

  it("fetches the order instead of counting it skippedFresh and moving on", async () => {
    userDocs.set("u-1", { ledger: [{ ...griffey }] });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("250.00", "33.43", [
        ["FINAL_VALUE_FEE", "33.13"],
        ["FINAL_VALUE_FEE_FIXED_PER_ORDER", "0.30"],
      ]),
    );

    const s = await runFinancesEnrichmentSweep({ now: NOW });

    expect(getTransactionsForOrderMock).toHaveBeenCalledWith("u-1", "11-15096-50302");
    expect(s.candidatesEvaluated).toBe(1);
    expect(s.freshFetched).toBe(1);
    expect(s.enriched).toBe(1);
  });

  it("finalizes the row: fees written, needsReconciliation cleared", async () => {
    userDocs.set("u-1", { ledger: [{ ...griffey }] });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("250.00", "33.43", [
        ["FINAL_VALUE_FEE", "33.13"],
        ["FINAL_VALUE_FEE_FIXED_PER_ORDER", "0.30"],
      ]),
    );

    await runFinancesEnrichmentSweep({ now: NOW });

    const e = userDocs.get("u-1").ledger[0];
    expect(e.finalValueFee).toBe(33.43);
    expect(e.netPayout).toBe(216.57);
    expect(e.needsReconciliation).toBe(false);
    expect(e.reconciledVia).toBe("ebay_finances");
  });

  it("when eBay has not posted the fees yet, it lands in noFinancesData and stays open", async () => {
    userDocs.set("u-1", { ledger: [{ ...griffey }] });
    getTransactionsForOrderMock.mockResolvedValue([]);

    const s = await runFinancesEnrichmentSweep({ now: NOW });

    expect(s.noFinancesData).toBe(1);
    expect(s.enriched).toBe(0);
    expect(userDocs.get("u-1").ledger[0].needsReconciliation).toBe(true);
  });

  it("still refuses orders past the 90-day Finances window", async () => {
    userDocs.set("u-1", {
      ledger: [{ ...griffey, id: "old", soldAt: "2026-01-01T00:00:00.000Z" }],
    });
    const s = await runFinancesEnrichmentSweep({ now: NOW });
    expect(s.skippedOverWindow).toBe(1);
    expect(getTransactionsForOrderMock).not.toHaveBeenCalled();
  });
});

describe("D34 — MODE=refill-fee-lines", () => {
  // The Ohtani end-state before D34: closed, payout known, breakdown null.
  const ohtani = {
    id: "ohtani",
    source: "ebay",
    ebayOrderId: "17-15031-43259",
    playerName: "Shohei Ohtani",
    soldAt: "2026-08-17T15:50:42.000Z",
    needsReconciliation: false,
    reconciledVia: "ebay_finances",
    feeSource: "ebay_finances",
    userCostsProvidedAt: "2026-08-30T12:37:07.637Z",
    grossProceeds: 2999.99,
    costBasisSold: 2350,
    netProceeds: 2396.85,
    realizedProfitLoss: 46.85,
    finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
    adFee: null, otherFees: null,
    netPayout: 2396.85,
    actualShippingCost: 5.97,
  };
  const ohtaniTxns = saleTxns("2999.99", "603.14", [
    ["FINAL_VALUE_FEE", "397.50"],
    ["FINAL_VALUE_FEE_FIXED_PER_ORDER", "0.30"],
    ["FINAL_VALUE_FEE_AD_FEE", "205.34"],
  ]);

  it("default mode does NOT touch a reconciled row", async () => {
    userDocs.set("u-1", { ledger: [{ ...ohtani }] });
    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "enrich" });
    expect(s.candidatesEvaluated).toBe(0);
    expect(getTransactionsForOrderMock).not.toHaveBeenCalled();
  });

  it("fills the breakdown on the already-reconciled row", async () => {
    userDocs.set("u-1", { ledger: [{ ...ohtani }] });
    getTransactionsForOrderMock.mockResolvedValue(ohtaniTxns);

    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    expect(s.candidatesEvaluated).toBe(1);
    expect(s.enriched).toBe(1);
    const e = userDocs.get("u-1").ledger[0];
    expect(e.finalValueFee).toBe(397.8);
    expect(e.promotedListingFee).toBe(205.34);
    // The $603.14 is now itemized.
    const sum = e.finalValueFee + e.paymentProcessingFee + e.promotedListingFee + e.adFee + e.otherFees;
    expect(Number(sum.toFixed(2))).toBe(603.14);
  });

  it("leaves the closed row's payout and P&L alone when they agree", async () => {
    userDocs.set("u-1", { ledger: [{ ...ohtani }] });
    getTransactionsForOrderMock.mockResolvedValue(ohtaniTxns);

    await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    const e = userDocs.get("u-1").ledger[0];
    expect(e.netPayout).toBe(2396.85);
    expect(e.needsReconciliation).toBe(false);
    expect(e.reconciledVia).toBe("ebay_finances");
  });

  it("a disagreeing payout is REPORTED and the stored value kept", async () => {
    userDocs.set("u-1", { ledger: [{ ...ohtani }] });
    // eBay now says the seller netted 2000.00, not the stored 2396.85.
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("2999.99", "999.99", [["FINAL_VALUE_FEE", "999.99"]]),
    );

    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    expect(s.payoutDisagreements).toBe(1);
    // Kept: a closed row's P&L is not silently restated by a refill.
    expect(userDocs.get("u-1").ledger[0].netPayout).toBe(2396.85);
  });

  it("is idempotent: a row with every fee line present is no longer a candidate", async () => {
    userDocs.set("u-1", { ledger: [{ ...ohtani }] });
    getTransactionsForOrderMock.mockResolvedValue(ohtaniTxns);

    const first = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });
    expect(first.enriched).toBe(1);

    getTransactionsForOrderMock.mockClear();
    const second = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });
    expect(second.candidatesEvaluated).toBe(0);
    expect(second.enriched).toBe(0);
    expect(getTransactionsForOrderMock).not.toHaveBeenCalled();
  });

  it("skips a row that has no payout yet — that is the other mode's job", async () => {
    userDocs.set("u-1", {
      ledger: [{ ...ohtani, netPayout: null, needsReconciliation: true }],
    });
    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });
    expect(s.candidatesEvaluated).toBe(0);
  });
});

describe("D34 — mode resolution", () => {
  it("defaults to enrich and only the exact string selects refill", () => {
    expect(resolveMode(undefined)).toBe("enrich");
    expect(resolveMode("")).toBe("enrich");
    expect(resolveMode("refill-fee-lines")).toBe("refill-fee-lines");
    expect(resolveMode("REFILL-FEE-LINES")).toBe("refill-fee-lines");
    expect(resolveMode("refill")).toBe("enrich");
  });

  it("reports unknown fee types up to the run summary", async () => {
    userDocs.set("u-1", {
      ledger: [{
        id: "x", source: "ebay", ebayOrderId: "O", soldAt: "2026-08-20T00:00:00.000Z",
        needsReconciliation: true, userCostsProvidedAt: "2026-08-21T00:00:00.000Z",
        grossProceeds: 100, costBasisSold: 50,
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
      }],
    });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("100.00", "14.25", [
        ["FINAL_VALUE_FEE", "10.00"],
        ["SOME_NEW_EBAY_FEE_2027", "4.25"],
      ]),
    );

    const s = await runFinancesEnrichmentSweep({ now: NOW });
    expect(s.unknownFeeTypes).toEqual(["SOME_NEW_EBAY_FEE_2027"]);
  });
});
