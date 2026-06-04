// CF-ERP-EXPANSION-#6 (2026-06-03): aging + manual fee-override audit trail.

import { describe, expect, it } from "vitest";
import {
  applyFeeOverride,
  buildAging,
  validateFeeOverride,
} from "../src/services/portfolioiq/erpAgingOverride.service.js";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service.js";

const NOW = Date.parse("2026-06-03T12:00:00.000Z");

function unrec(daysOld: number, over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  const soldAt = new Date(NOW - daysOld * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: `L-${daysOld}`,
    userId: "u",
    holdingId: "h",
    playerName: "Skenes",
    cardTitle: "Card",
    quantitySold: 1,
    unitSalePrice: 100,
    grossProceeds: 100,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 0,
    costBasisSold: 40,
    realizedProfitLoss: 0,
    realizedProfitLossPct: 0,
    soldAt,
    source: "ebay",
    needsReconciliation: true,
    finalValueFee: null,
    paymentProcessingFee: null,
    actualShippingCost: null,
    netPayout: null,
    ...over,
  };
}

describe("buildAging — buckets 0-7 / 8-30 / 31-60 / >60", () => {
  it("buckets unreconciled entries correctly (CF-EBAY-FINANCES-ENRICHMENT Group D)", () => {
    const ledger = [unrec(3), unrec(15), unrec(45), unrec(75)];
    const a = buildAging(ledger, NOW);
    const byBucket = Object.fromEntries(a.buckets.map((b) => [b.bucket, b.count]));
    expect(byBucket["0-7d"]).toBe(1);
    expect(byBucket["8-30d"]).toBe(1);
    expect(byBucket["31-60d"]).toBe(1);
    expect(byBucket[">60d"]).toBe(1);
    expect(a.totalUnreconciled).toBe(4);
  });

  it("ignores reconciled entries", () => {
    const ledger = [
      unrec(10),
      unrec(10, { id: "ok", needsReconciliation: false }),
    ];
    const a = buildAging(ledger, NOW);
    expect(a.totalUnreconciled).toBe(1);
  });
});

describe("validateFeeOverride", () => {
  it("rejects missing reason", () => {
    expect("error" in validateFeeOverride({ fees: { finalValueFee: 5 } })).toBe(true);
  });
  it("rejects empty fees object", () => {
    expect("error" in validateFeeOverride({ reason: "ok", fees: {} })).toBe(true);
  });
  it("rejects negative fee", () => {
    expect("error" in validateFeeOverride({ reason: "ok", fees: { finalValueFee: -1 } })).toBe(true);
  });
  it("accepts a valid body", () => {
    const r = validateFeeOverride({ reason: "from receipt", fees: { finalValueFee: 13, paymentProcessingFee: 4 } });
    expect("ok" in r).toBe(true);
  });
});

describe("applyFeeOverride — audit trail", () => {
  it("flips needsReconciliation=false + sets reconciledVia=manual_override", () => {
    const r = applyFeeOverride(
      unrec(45),
      {
        fees: { finalValueFee: 13, paymentProcessingFee: 4, actualShippingCost: 3 },
        reason: "from receipt",
      },
      "u-1",
    );
    expect(r.entry.needsReconciliation).toBe(false);
    expect(r.entry.reconciledVia).toBe("manual_override");
  });

  it("APPENDS to feeAdjustments[]; preserves prior + new snapshot", () => {
    const before = unrec(45);
    const r = applyFeeOverride(
      before,
      { fees: { finalValueFee: 10 }, reason: "first attempt" },
      "u-1",
    );
    expect(r.entry.feeAdjustments).toHaveLength(1);
    expect(r.adjustment.priorValues.finalValueFee).toBeNull();
    expect(r.adjustment.newValues.finalValueFee).toBe(10);
    expect(r.adjustment.reason).toBe("first attempt");
    expect(r.adjustment.adjustedBy).toBe("u-1");
  });

  it("second override APPENDS (does not overwrite prior row) — audit reconstructable", () => {
    const before = unrec(45);
    const first = applyFeeOverride(before, { fees: { finalValueFee: 10 }, reason: "guess" }, "u-1");
    const second = applyFeeOverride(first.entry, { fees: { finalValueFee: 13 }, reason: "got receipt" }, "u-1");
    expect(second.entry.feeAdjustments).toHaveLength(2);
    expect(second.entry.feeAdjustments![0].newValues.finalValueFee).toBe(10);
    expect(second.entry.feeAdjustments![1].priorValues.finalValueFee).toBe(10);
    expect(second.entry.feeAdjustments![1].newValues.finalValueFee).toBe(13);
  });

  it("snapshot preserves prior reconciledVia (eg ebay_finances → manual_override transitions tracked)", () => {
    const before: LedgerEntryForErp = {
      ...unrec(10),
      needsReconciliation: false,
      reconciledVia: "ebay_finances",
      finalValueFee: 9,
    };
    const r = applyFeeOverride(before, { fees: { finalValueFee: 13 }, reason: "audit" }, "u-1");
    expect(r.adjustment.priorValues.reconciledVia).toBe("ebay_finances");
    expect(r.adjustment.newValues.reconciledVia).toBe("manual_override");
  });
});
