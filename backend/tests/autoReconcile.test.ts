// CF-AUTO-RECONCILE (2026-07-12) — unit tests for Layer 1 (auto-zero-costs
// at webhook time) and Layer 2 (feesAxisSatisfied via netPayout+shipping
// shortcut). Together these two changes make reconciliation invisible for
// the ~99% common eBay buy-and-flip case.

import { describe, expect, it } from "vitest";
import {
  allGranularFeesKnown,
  feesAxisSatisfied,
  missingFeeFields,
  tryFinalizeReconciliation,
  type LedgerEntryForErp,
} from "../src/services/portfolioiq/erpReconciliation.service.js";

function makeEntry(overrides: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "l-1",
    userId: "u-1",
    holdingId: "h-1",
    playerName: "Test",
    cardTitle: "Test",
    quantitySold: 1,
    unitSalePrice: 100,
    grossProceeds: 100,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 0,
    costBasisSold: 50,
    realizedProfitLoss: 0,
    realizedProfitLossPct: 0,
    soldAt: "2026-07-01T00:00:00Z",
    source: "ebay",
    needsReconciliation: true,
    ...overrides,
  };
}

describe("Layer 2 — feesAxisSatisfied", () => {
  it("accepts full granular breakdown (backward compat)", () => {
    const e = makeEntry({
      finalValueFee: 10, paymentProcessingFee: 3, promotedListingFee: 0,
      adFee: 0, otherFees: 0, netPayout: 80, actualShippingCost: 5,
    });
    expect(allGranularFeesKnown(e)).toBe(true);
    expect(feesAxisSatisfied(e)).toBe(true);
  });

  it("accepts netPayout + actualShippingCost only (Layer 2 shortcut)", () => {
    // Drew's stuck-entry shape: partial Finances enrichment
    const e = makeEntry({
      netPayout: 80,
      actualShippingCost: 5,
      // granular breakdown missing
      finalValueFee: null,
      paymentProcessingFee: null,
    });
    expect(allGranularFeesKnown(e)).toBe(false);
    expect(feesAxisSatisfied(e)).toBe(true);
  });

  it("rejects when netPayout present but shipping missing", () => {
    const e = makeEntry({ netPayout: 80, actualShippingCost: null });
    expect(feesAxisSatisfied(e)).toBe(false);
  });

  it("rejects when shipping present but netPayout missing", () => {
    const e = makeEntry({ netPayout: null, actualShippingCost: 5 });
    expect(feesAxisSatisfied(e)).toBe(false);
  });

  it("rejects when both missing (no fee data at all)", () => {
    const e = makeEntry({ netPayout: null, actualShippingCost: null });
    expect(feesAxisSatisfied(e)).toBe(false);
  });
});

describe("Layer 2 — missingFeeFields returns [] when axis satisfied", () => {
  it("returns [] for netPayout+shipping shortcut even without granular breakdown", () => {
    const e = makeEntry({
      netPayout: 80,
      actualShippingCost: 5,
      finalValueFee: null,
      paymentProcessingFee: null,
      promotedListingFee: null,
      adFee: null,
      otherFees: null,
    });
    expect(missingFeeFields(e)).toEqual([]);
  });

  it("returns fields list when axis not satisfied", () => {
    const e = makeEntry({
      netPayout: null,
      actualShippingCost: null,
      finalValueFee: null,
    });
    expect(missingFeeFields(e).length).toBeGreaterThan(0);
    expect(missingFeeFields(e)).toContain("finalValueFee");
  });
});

describe("tryFinalizeReconciliation with Layer 2 predicate", () => {
  it("closes with netPayout+shipping when userCostsProvidedAt set", () => {
    const e = makeEntry({
      netPayout: 80,
      actualShippingCost: 5,
      userCostsProvidedAt: "2026-07-12T00:00:00Z",
      feeSource: "ebay_finances",
    });
    const result = tryFinalizeReconciliation(e);
    expect(result.needsReconciliation).toBe(false);
    expect(result.reconciledVia).toBe("ebay_finances");
    expect(result.reconciledAt).toMatch(/^\d{4}-/);
  });

  it("does NOT close when only fees axis met (user costs still pending)", () => {
    const e = makeEntry({
      netPayout: 80,
      actualShippingCost: 5,
      userCostsProvidedAt: null,
    });
    const result = tryFinalizeReconciliation(e);
    expect(result.needsReconciliation).toBe(true);
  });

  it("does NOT close when only user-costs axis met (fees still pending)", () => {
    const e = makeEntry({
      netPayout: null,
      actualShippingCost: null,
      userCostsProvidedAt: "2026-07-12T00:00:00Z",
    });
    const result = tryFinalizeReconciliation(e);
    expect(result.needsReconciliation).toBe(true);
  });
});
