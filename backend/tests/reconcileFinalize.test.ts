// CF-RECONCILE-FINALIZE (2026-07-12) — unit tests for applyFinalize +
// tryFinalizeReconciliation stamping reconciledAt.

import { describe, expect, it } from "vitest";
import {
  applyFinalize,
  validateFinalize,
} from "../src/services/portfolioiq/erpAgingOverride.service.js";
import {
  tryFinalizeReconciliation,
  missingFeeFields,
  enrichEntryForClient,
  type LedgerEntryForErp,
} from "../src/services/portfolioiq/erpReconciliation.service.js";

function makeStuckEntry(overrides: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "l-1",
    userId: "u-1",
    holdingId: "h-1",
    playerName: "Josiah Hartshorn",
    cardTitle: "2025 Bowman Draft Josiah Hartshorn",
    quantitySold: 1,
    unitSalePrice: 4000,
    grossProceeds: 4000,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 0,
    costBasisSold: 500,
    realizedProfitLoss: 0,
    realizedProfitLossPct: 0,
    soldAt: "2026-06-08T20:27:07Z",
    source: "ebay",
    ebayOrderId: "order-1",
    // Drew's real state: partial Finances enrichment
    finalValueFee: null,
    paymentProcessingFee: null,
    promotedListingFee: null,
    adFee: null,
    otherFees: null,
    netPayout: 3174.73,
    actualShippingCost: 59.96,
    gradingCost: null,
    suppliesCost: 3,
    userCostsProvidedAt: "2026-07-12T15:02:36Z",
    userCostsProvidedBy: "u-1",
    feeSource: "ebay_finances",
    needsReconciliation: true,
    ...overrides,
  };
}

describe("applyFinalize — Drew's stuck-entry shape", () => {
  it("zero-fills null granular fees + preserves real netPayout + actualShipping", () => {
    const before = makeStuckEntry();
    const { entry: after } = applyFinalize(before, { reason: "user-marked-no-fees" }, "u-1");
    // Real values preserved
    expect(after.netPayout).toBe(3174.73);
    expect(after.actualShippingCost).toBe(59.96);
    // Nulls zero-filled
    expect(after.finalValueFee).toBe(0);
    expect(after.paymentProcessingFee).toBe(0);
    expect(after.promotedListingFee).toBe(0);
    expect(after.adFee).toBe(0);
    expect(after.otherFees).toBe(0);
  });

  it("flips needsReconciliation to false + sets reconciledVia + reconciledAt", () => {
    const before = makeStuckEntry();
    const { entry: after } = applyFinalize(before, { reason: "user-marked-no-fees" }, "u-1");
    expect(after.needsReconciliation).toBe(false);
    expect(after.reconciledVia).toBe("manual_user_finalize");
    expect(after.reconciledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends a feeAdjustments audit row with the user's reason", () => {
    const before = makeStuckEntry({ feeAdjustments: [{
      adjustmentId: "prev-1",
      adjustedAt: "2026-07-11T00:00:00Z",
      adjustedBy: "u-1",
      reason: "previous",
      priorValues: {} as any,
      newValues: {} as any,
    }] });
    const { entry: after, adjustment } = applyFinalize(before, { reason: "waited too long" }, "u-1");
    expect(after.feeAdjustments).toHaveLength(2);
    expect(adjustment.reason).toBe("waited too long");
    expect(adjustment.priorValues.needsReconciliation).toBe(true);
    expect(adjustment.newValues.needsReconciliation).toBe(false);
  });
});

describe("applyFinalize — guardrails", () => {
  it("does NOT clobber a non-null real fee value with 0", () => {
    // Simulate an entry where finalValueFee is $200 (already Finances-supplied)
    const before = makeStuckEntry({ finalValueFee: 200, paymentProcessingFee: null });
    const { entry: after } = applyFinalize(before, { reason: "test" }, "u-1");
    expect(after.finalValueFee).toBe(200);       // preserved
    expect(after.paymentProcessingFee).toBe(0);  // zero-filled
  });

  it("uses caller-supplied netPayout only when entry has none", () => {
    // Entry with netPayout present → caller's netPayout ignored
    const before1 = makeStuckEntry({ netPayout: 3174.73 });
    const { entry: after1 } = applyFinalize(before1, { reason: "x", netPayout: 999 }, "u-1");
    expect(after1.netPayout).toBe(3174.73);

    // Entry with null netPayout → caller's netPayout used
    const before2 = makeStuckEntry({ netPayout: null });
    const { entry: after2 } = applyFinalize(before2, { reason: "x", netPayout: 999 }, "u-1");
    expect(after2.netPayout).toBe(999);

    // Entry with null netPayout + no caller supplied → 0
    const before3 = makeStuckEntry({ netPayout: null });
    const { entry: after3 } = applyFinalize(before3, { reason: "x" }, "u-1");
    expect(after3.netPayout).toBe(0);
  });

  it("sets userCostsProvidedAt if unset (idempotent when already set)", () => {
    // Already set → preserve
    const before1 = makeStuckEntry({ userCostsProvidedAt: "2026-07-01T00:00:00Z" });
    const { entry: after1 } = applyFinalize(before1, { reason: "x" }, "u-1");
    expect(after1.userCostsProvidedAt).toBe("2026-07-01T00:00:00Z");

    // Unset → stamped
    const before2 = makeStuckEntry({ userCostsProvidedAt: null });
    const { entry: after2 } = applyFinalize(before2, { reason: "x" }, "u-1");
    expect(after2.userCostsProvidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after2.userCostsProvidedBy).toBe("u-1");
  });
});

describe("validateFinalize — request shape", () => {
  it("requires reason", () => {
    const r = validateFinalize({});
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.code).toBe("MISSING_REASON");
  });

  it("rejects empty reason string", () => {
    const r = validateFinalize({ reason: "   " });
    expect("error" in r).toBe(true);
  });

  it("rejects reason > 500 chars", () => {
    const r = validateFinalize({ reason: "x".repeat(501) });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.code).toBe("REASON_TOO_LONG");
  });

  it("accepts optional netPayout as non-negative number", () => {
    const r = validateFinalize({ reason: "x", netPayout: 100 });
    expect("ok" in r).toBe(true);
    if ("ok" in r) expect(r.ok.netPayout).toBe(100);
  });

  it("rejects negative netPayout", () => {
    const r = validateFinalize({ reason: "x", netPayout: -1 });
    expect("error" in r).toBe(true);
  });

  it("accepts null/undefined netPayout by treating as absent", () => {
    const r1 = validateFinalize({ reason: "x", netPayout: null });
    const r2 = validateFinalize({ reason: "x" });
    if ("ok" in r1 && "ok" in r2) {
      expect(r1.ok.netPayout).toBeUndefined();
      expect(r2.ok.netPayout).toBeUndefined();
    }
  });
});

