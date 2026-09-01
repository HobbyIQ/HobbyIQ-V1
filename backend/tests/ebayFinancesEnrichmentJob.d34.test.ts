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
import { missingFeeFields } from "../src/services/portfolioiq/erpReconciliation.service";

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

// ─── D34 R2 job-level adversarials ────────────────────────────────────────

describe("D34 R2 — no fabricated shipping ever reaches the ledger", () => {
  const openRow = (over: Record<string, unknown> = {}) => ({
    id: "x",
    source: "ebay",
    ebayOrderId: "O",
    soldAt: "2026-08-20T00:00:00.000Z",
    needsReconciliation: true,
    userCostsProvidedAt: "2026-08-21T00:00:00.000Z",
    grossProceeds: 100,
    costBasisSold: 50,
    finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
    adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
    ...over,
  });

  it("a SALE with no label yet leaves actualShippingCost NULL", async () => {
    // ADV-E1. R1 wrote 0 here — an invented measurement, on an order where
    // eBay simply had not posted the label yet.
    userDocs.set("u-1", { ledger: [openRow()] });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
    );

    await runFinancesEnrichmentSweep({ now: NOW });

    const e = userDocs.get("u-1").ledger[0];
    expect(e.actualShippingCost).toBeNull();
    expect(e.finalValueFee).toBe(13.25);
    // Absent lines stay absent — no zeros invented alongside.
    expect(e.paymentProcessingFee).toBeNull();
    expect(e.adFee).toBeNull();
  });

  it("...and the row STILL closes, on the fact rather than on a fabricated 0", async () => {
    // ADV-F1's honest counterpart: R1 needed the invented 0 to close this
    // row. It closes on shippingAbsentFromEbay instead, and the ledger
    // carries no number eBay never sent.
    userDocs.set("u-1", { ledger: [openRow()] });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
    );

    await runFinancesEnrichmentSweep({ now: NOW });

    const e = userDocs.get("u-1").ledger[0];
    expect(e.needsReconciliation).toBe(false);
    expect(e.reconciledVia).toBe("ebay_finances");
    expect(e.shippingAbsentFromEbay).toBe(true);
    expect(e.feeFetchedAt).toBe(NOW.toISOString());
    expect(e.actualShippingCost).toBeNull();
  });

  it("a refill NEVER writes 0 over a null shipping", async () => {
    // ADV-I1, verbatim: stored shipping null, SALE-only payload in.
    userDocs.set("u-1", {
      ledger: [openRow({
        needsReconciliation: false,
        netPayout: 86.75,
        actualShippingCost: null,
        feeFetchedAt: null,
      })],
    });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
    );

    await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    expect(userDocs.get("u-1").ledger[0].actualShippingCost).toBeNull();
  });

  it("a refill never BLANKS a shipping value the row already knows", async () => {
    // The mirror hazard the honest-null contract creates: the mapper
    // truthfully returns null for a payload with no SHIPPING_LABEL, and
    // writing that over a stored 5.97 would destroy a real measurement.
    userDocs.set("u-1", {
      ledger: [openRow({
        needsReconciliation: false,
        netPayout: 86.75,
        actualShippingCost: 5.97,
        feeFetchedAt: null,
      })],
    });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
    );

    await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    const e = userDocs.get("u-1").ledger[0];
    expect(e.actualShippingCost).toBe(5.97);
    // ...and it does not then claim eBay has no label for this order.
    expect(e.shippingAbsentFromEbay).toBe(false);
  });

  it("a label posted LATER is still picked up by a refill", async () => {
    // The row closed with shipping unknown and no absent-fact established;
    // it therefore remains a candidate and the late label lands.
    userDocs.set("u-1", {
      ledger: [openRow({
        needsReconciliation: false,
        netPayout: 86.75,
        finalValueFee: 13.25,
        actualShippingCost: null,
        feeFetchedAt: "2026-08-21T00:00:00.000Z",
        shippingAbsentFromEbay: false,
      })],
    });
    getTransactionsForOrderMock.mockResolvedValue([
      ...saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
      {
        transactionId: "SL1",
        orderId: "O",
        transactionType: "SHIPPING_LABEL",
        transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
        transactionDate: "2026-08-22T00:00:00.000Z",
        amount: { value: "-4.50", currency: "USD" },
      },
    ]);

    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    expect(s.candidatesEvaluated).toBe(1);
    expect(userDocs.get("u-1").ledger[0].actualShippingCost).toBe(4.5);
  });

  it("a row whose fetch settled shipping-absent is NOT re-fetched forever", async () => {
    userDocs.set("u-1", {
      ledger: [openRow({
        needsReconciliation: false,
        netPayout: 86.75,
        finalValueFee: 13.25,
        actualShippingCost: null,
        feeFetchedAt: "2026-08-21T00:00:00.000Z",
        shippingAbsentFromEbay: true,
      })],
    });

    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });

    expect(s.candidatesEvaluated).toBe(0);
    expect(getTransactionsForOrderMock).not.toHaveBeenCalled();
  });
});

