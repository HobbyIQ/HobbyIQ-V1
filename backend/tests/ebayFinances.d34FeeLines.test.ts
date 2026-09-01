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
import {
  missingFeeFields,
  feesAxisSatisfied,
} from "../src/services/portfolioiq/erpReconciliation.service";
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
    // D34 R2 (2026-09-01): these three were `toBe(0)` and that was the
    // fabrication. eBay sent no payment-processing, ad, or other line on
    // this order — under managed payments it generally folds processing
    // into the final value fee — so we do not know those numbers. Writing
    // 0 invents a measurement headed for a tax export. Blank means unknown.
    expect(r.paymentProcessingFee).toBeNull();
    expect(r.adFee).toBeNull();
    expect(r.otherFees).toBeNull();
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

  // D34 R2 (2026-09-01): REWRITTEN from "every one of the seven fields is
  // populated — none left null". That assertion could only pass by
  // fabricating zeros for the three buckets eBay's payload never mentions.
  // The honest contract is: every field eBay REPORTED is populated, and the
  // three it did not report stay null.
  it("every field eBay reported is populated; the ones it did not stay null", () => {
    const r = mapFinancesToFees(fx.transactions);
    // Reported on the line items:
    expect(r.finalValueFee).not.toBeNull();
    expect(r.promotedListingFee).not.toBeNull();
    // Derived from the SALE / SHIPPING_LABEL transactions:
    expect(r.netPayout).not.toBeNull();
    expect(r.actualShippingCost).not.toBeNull();
    // Never sent by eBay for this order — unknown, not zero:
    expect(r.paymentProcessingFee).toBeNull();
    expect(r.adFee).toBeNull();
    expect(r.otherFees).toBeNull();
  });

  it("matches the fixture's declared expectedFeeMap", () => {
    expect(mapFinancesToFees(fx.transactions)).toEqual(fx.expectedFeeMap);
  });

  // BLOCKER 1, pinned on the REAL measured prod row. This is the assertion
  // that FAILED under R1: the Ohtani order carries netPayout 2396.85 with
  // all five fee lines null and $603.14 itemized nowhere, and R1's
  // netPayout-keyed early return reported that NOTHING was outstanding.
  it("the real Ohtani row reports its five fee lines as OUTSTANDING (never fetched)", () => {
    const s = observed.storedLedgerFields;
    const ohtaniAsStored = {
      id: "ohtani",
      source: "ebay",
      ebayOrderId: observed.orderId,
      soldAt: observed.soldAt,
      // The row is REOPENED for the refill — the defect it exposes is what
      // missingFeeFields must report while the breakdown is absent.
      needsReconciliation: true,
      grossProceeds: s.grossProceeds,
      finalValueFee: s.finalValueFee,
      paymentProcessingFee: s.paymentProcessingFee,
      promotedListingFee: s.promotedListingFee,
      adFee: s.adFee,
      otherFees: s.otherFees,
      netPayout: s.netPayout,
      actualShippingCost: s.actualShippingCost,
      // The discriminator: the pre-D34 mapper never read the breakdown, so
      // no fee fetch ever populated it.
      feeFetchedAt: null,
    } as unknown as LedgerEntryForErp;

    const missing = missingFeeFields(ohtaniAsStored);
    expect(missing).toContain("finalValueFee");
    expect(missing).toContain("paymentProcessingFee");
    expect(missing).toContain("promotedListingFee");
    expect(missing).toContain("adFee");
    expect(missing).toContain("otherFees");
    // The payout and shipping ARE known — those it does not ask for.
    expect(missing).not.toContain("netPayout");
    expect(missing).not.toContain("actualShippingCost");
    expect(missing).toHaveLength(5);
    // And the money it cannot account for is exactly the measured gap.
    expect(Number((s.grossProceeds - s.netPayout).toFixed(2))).toBe(603.14);
  });

  it("...and once the fetch HAS run, the same row stops asking", () => {
    const s = observed.storedLedgerFields;
    const afterRefill = {
      id: "ohtani",
      source: "ebay",
      soldAt: observed.soldAt,
      needsReconciliation: true,
      finalValueFee: 397.8,
      paymentProcessingFee: null, // eBay genuinely sent no such line
      promotedListingFee: 205.34,
      adFee: null,
      otherFees: null,
      netPayout: s.netPayout,
      actualShippingCost: s.actualShippingCost,
      feeFetchedAt: "2026-09-01T12:00:00.000Z",
    } as unknown as LedgerEntryForErp;
    expect(missingFeeFields(afterRefill)).toEqual([]);
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
    // D34 R2: was `toBe(0)`. Nothing landed in otherFees, and nothing
    // claimed it was zero either — so it is unknown.
    expect(r.otherFees).toBeNull();
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
    // D34 R2: shipping is NOT an exception. R1 wrote 0 here so the row
    // could pass feesAxisSatisfied; that invented a measurement and closed
    // the row on it irreversibly. The field stays blank; the FACT that
    // eBay sent no label lives in a diagnostic, and feesAxisSatisfied
    // reads that instead.
    expect(r.actualShippingCost).toBeNull();
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

// D34 R2 (2026-09-01): REWRITTEN. Every assertion in this block used to
// key on netPayout. The discriminator is the fee FETCH, not the payout —
// a payout can post (and did, on Ohtani) through a mapper that never read
// the breakdown at all.
describe("D34 R2 — 'waiting' means the fetch has not answered, not that a field is null", () => {
  const base = {
    id: "e1",
    source: "ebay",
    soldAt: "2026-08-30T01:42:30.000Z",
    needsReconciliation: true,
    grossProceeds: 250,
  } as unknown as LedgerEntryForErp;

  it("never fetched → all seven are genuinely unknown", () => {
    const missing = missingFeeFields({
      ...base,
      finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: null, actualShippingCost: null,
      feeFetchedAt: null,
    } as LedgerEntryForErp);
    expect(missing).toHaveLength(7);
    expect(missing).toContain("netPayout");
  });

  it("payout posted but NEVER FETCHED → still reports every absent fee line", () => {
    // This is the Ohtani shape and the R1 blocker: a payout alone must not
    // buy silence. R1 returned [] here.
    const missing = missingFeeFields({
      ...base,
      finalValueFee: null, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: 216.87, actualShippingCost: 4.5,
      feeFetchedAt: null,
    } as LedgerEntryForErp);
    expect(missing).toEqual([
      "finalValueFee", "paymentProcessingFee", "promotedListingFee",
      "adFee", "otherFees",
    ]);
  });

  it("fetched, no promotion → does NOT claim to be waiting on ad fees", () => {
    // The Griffey end-state: eBay answered; there was no promoted listing
    // and no ad campaign, so those fees do not exist to wait for.
    const missing = missingFeeFields({
      ...base,
      finalValueFee: 33.13, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: 216.87, actualShippingCost: 4.5,
      feeFetchedAt: "2026-09-01T12:00:00.000Z",
    } as LedgerEntryForErp);
    expect(missing).not.toContain("promotedListingFee");
    expect(missing).not.toContain("adFee");
    expect(missing).toEqual([]);
  });

  it("fetched but eBay has not posted the label yet → waiting on exactly that one", () => {
    const missing = missingFeeFields({
      ...base,
      finalValueFee: 33.13, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: 216.87, actualShippingCost: null,
      feeFetchedAt: "2026-09-01T12:00:00.000Z",
      shippingAbsentFromEbay: false,
    } as LedgerEntryForErp);
    expect(missing).toEqual(["actualShippingCost"]);
  });

  it("fetched and eBay says there IS no label → nothing outstanding, and no 0 was written", () => {
    const entry = {
      ...base,
      finalValueFee: 33.13, paymentProcessingFee: null, promotedListingFee: null,
      adFee: null, otherFees: null, netPayout: 216.87, actualShippingCost: null,
      feeFetchedAt: "2026-09-01T12:00:00.000Z",
      shippingAbsentFromEbay: true,
    } as LedgerEntryForErp;
    expect(missingFeeFields(entry)).toEqual([]);
    // The row can close — WITHOUT a fabricated measurement in the ledger.
    expect(feesAxisSatisfied(entry)).toBe(true);
    expect(entry.actualShippingCost).toBeNull();
  });

  it("a shipping-absent claim with NO fetch behind it does not close the row", () => {
    // shippingAbsentFromEbay is only meaningful as the result of an answer.
    expect(feesAxisSatisfied({
      ...base,
      netPayout: 216.87, actualShippingCost: null,
      shippingAbsentFromEbay: true,
      feeFetchedAt: null,
    } as LedgerEntryForErp)).toBe(false);
  });
});

// ─── D34 R2 adversarials: the four blockers + two secondaries ─────────────

describe("D34 R2 — netPayout is attributed PER SALE transaction", () => {
  const sale = (
    id: string,
    gross: string,
    totalFee: string | null,
    fees: Array<[string, string]> = [],
  ): FinancesTransaction => ({
    transactionId: id,
    orderId: "O",
    transactionType: "SALE",
    transactionStatus: "FUNDS_AVAILABLE_FOR_PAYOUT",
    transactionDate: "2026-08-17T00:00:00Z",
    amount: { value: gross, currency: "USD" },
    ...(totalFee ? { totalFeeAmount: { value: totalFee, currency: "USD" } } : {}),
    orderLineItems: [
      {
        marketplaceFees: fees.map(([feeType, value]) => ({
          feeType,
          amount: { value, currency: "USD" },
        })),
      },
    ],
  });

  it("the mixed-basis two-SALE order yields 173.50, not 186.75", () => {
    // BLOCKER 3. Two $100 SALEs; only the first carries totalFeeAmount.
    // R1 summed both grosses and subtracted the ONE fee total from the
    // whole $200 — one line item's fees taken off two line items' gross —
    // and reported the reassuring basis "amount_minus_total_fees".
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
      sale("S2", "86.75", null, [["FINAL_VALUE_FEE", "13.25"]]),
    ]);
    // S1: 100 - 13.25 = 86.75. S2: 86.75 already net. Total 173.50.
    expect(feeMap.netPayout).toBe(173.5);
    expect(diagnostics.netPayoutBasis).toBe("mixed_per_line_item");
    expect(diagnostics.saleTransactionCount).toBe(2);
    expect(diagnostics.saleTransactionsWithTotalFee).toBe(1);
  });

  it("a compound derivation NEVER reports a clean basis", () => {
    const { diagnostics } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", "13.25"),
      sale("S2", "100.00", null),
    ]);
    expect(diagnostics.netPayoutBasis).not.toBe("amount_minus_total_fees");
    expect(diagnostics.netPayoutBasis).not.toBe("amount_as_net");
  });

  it("all SALEs carrying totalFeeAmount → clean basis, pairwise subtraction", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", "13.25"),
      sale("S2", "100.00", "13.25"),
    ]);
    expect(feeMap.netPayout).toBe(173.5);
    expect(diagnostics.netPayoutBasis).toBe("amount_minus_total_fees");
  });

  it("no SALE carrying totalFeeAmount → amount taken as already-net", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", null),
      sale("S2", "50.00", null),
    ]);
    expect(feeMap.netPayout).toBe(150);
    expect(diagnostics.netPayoutBasis).toBe("amount_as_net");
  });

  it("a REFUND reduces netPayout — a fully refunded order pays 0", () => {
    // SECONDARY. R1 reported the seller was paid 86.75 on a fully
    // refunded $100 order.
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", "13.25", [["FINAL_VALUE_FEE", "13.25"]]),
      {
        transactionId: "R1",
        orderId: "O",
        transactionType: "REFUND",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-20T00:00:00Z",
        amount: { value: "-100.00", currency: "USD" },
        fees: [{ feeType: "FINAL_VALUE_FEE", amount: { value: "-13.25", currency: "USD" } }],
      },
    ]);
    // 86.75 credited, 100.00 returned to the buyer.
    expect(feeMap.netPayout).toBe(-13.25);
    expect(diagnostics.refundTotal).toBe(100);
    // The fee CREDIT nets the bucket back to zero — and 0 here is a stated
    // fact (two lines were seen), not a fabrication.
    expect(feeMap.finalValueFee).toBe(0);
  });

  it("a partial refund reduces the payout by exactly the refunded amount", () => {
    const { feeMap } = mapFinancesToFeesWithDiagnostics([
      sale("S1", "100.00", "13.25"),
      {
        transactionId: "R1",
        orderId: "O",
        transactionType: "REFUND",
        transactionStatus: "COMPLETED",
        transactionDate: "2026-08-20T00:00:00Z",
        amount: { value: "-25.00", currency: "USD" },
      },
    ]);
    expect(feeMap.netPayout).toBe(61.75);
  });

  it("no REFUND → refundTotal stays null, not a fabricated 0", () => {
    const { diagnostics } = mapFinancesToFeesWithDiagnostics([sale("S1", "100.00", "13.25")]);
    expect(diagnostics.refundTotal).toBeNull();
  });
});