describe("tryFinalizeReconciliation stamps reconciledAt on success", () => {
  it("adds reconciledAt when both axes met", () => {
    const entry: LedgerEntryForErp = {
      id: "l", userId: "u", holdingId: "h", playerName: "p", cardTitle: "t",
      quantitySold: 1, unitSalePrice: 100, grossProceeds: 100, fees: 0, tax: 0,
      shipping: 0, netProceeds: 0, costBasisSold: 0, realizedProfitLoss: 0,
      realizedProfitLossPct: 0, soldAt: "2026-01-01T00:00:00Z", source: "ebay",
      finalValueFee: 0, paymentProcessingFee: 0, promotedListingFee: 0, adFee: 0,
      otherFees: 0, netPayout: 100, actualShippingCost: 0,
      userCostsProvidedAt: "2026-01-01T00:00:00Z",
      needsReconciliation: true,
      feeSource: "manual_user_finalize",
    };
    const result = tryFinalizeReconciliation(entry, "2026-07-12T13:48:00Z");
    expect(result.needsReconciliation).toBe(false);
    expect(result.reconciledVia).toBe("manual_user_finalize");
    expect(result.reconciledAt).toBe("2026-07-12T13:48:00Z");
  });

  it("does not stamp reconciledAt when axes unmet", () => {
    const entry: LedgerEntryForErp = {
      id: "l", userId: "u", holdingId: "h", playerName: "p", cardTitle: "t",
      quantitySold: 1, unitSalePrice: 100, grossProceeds: 100, fees: 0, tax: 0,
      shipping: 0, netProceeds: 0, costBasisSold: 0, realizedProfitLoss: 0,
      realizedProfitLossPct: 0, soldAt: "2026-01-01T00:00:00Z", source: "ebay",
      finalValueFee: null,   // axis 1 not met
      needsReconciliation: true,
    };
    const result = tryFinalizeReconciliation(entry);
    expect(result.reconciledAt).toBeUndefined();
  });
});

describe("missingFieldsExpandedRule", () => {
  it("catches undefined AND null fields (== instead of ===)", () => {
    // Legacy entry with fields absent (undefined) — should be treated as missing
    const entry: LedgerEntryForErp = {
      id: "l", userId: "u", holdingId: "h", playerName: "p", cardTitle: "t",
      quantitySold: 1, unitSalePrice: 100, grossProceeds: 100, fees: 0, tax: 0,
      shipping: 0, netProceeds: 0, costBasisSold: 0, realizedProfitLoss: 0,
      realizedProfitLossPct: 0, soldAt: "2026-01-01T00:00:00Z", source: "ebay",
      // finalValueFee etc. absent (undefined)
      needsReconciliation: true,
    };
    const missing = missingFeeFields(entry);
    expect(missing).toContain("finalValueFee");
    expect(missing).toContain("paymentProcessingFee");
    expect(missing).toHaveLength(7);
  });

  it("enrichEntryForClient always includes missingFields as an array", () => {
    // Finalized entry → empty array (not undefined)
    const finalized: LedgerEntryForErp = {
      id: "l", userId: "u", holdingId: "h", playerName: "p", cardTitle: "t",
      quantitySold: 1, unitSalePrice: 100, grossProceeds: 100, fees: 0, tax: 0,
      shipping: 0, netProceeds: 0, costBasisSold: 0, realizedProfitLoss: 0,
      realizedProfitLossPct: 0, soldAt: "2026-01-01T00:00:00Z", source: "ebay",
      needsReconciliation: false,
    };
    const enriched = enrichEntryForClient(finalized);
    expect(Array.isArray(enriched.missingFields)).toBe(true);
    expect(enriched.missingFields).toHaveLength(0);
  });
});
