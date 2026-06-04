// CF-EBAY-FINANCES-ENRICHMENT (Group D, 2026-06-04): applyFeeEnrichment +
// consistency invariant with applyFeeOverride.

import { describe, expect, it } from "vitest";
import {
  applyFeeEnrichment,
  applyFeeOverride,
  type FeeEnrichmentInput,
} from "../src/services/portfolioiq/erpAgingOverride.service";
import { computeLedgerFinancials } from "../src/services/portfolioiq/portfolioStore.service";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service";

function makeUnreconciledEbayEntry(
  over: Partial<LedgerEntryForErp> = {},
): LedgerEntryForErp {
  return {
    id: "e-1",
    userId: "u-1",
    holdingId: "h-1",
    playerName: "Test Player",
    cardTitle: "2024 Topps Chrome RC",
    quantitySold: 1,
    unitSalePrice: 250,
    grossProceeds: 250,
    fees: 0, tax: 0, shipping: 0,
    netProceeds: 250,
    costBasisSold: 80,
    realizedProfitLoss: 170,
    realizedProfitLossPct: 212.5,
    soldAt: "2026-05-10T00:00:00Z",
    source: "ebay",
    ebayOrderId: "ORD-1",
    finalValueFee: null,
    paymentProcessingFee: null,
    promotedListingFee: null,
    adFee: null,
    otherFees: null,
    netPayout: null,
    actualShippingCost: null,
    suppliesCost: null,
    gradingCost: null,
    needsReconciliation: true,
    salesChannel: "ebay",
    paymentMethod: "ebay_managed",
    ...over,
  } as unknown as LedgerEntryForErp;
}

describe("applyFeeEnrichment — fee application + audit row", () => {
  it("applies all 7 fees, sets needsReconciliation=false, reconciledVia='ebay_finances'", () => {
    const entry = makeUnreconciledEbayEntry();
    const enrichment: FeeEnrichmentInput = {
      finalValueFee: 32,
      paymentProcessingFee: 8,
      promotedListingFee: 0,
      adFee: 0,
      otherFees: 1.5,
      netPayout: 208.5, // gross 250 - 32 - 8 - 0 - 0 - 1.5 = 208.5
      actualShippingCost: 5,
    };

    const { entry: enriched, adjustment } = applyFeeEnrichment(
      entry,
      enrichment,
      "2026-06-04T00:00:00Z",
    );

    expect(enriched.finalValueFee).toBe(32);
    expect(enriched.paymentProcessingFee).toBe(8);
    expect(enriched.promotedListingFee).toBe(0);
    expect(enriched.adFee).toBe(0);
    expect(enriched.otherFees).toBe(1.5);
    expect(enriched.netPayout).toBe(208.5);
    expect(enriched.actualShippingCost).toBe(5);
    expect(enriched.needsReconciliation).toBe(false);
    expect(enriched.reconciledVia).toBe("ebay_finances");

    expect(adjustment.adjustedBy).toBe("system:ebay_finances");
    expect(adjustment.reason).toMatch(/eBay Finances/i);
    expect(adjustment.priorValues.finalValueFee).toBeNull();
    expect(adjustment.priorValues.needsReconciliation).toBe(true);
    expect(adjustment.priorValues.reconciledVia).toBeUndefined();
    expect(adjustment.newValues.finalValueFee).toBe(32);
    expect(adjustment.newValues.needsReconciliation).toBe(false);
    expect(adjustment.newValues.reconciledVia).toBe("ebay_finances");
  });

  it("net=netPayout-gradingCost-suppliesCost (authoritative branch)", () => {
    const entry = makeUnreconciledEbayEntry({
      gradingCost: 25,
      suppliesCost: 3,
    });
    const enrichment: FeeEnrichmentInput = {
      finalValueFee: 32,
      paymentProcessingFee: 8,
      promotedListingFee: 0,
      adFee: 0,
      otherFees: 0,
      netPayout: 210,
      actualShippingCost: 5,
    };
    const { entry: enriched } = applyFeeEnrichment(entry, enrichment);

    // Recompute the way the job layer does:
    const granularSum =
      (enrichment.finalValueFee ?? 0) +
      (enrichment.paymentProcessingFee ?? 0) +
      (enrichment.promotedListingFee ?? 0) +
      (enrichment.adFee ?? 0) +
      (enrichment.otherFees ?? 0) +
      (enrichment.actualShippingCost ?? 0);
    const financials = computeLedgerFinancials({
      grossProceeds: entry.grossProceeds,
      feesTotal: granularSum,
      tax: 0, shipping: 0,
      gradingCost: enriched.gradingCost ?? null,
      suppliesCost: enriched.suppliesCost ?? null,
      costBasisSold: enriched.costBasisSold,
      netPayoutOverride: enrichment.netPayout,
    });
    // netPayout-authoritative branch fires:
    //   210 - 25 (grading) - 3 (supplies) = 182
    expect(financials.netProceeds).toBe(182);
    expect(financials.realizedProfitLoss).toBe(182 - 80);
  });

  it("appends a NEW feeAdjustments[] row; never overwrites existing audit history", () => {
    const existing = makeUnreconciledEbayEntry();
    (existing as any).feeAdjustments = [
      {
        adjustmentId: "PRIOR-1",
        adjustedAt: "2026-05-01T00:00:00Z",
        adjustedBy: "user-x",
        reason: "earlier override",
        priorValues: {} as any,
        newValues: {} as any,
      },
    ];
    const { entry: enriched } = applyFeeEnrichment(existing, {
      finalValueFee: 10, paymentProcessingFee: 2,
      promotedListingFee: 0, adFee: 0, otherFees: 0,
      netPayout: 238, actualShippingCost: 0,
    });
    expect(enriched.feeAdjustments).toHaveLength(2);
    expect((enriched.feeAdjustments as any)[0].adjustmentId).toBe("PRIOR-1");
    expect((enriched.feeAdjustments as any)[1].adjustedBy).toBe("system:ebay_finances");
  });
});

