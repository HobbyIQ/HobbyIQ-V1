// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): mapFinancesToFees tests.
//
// Pins the bucketing rules from the design table. The mapper is THE
// load-bearing assumption to verify against real Finances payloads when
// the first ITEM_SOLD lands — pinning here means a future "actually it's
// AD_FEE_ADV_X for ads, not AD_FEE_ADV" correction shows up as one
// flipped expectation, not a multi-file detective hunt.

import { describe, expect, it } from "vitest";
import {
  mapFinancesToFees,
  type FinancesTransaction,
} from "../src/services/ebay/ebayFinances.service";

function mkSale(opts: {
  netAmount?: string;
  fees?: Array<{ feeType: string; amount: string }>;
  orderId?: string;
}): FinancesTransaction {
  return {
    transactionId: "T-" + Math.random().toString(36).slice(2),
    orderId: opts.orderId ?? "O1",
    amount: { value: opts.netAmount ?? "0", currency: "USD" },
    fees: (opts.fees ?? []).map((f) => ({
      feeType: f.feeType,
      amount: { value: f.amount, currency: "USD" },
    })),
    transactionType: "SALE",
    transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
    transactionDate: "2026-06-04T00:00:00Z",
  };
}

function mkShippingLabel(amount: string): FinancesTransaction {
  return {
    transactionId: "SL-" + Math.random().toString(36).slice(2),
    orderId: "O1",
    amount: { value: amount, currency: "USD" },
    fees: [],
    transactionType: "SHIPPING_LABEL",
    transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
    transactionDate: "2026-06-04T00:00:00Z",
  };
}

describe("mapFinancesToFees — bucketing rules", () => {
  it("FINAL_VALUE_FEE → finalValueFee", () => {
    const r = mapFinancesToFees([
      mkSale({
        netAmount: "200",
        fees: [{ feeType: "FINAL_VALUE_FEE", amount: "20" }],
      }),
    ]);
    expect(r.finalValueFee).toBe(20);
    expect(r.paymentProcessingFee).toBe(0);
    expect(r.netPayout).toBe(200);
  });

  it("PAYMENT_PROCESSING_FEE and PAYMENT_PROCESSING_FEE_INTERNATIONAL → paymentProcessingFee (summed)", () => {
    const r = mapFinancesToFees([
      mkSale({
        netAmount: "100",
        fees: [
          { feeType: "PAYMENT_PROCESSING_FEE", amount: "5" },
          { feeType: "PAYMENT_PROCESSING_FEE_INTERNATIONAL", amount: "2" },
        ],
      }),
    ]);
    expect(r.paymentProcessingFee).toBe(7);
  });

  it("FINAL_VALUE_FEE_AD_FEE and AD_FEE (Promoted Standard) → promotedListingFee", () => {
    const r1 = mapFinancesToFees([
      mkSale({ fees: [{ feeType: "FINAL_VALUE_FEE_AD_FEE", amount: "3" }] }),
    ]);
    expect(r1.promotedListingFee).toBe(3);
    const r2 = mapFinancesToFees([
      mkSale({ fees: [{ feeType: "AD_FEE", amount: "1" }] }),
    ]);
    expect(r2.promotedListingFee).toBe(1);
  });

  it("AD_FEE_ADV / PROMOTED_DISPLAY → adFee", () => {
    const r1 = mapFinancesToFees([
      mkSale({ fees: [{ feeType: "AD_FEE_ADV", amount: "4" }] }),
    ]);
    expect(r1.adFee).toBe(4);
    const r2 = mapFinancesToFees([
      mkSale({ fees: [{ feeType: "PROMOTED_DISPLAY_FEE", amount: "2" }] }),
    ]);
    expect(r2.adFee).toBe(2);
  });

  it("unmatched feeType → otherFees (nothing dropped)", () => {
    const r = mapFinancesToFees([
      mkSale({
        netAmount: "100",
        fees: [
          { feeType: "REGULATORY_OPERATING_FEE", amount: "0.5" },
          { feeType: "DISPUTE_FEE", amount: "10" },
          { feeType: "INTERNATIONAL_FEE", amount: "1.5" },
          { feeType: "SOMETHING_BRAND_NEW_FROM_EBAY", amount: "3" },
        ],
      }),
    ]);
    expect(r.otherFees).toBe(15);
    expect(r.finalValueFee).toBe(0);
    expect(r.promotedListingFee).toBe(0);
    expect(r.adFee).toBe(0);
  });

  it("SALE transaction's amount → netPayout (summed across multiple SALE txns sharing an orderId)", () => {
    const r = mapFinancesToFees([
      mkSale({ netAmount: "100", fees: [{ feeType: "FINAL_VALUE_FEE", amount: "10" }] }),
      mkSale({ netAmount: "50", fees: [{ feeType: "FINAL_VALUE_FEE", amount: "5" }] }),
    ]);
    expect(r.netPayout).toBe(150);
    expect(r.finalValueFee).toBe(15);
  });

  it("SHIPPING_LABEL transaction's amount (absolute) → actualShippingCost", () => {
    const r = mapFinancesToFees([
      mkSale({ netAmount: "200", fees: [{ feeType: "FINAL_VALUE_FEE", amount: "20" }] }),
      mkShippingLabel("-5.50"), // eBay sends negative for label debits
    ]);
    expect(r.actualShippingCost).toBe(5.5);
    expect(r.netPayout).toBe(200);
  });

  it("no SALE txn → netPayout is null (not 0)", () => {
    const r = mapFinancesToFees([
      mkShippingLabel("-5"),
    ]);
    expect(r.netPayout).toBeNull();
  });

  it("no fees on any txn → all fee buckets null (not 0)", () => {
    const r = mapFinancesToFees([
      mkSale({ netAmount: "100", fees: [] }),
    ]);
    expect(r.finalValueFee).toBeNull();
    expect(r.paymentProcessingFee).toBeNull();
    expect(r.promotedListingFee).toBeNull();
    expect(r.adFee).toBeNull();
    expect(r.otherFees).toBeNull();
    // SALE present, so netPayout IS known:
    expect(r.netPayout).toBe(100);
    // No SHIPPING_LABEL, so actualShippingCost is null:
    expect(r.actualShippingCost).toBeNull();
  });

  it("empty input → all-null map", () => {
    const r = mapFinancesToFees([]);
    expect(r).toEqual({
      finalValueFee: null,
      paymentProcessingFee: null,
      promotedListingFee: null,
      adFee: null,
      otherFees: null,
      netPayout: null,
      actualShippingCost: null,
    });
  });

  it("zero-value fees are skipped (no spurious otherFees buckets)", () => {
    const r = mapFinancesToFees([
      mkSale({
        netAmount: "100",
        fees: [
          { feeType: "FINAL_VALUE_FEE", amount: "10" },
          { feeType: "DISPUTE_FEE", amount: "0" }, // skip
        ],
      }),
    ]);
    expect(r.finalValueFee).toBe(10);
    expect(r.otherFees).toBe(0);  // sawAnyFee=true (FVF triggered it), but no real other-bucket fees
  });

  it("case-insensitive feeType matching (FINAL_VALUE_FEE vs final_value_fee)", () => {
    const r = mapFinancesToFees([
      mkSale({ fees: [{ feeType: "final_value_fee", amount: "10" }] }),
    ]);
    expect(r.finalValueFee).toBe(10);
  });
});