describe("D34 R2 — the job writes the per-line-item payout, not the global one", () => {
  it("a mixed-basis multi-SALE order lands 173.50 in the ledger", async () => {
    userDocs.set("u-1", {
      ledger: [{
        id: "multi", source: "ebay", ebayOrderId: "O-MULTI",
        soldAt: "2026-08-20T00:00:00.000Z",
        needsReconciliation: true,
        userCostsProvidedAt: "2026-08-21T00:00:00.000Z",
        grossProceeds: 200, costBasisSold: 100,
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
      }],
    });
    getTransactionsForOrderMock.mockResolvedValue([
      {
        transactionId: "S1", orderId: "O-MULTI", transactionType: "SALE",
        transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
        transactionDate: "2026-08-20T00:00:00.000Z",
        amount: { value: "100.00", currency: "USD" },
        totalFeeAmount: { value: "13.25", currency: "USD" },
        orderLineItems: [{ marketplaceFees: [{ feeType: "FINAL_VALUE_FEE", amount: { value: "13.25", currency: "USD" } }] }],
      },
      {
        transactionId: "S2", orderId: "O-MULTI", transactionType: "SALE",
        transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
        transactionDate: "2026-08-20T00:00:00.000Z",
        amount: { value: "86.75", currency: "USD" },
        orderLineItems: [{ marketplaceFees: [{ feeType: "FINAL_VALUE_FEE", amount: { value: "13.25", currency: "USD" } }] }],
      },
    ]);

    await runFinancesEnrichmentSweep({ now: NOW });

    const e = userDocs.get("u-1").ledger[0];
    // NOT 186.75 — that was one line item's fees taken off two line items'
    // gross, reported under a clean-sounding basis.
    expect(e.netPayout).toBe(173.5);
    expect(e.finalValueFee).toBe(26.5);
  });

  it("a REFUND lands as a reduced payout, not a full one", async () => {
    userDocs.set("u-1", {
      ledger: [{
        id: "refunded", source: "ebay", ebayOrderId: "O-REF",
        soldAt: "2026-08-20T00:00:00.000Z",
        needsReconciliation: true,
        userCostsProvidedAt: "2026-08-21T00:00:00.000Z",
        grossProceeds: 100, costBasisSold: 50,
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
      }],
    });
    getTransactionsForOrderMock.mockResolvedValue([
      ...saleTxns("100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
      {
        transactionId: "R1", orderId: "O-REF", transactionType: "REFUND",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-23T00:00:00.000Z",
        amount: { value: "-100.00", currency: "USD" },
        fees: [{ feeType: "FINAL_VALUE_FEE", amount: { value: "-13.25", currency: "USD" } }],
      },
    ]);

    await runFinancesEnrichmentSweep({ now: NOW });

    const e = userDocs.get("u-1").ledger[0];
    // R1 reported the seller was paid 86.75 on a fully refunded order.
    expect(e.netPayout).toBe(-13.25);
    expect(e.finalValueFee).toBe(0);
  });
});

describe("D34 R2 — the Ohtani row gains its five lines and stops reporting them", () => {
  it("refill fills the breakdown, sets the fetch marker, and keeps the P&L", async () => {
    userDocs.set("u-1", {
      ledger: [{
        id: "ohtani", source: "ebay", ebayOrderId: "17-15031-43259",
        soldAt: "2026-08-17T15:50:42.000Z",
        needsReconciliation: false,
        reconciledVia: "ebay_finances", feeSource: "ebay_finances",
        userCostsProvidedAt: "2026-08-30T12:37:07.637Z",
        grossProceeds: 2999.99, costBasisSold: 2350,
        netProceeds: 2396.85, realizedProfitLoss: 46.85,
        finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
        adFee: null, otherFees: null,
        netPayout: 2396.85, actualShippingCost: 5.97,
        feeFetchedAt: null,
      }],
    });
    getTransactionsForOrderMock.mockResolvedValue(
      saleTxns("2999.99", "603.14", [
        ["FINAL_VALUE_FEE", "397.50"],
        ["FINAL_VALUE_FEE_FIXED_PER_ORDER", "0.30"],
        ["FINAL_VALUE_FEE_AD_FEE", "205.34"],
      ]),
    );

    const s = await runFinancesEnrichmentSweep({ now: NOW, mode: "refill-fee-lines" });
    expect(s.candidatesEvaluated).toBe(1);

    const e = userDocs.get("u-1").ledger[0];
    expect(e.finalValueFee).toBe(397.8);
    expect(e.promotedListingFee).toBe(205.34);
    // The measured $603.14 is now itemized. Nulls contribute nothing —
    // they are absent lines, not zero-dollar ones.
    const sum = (e.finalValueFee ?? 0) + (e.paymentProcessingFee ?? 0)
      + (e.promotedListingFee ?? 0) + (e.adFee ?? 0) + (e.otherFees ?? 0);
    expect(Number(sum.toFixed(2))).toBe(603.14);
    // The closed row's P&L is not restated, and its shipping is preserved.
    expect(e.netPayout).toBe(2396.85);
    expect(e.actualShippingCost).toBe(5.97);
    expect(e.feeFetchedAt).toBe(NOW.toISOString());
    // ...and it no longer reports the five lines as outstanding.
    expect(missingFeeFields({ ...e, needsReconciliation: true })).toEqual([]);
  });
});