describe("D34 R2 — per-bucket sighting: nothing invented, nothing dropped", () => {
  const saleWithFees = (fees: Array<[string, string]>): FinancesTransaction => ({
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

  it("one fee line does NOT populate the other four buckets", () => {
    // BLOCKER 2, the fabrication direction.
    const r = mapFinancesToFees([saleWithFees([["FINAL_VALUE_FEE", "10.00"]])]);
    expect(r.finalValueFee).toBe(10);
    expect(r.paymentProcessingFee).toBeNull();
    expect(r.promotedListingFee).toBeNull();
    expect(r.adFee).toBeNull();
    expect(r.otherFees).toBeNull();
  });

  it("an explicit 0.00 fee line IS recorded as 0", () => {
    // BLOCKER 2, the discard direction. R1's `if (v === 0) return` threw
    // this away and reported null — unknown, for a number eBay stated.
    const r = mapFinancesToFees([saleWithFees([["FINAL_VALUE_FEE", "0.00"]])]);
    expect(r.finalValueFee).toBe(0);
  });

  it("stated-zero and absent are DISTINGUISHABLE on the same bucket", () => {
    const stated = mapFinancesToFees([saleWithFees([["AD_FEE_ADV", "0.00"]])]);
    const absent = mapFinancesToFees([saleWithFees([["FINAL_VALUE_FEE", "1.00"]])]);
    expect(stated.adFee).toBe(0);
    expect(absent.adFee).toBeNull();
  });

  it("a zero-valued UNKNOWN fee type is still named", () => {
    // SECONDARY. R1 named a type only when its parsed value was non-zero —
    // dropping the name exactly where a malformed type is likeliest.
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      saleWithFees([["SOME_NEW_EBAY_FEE_2027", "0.00"]]),
    ]);
    expect(diagnostics.unknownFeeTypes).toEqual(["SOME_NEW_EBAY_FEE_2027"]);
    expect(feeMap.otherFees).toBe(0);
  });

  it("a NON-NUMERIC unknown fee type is still named", () => {
    const { feeMap, diagnostics } = mapFinancesToFeesWithDiagnostics([
      saleWithFees([["MALFORMED_FEE_TYPE", "not-a-number"]]),
    ]);
    expect(diagnostics.unknownFeeTypes).toEqual(["MALFORMED_FEE_TYPE"]);
    // The bucket is KNOWN (a line existed) and contributes nothing parseable.
    expect(feeMap.otherFees).toBe(0);
  });

  it("a non-numeric amount on a RECOGNIZED type does not silently vanish the bucket", () => {
    const r = mapFinancesToFees([saleWithFees([["FINAL_VALUE_FEE", "n/a"]])]);
    expect(r.finalValueFee).toBe(0);
  });
});
