// D34 (2026-08-31) — the seven fee lines, pinned against the REAL order
// shape and the REAL prod numbers.
//
// The pre-existing mapper suite (ebayFinances.mapper.test.ts) was green
// while the feature was broken, because every one of its fixtures put fees
// in a top-level `fees[]` that eBay does not send on a SALE. These tests
// use eBay's documented shape — orderLineItems[].marketplaceFees[] — and
// anchor to the measured Ohtani totals.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapFinancesToFees,
  mapFinancesToFeesWithDiagnostics,
  type FinancesTransaction,
} from "../src/services/ebay/ebayFinances.service";
import { missingFeeFields } from "../src/services/portfolioiq/erpReconciliation.service";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service";

const FIXTURES = join(__dirname, "fixtures", "ebay-finances");
const readFixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

// ─── The regression that started D34 ──────────────────────────────────────

describe("D34 — fees live on orderLineItems[].marketplaceFees[]", () => {
  it("maps a SALE whose fees are ONLY on line items (the shape that returned five nulls)", () => {
    const sale: FinancesTransaction = {
      transactionId: "T1",
      orderId: "17-15031-43259",
      transactionType: "SALE",
      transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
      transactionDate: "2026-08-17T15:52:10.000Z",
      amount: { value: "2999.99", currency: "USD" },
      totalFeeAmount: { value: "603.14", currency: "USD" },
      orderLineItems: [
        {
          lineItemId: "LI1",
          marketplaceFees: [
            { feeType: "FINAL_VALUE_FEE", amount: { value: "397.50", currency: "USD" } },
            { feeType: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount: { value: "0.30", currency: "USD" } },
            { feeType: "FINAL_VALUE_FEE_AD_FEE", amount: { value: "205.34", currency: "USD" } },
          ],
        },
      ],
    };
    const r = mapFinancesToFees([sale]);
    // Before D34 every one of these was null.
    expect(r.finalValueFee).toBe(397.8);
    expect(r.promotedListingFee).toBe(205.34);
    expect(r.paymentProcessingFee).toBe(0);
    expect(r.adFee).toBe(0);
    expect(r.otherFees).toBe(0);
  });

  it("the SALE amount is GROSS: netPayout = amount - totalFeeAmount", () => {
    const r = mapFinancesToFees([
      {
        transactionId: "T1",
        orderId: "O",
        transactionType: "SALE",
        transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
        transactionDate: "2026-08-17T00:00:00Z",
        amount: { value: "2999.99", currency: "USD" },
        totalFeeAmount: { value: "603.14", currency: "USD" },
        orderLineItems: [
          { marketplaceFees: [{ feeType: "FINAL_VALUE_FEE", amount: { value: "603.14", currency: "USD" } }] },
        ],
      },
    ]);
    // Exactly the payout already stored in prod for this order.
    expect(r.netPayout).toBe(2396.85);
  });

  it("without totalFeeAmount, amount is taken as already-net (legacy behaviour, flagged)", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      {
        transactionId: "T1",
        orderId: "O",
        transactionType: "SALE",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-17T00:00:00Z",
        amount: { value: "100.00", currency: "USD" },
      },
    ]);
    expect(feeMap.netPayout).toBe(100);
    expect(diagnostics.netPayoutBasis).toBe("amount_as_net");
  });
});

// ─── The Ohtani fixture: the invariant that survives a real capture ───────

describe("D34 — Ohtani 17-15031-43259 reconstructed payload", () => {
  const fx = readFixture("ohtani-17-15031-43259.reconstructed.json");
  const observed = readFixture("ohtani-17-15031-43259.observed.json");

  it("fee total reconciles to the $603.14 eBay actually withheld", () => {
    const r = mapFinancesToFees(fx.transactions);
    const feeSum =
      (r.finalValueFee ?? 0) +
      (r.paymentProcessingFee ?? 0) +
      (r.promotedListingFee ?? 0) +
      (r.adFee ?? 0) +
      (r.otherFees ?? 0);
    // gross - netPayout, from the prod ledger. Holds for ANY correct split,
    // so replacing the reconstruction with the real payload keeps this green.
    expect(Number(feeSum.toFixed(2))).toBe(603.14);
    expect(Number(feeSum.toFixed(2))).toBe(
      Number((observed.storedLedgerFields.grossProceeds - observed.storedLedgerFields.netPayout).toFixed(2)),
    );
  });

  it("netPayout and shipping match what is already stored in prod", () => {
    const r = mapFinancesToFees(fx.transactions);
    expect(r.netPayout).toBe(observed.storedLedgerFields.netPayout);
    expect(r.actualShippingCost).toBe(observed.storedLedgerFields.actualShippingCost);
  });

  it("every one of the seven fields is populated — none left null", () => {
    const r = mapFinancesToFees(fx.transactions);
    for (const [k, v] of Object.entries(r)) {
      expect(v, `${k} should not be null`).not.toBeNull();
    }
  });

  it("matches the fixture's declared expectedFeeMap", () => {
    expect(mapFinancesToFees(fx.transactions)).toEqual(fx.expectedFeeMap);
  });
});

// ─── Fee taxonomy honesty ────────────────────────────────────────────────