describe("Consistency invariant — applyFeeEnrichment === applyFeeOverride when netPayout supplied", () => {
  it("identical inputs produce identical netProceeds (the authoritative path)", () => {
    const entry = makeUnreconciledEbayEntry({ gradingCost: 12, suppliesCost: 1 });

    // Same fee values; one goes through the Finances path, the other through manual override.
    const fees = {
      finalValueFee: 32,
      paymentProcessingFee: 8,
      promotedListingFee: 0,
      adFee: 0,
      otherFees: 0,
      netPayout: 210,
      actualShippingCost: 5,
    };

    const { entry: viaFinances } = applyFeeEnrichment(entry, fees);
    const { entry: viaOverride } = applyFeeOverride(
      entry,
      { fees, reason: "test consistency" },
      "u-1",
    );

    // Compute netProceeds both ways using the EXACT same code path the
    // job/route uses post-helper.
    const recompute = (e: any, netPayout: number | null) => {
      const granularSum =
        (e.finalValueFee ?? 0) + (e.paymentProcessingFee ?? 0) +
        (e.promotedListingFee ?? 0) + (e.adFee ?? 0) +
        (e.otherFees ?? 0) + (e.actualShippingCost ?? 0);
      return computeLedgerFinancials({
        grossProceeds: e.grossProceeds,
        feesTotal: granularSum,
        tax: 0, shipping: 0,
        gradingCost: e.gradingCost ?? null,
        suppliesCost: e.suppliesCost ?? null,
        costBasisSold: e.costBasisSold,
        netPayoutOverride: netPayout,
      });
    };

    const fF = recompute(viaFinances, fees.netPayout);
    const fO = recompute(viaOverride, fees.netPayout);

    expect(fF.netProceeds).toBe(fO.netProceeds);
    expect(fF.realizedProfitLoss).toBe(fO.realizedProfitLoss);
    expect(fF.realizedProfitLossPct).toBe(fO.realizedProfitLossPct);
  });

  it("when netPayout is NULL on both, fallback formulas still agree", () => {
    const entry = makeUnreconciledEbayEntry();
    const fees = {
      finalValueFee: 32,
      paymentProcessingFee: 8,
      promotedListingFee: 0,
      adFee: 0,
      otherFees: 0,
      netPayout: null,
      actualShippingCost: 5,
    };

    const { entry: viaFinances } = applyFeeEnrichment(entry, fees);
    const { entry: viaOverride } = applyFeeOverride(
      entry,
      { fees, reason: "fallback consistency" },
      "u-1",
    );

    const recompute = (e: any) => {
      const granularSum =
        (e.finalValueFee ?? 0) + (e.paymentProcessingFee ?? 0) +
        (e.promotedListingFee ?? 0) + (e.adFee ?? 0) +
        (e.otherFees ?? 0) + (e.actualShippingCost ?? 0);
      return computeLedgerFinancials({
        grossProceeds: e.grossProceeds,
        feesTotal: granularSum,
        tax: 0, shipping: 0,
        gradingCost: e.gradingCost ?? null,
        suppliesCost: e.suppliesCost ?? null,
        costBasisSold: e.costBasisSold,
        netPayoutOverride: null,
      });
    };

    const fF = recompute(viaFinances);
    const fO = recompute(viaOverride);
    // Both should compute: 250 - (32 + 8 + 0 + 0 + 0 + 5) = 205
    expect(fF.netProceeds).toBe(205);
    expect(fO.netProceeds).toBe(205);
    expect(fF.netProceeds).toBe(fO.netProceeds);
  });
});