describe("D34 — fee taxonomy: nothing dropped, nothing invented", () => {
  const saleWith = (fees: Array<[string, string]>): FinancesTransaction => ({
    transactionId: "T",
    orderId: "O",
    transactionType: "SALE",
    transactionStatus: "COMPLETED",
    transactionDate: "2026-08-17T00:00:00Z",
    amount: { value: "100.00", currency: "USD" },
    orderLineItems: [
      {
        marketplaceFees: fees.map(([feeType, value]) => ({
          feeType,
          amount: { value, currency: "USD" },
        })),
      },
    ],
  });

  it("FINAL_VALUE_FEE_FIXED_PER_ORDER joins finalValueFee, not otherFees", () => {
    const r = mapFinancesToFees([
      saleWith([["FINAL_VALUE_FEE", "10.00"], ["FINAL_VALUE_FEE_FIXED_PER_ORDER", "0.30"]]),
    ]);
    expect(r.finalValueFee).toBe(10.3);
    expect(r.otherFees).toBe(0);
  });

  it("an unknown feeType lands in otherFees AND is named in diagnostics", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      saleWith([["FINAL_VALUE_FEE", "10.00"], ["SOME_NEW_EBAY_FEE_2027", "4.25"]]),
    ]);
    expect(feeMap.otherFees).toBe(4.25);
    expect(diagnostics.unknownFeeTypes).toEqual(["SOME_NEW_EBAY_FEE_2027"]);
    // Never dropped: the total still ties out.
    const sum = (feeMap.finalValueFee ?? 0) + (feeMap.otherFees ?? 0);
    expect(sum).toBe(14.25);
  });

  it("a recognized fee is NOT reported as unknown", () => {
    const { diagnostics } = mapFinancesToFeesWithDiagnostics([
      saleWith([["FINAL_VALUE_FEE", "10.00"], ["PAYMENT_PROCESSING_FEE", "1.00"]]),
    ]);
    expect(diagnostics.unknownFeeTypes).toEqual([]);
  });

  it("a missing fee line stays null — blank means unknown, never 0", () => {
    const r = mapFinancesToFees([
      {
        transactionId: "T",
        orderId: "O",
        transactionType: "SALE",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-17T00:00:00Z",
        amount: { value: "100.00", currency: "USD" },
        orderLineItems: [{ marketplaceFees: [] }],
      },
    ]);
    expect(r.finalValueFee).toBeNull();
    // Shipping is the deliberate exception: a posted SALE with no
    // SHIPPING_LABEL means no label was bought, which is a known 0.
    expect(r.actualShippingCost).toBe(0);
  });

  it("...but before any SALE posts, shipping is still unknown", () => {
    const r = mapFinancesToFees([]);
    expect(r.actualShippingCost).toBeNull();
    expect(r.netPayout).toBeNull();
  });

  it("promoted-listing fees billed as a NON_SALE_CHARGE (top-level fees[]) still land", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      saleWith([["FINAL_VALUE_FEE", "10.00"]]),
      {
        transactionId: "T2",
        orderId: "O",
        transactionType: "NON_SALE_CHARGE",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-18T00:00:00Z",
        amount: { value: "3.00", currency: "USD" },
        fees: [{ feeType: "AD_FEE", amount: { value: "3.00", currency: "USD" } }],
      },
    ]);
    expect(feeMap.promotedListingFee).toBe(3);
    expect(diagnostics.sawTopLevelFees).toBe(true);
    expect(diagnostics.sawLineItemFees).toBe(true);
  });

  it("currency sums settle at 2dp (no 46.84999999999991 in a tax export)", () => {
    const r = mapFinancesToFees([
      saleWith([["FINAL_VALUE_FEE", "0.1"], ["INTERNATIONAL_FEE", "0.2"]]),
    ]);
    expect(r.otherFees).toBe(0.2);
    expect(r.finalValueFee).toBe(0.1);
  });
});

// ─── The queue copy ──────────────────────────────────────────────────────

describe("D34 — the card only says 'waiting' for what eBay has not sent", () => {
  const base = {
    id: "e1",
    source: "ebay",
    soldAt: "2026-08-30T01:42:30.000Z",
    needsReconciliation: true,
    grossProceeds: 250,
  } as unknown as LedgerEntryForErp;

  it("payout not yet posted → all seven are genuinely unknown", () => {
    const missing = missingFeeFields({
      ...base,
      finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
    } as LedgerEntryForErp);
    expect(missing).toHaveLength(7);
    expect(missing).toContain("netPayout");
  });

  it("payout posted with no promotion → does NOT claim to be waiting on ad fees", () => {
    // The Griffey end-state: eBay posted the payout; there was no promoted
    // listing and no ad campaign, so those fees do not exist to wait for.
    const missing = missingFeeFields({
      ...base,
      finalValueFee: 33.13, paymentProcessingFee: 0, promotedListingFee: null,
      adFee: null, otherFees: 0, netPayout: 216.87, actualShippingCost: 4.5,
    } as LedgerEntryForErp);
    expect(missing).not.toContain("promotedListingFee");
    expect(missing).not.toContain("adFee");
    expect(missing).toEqual([]);
  });

  it("payout posted but shipping still unknown → waiting on exactly that one", () => {
    const missing = missingFeeFields({
      ...base,
      finalValueFee: 33.13, paymentProcessingFee: 0, promotedListingFee: null,
      adFee: null, otherFees: 0, netPayout: 216.87, actualShippingCost: null,
    } as LedgerEntryForErp);
    expect(missing).toEqual(["actualShippingCost"]);
  });
});
