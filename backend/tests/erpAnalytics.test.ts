// CF-ERP-EXPANSION-#2 (2026-06-03): pure analytics service coverage.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import {
  aggregateAnalytics,
  aggregateTimeseries,
} from "../src/services/portfolioiq/erpAnalytics.service.js";
import type {
  HoldingsById,
  LedgerEntryForErp,
} from "../src/services/portfolioiq/erpReconciliation.service.js";

function entry(over: Partial<LedgerEntryForErp> = {}): LedgerEntryForErp {
  return {
    id: "L",
    userId: "u",
    holdingId: "h",
    playerName: "Skenes",
    cardTitle: "Card",
    quantitySold: 1,
    unitSalePrice: 100,
    grossProceeds: 100,
    fees: 10,
    tax: 0,
    shipping: 0,
    netProceeds: 90,
    costBasisSold: 50,
    realizedProfitLoss: 40,
    realizedProfitLossPct: 80,
    soldAt: "2026-05-10T12:00:00Z",
    source: "manual",
    ...over,
  };
}

const HOLDINGS: HoldingsById = {
  h: {
    id: "h",
    playerName: "Skenes",
    setName: "Topps Chrome",
    purchaseDate: "2025-09-10",
    gradeCompany: "PSA",
    gradeValue: 10,
  } as PortfolioHolding,
};

describe("aggregateAnalytics", () => {
  it("excludes unreconciled rows from totals; surfaces excluded counter", () => {
    const entries = [
      entry({ id: "L1" }),
      entry({ id: "L2", needsReconciliation: true }),
    ];
    const r = aggregateAnalytics(entries, HOLDINGS, { groupBy: "player" });
    expect(r.totals.entryCount).toBe(1);
    expect(r.excluded.unreconciledCount).toBe(1);
  });

  it("computes margin% + ROI% + avg-days-to-sale correctly", () => {
    const entries = [entry()];
    const r = aggregateAnalytics(entries, HOLDINGS, { groupBy: "player" });
    expect(r.totals.marginPct).toBeCloseTo(40, 1);
    expect(r.totals.roiPct).toBeCloseTo(80, 1);
    // 2025-09-10 → 2026-05-10 ≈ 242d
    expect(r.totals.avgDaysToSale).toBeGreaterThanOrEqual(240);
    expect(r.totals.avgDaysToSale).toBeLessThanOrEqual(245);
  });

  it("groupBy=salesChannel buckets by channel + (unknown) for legacy entries", () => {
    const entries = [
      entry({ id: "L1", salesChannel: "whatnot" }),
      entry({ id: "L2", source: "ebay", finalValueFee: 5, paymentProcessingFee: 3, otherFees: 0, promotedListingFee: 0, adFee: 0, actualShippingCost: 2, fees: 0 }),
      // Legacy manual (no channel, no source override) → unknown
      entry({ id: "L3" }),
    ];
    const r = aggregateAnalytics(entries, HOLDINGS, { groupBy: "salesChannel" });
    const keys = r.groups.map((g) => g.key).sort();
    expect(keys).toEqual(["ebay", "unknown", "whatnot"]);
  });

  it("groupBy=paymentMethod buckets ebay legacy → ebay_managed", () => {
    const entries = [
      entry({ id: "L1", source: "ebay" }),
      entry({ id: "L2", paymentMethod: "venmo" }),
    ];
    const r = aggregateAnalytics(entries, HOLDINGS, { groupBy: "paymentMethod" });
    const labels = r.groups.map((g) => g.label).sort();
    expect(labels).toEqual(["ebay_managed", "venmo"]);
  });

  it("avgDaysToSale is null when no entry has acquisition date", () => {
    const entries = [entry({ id: "L1", holdingId: "missing" })];
    const r = aggregateAnalytics(entries, {}, { groupBy: "player" });
    expect(r.totals.avgDaysToSale).toBeNull();
  });

  it("sellThroughPct ratio: sales / (current holdings + sales)", () => {
    // 2 holdings + 1 sale = 33% sell-through
    const entries = [entry()];
    const holdings: HoldingsById = {
      h: HOLDINGS.h,
      h2: { id: "h2", playerName: "Acuna" } as PortfolioHolding,
    };
    const r = aggregateAnalytics(entries, holdings, { groupBy: "player" });
    expect(r.totals.sellThroughPct).toBeGreaterThan(0);
    expect(r.totals.sellThroughPct).toBeLessThanOrEqual(100);
  });
});

describe("aggregateTimeseries", () => {
  it("buckets by month, fills missing buckets with zeros over a from/to window", () => {
    const entries = [
      entry({ id: "L1", soldAt: "2026-03-15T00:00:00Z", grossProceeds: 50 }),
      entry({ id: "L2", soldAt: "2026-05-15T00:00:00Z", grossProceeds: 100 }),
    ];
    const r = aggregateTimeseries(entries, {
      from: "2026-03-01",
      to: "2026-06-30",
      bucket: "month",
    });
    expect(r.points.map((p) => p.bucket)).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
    expect(r.points[0].totalGross).toBe(50);
    expect(r.points[1].totalGross).toBe(0);
    expect(r.points[2].totalGross).toBe(100);
    expect(r.points[3].totalGross).toBe(0);
  });

  it("buckets by quarter", () => {
    const entries = [
      entry({ id: "L1", soldAt: "2026-02-15T00:00:00Z", grossProceeds: 25 }),
      entry({ id: "L2", soldAt: "2026-05-15T00:00:00Z", grossProceeds: 75 }),
    ];
    const r = aggregateTimeseries(entries, {
      from: "2026-01-01",
      to: "2026-06-30",
      bucket: "quarter",
    });
    expect(r.points.map((p) => p.bucket)).toEqual(["2026-Q1", "2026-Q2"]);
    expect(r.points[0].totalGross).toBe(25);
    expect(r.points[1].totalGross).toBe(75);
  });

  it("unreconciled excluded from buckets, surfaced in excluded counter", () => {
    const entries = [
      entry({ id: "L1", soldAt: "2026-05-10T00:00:00Z" }),
      entry({ id: "L2", soldAt: "2026-05-15T00:00:00Z", needsReconciliation: true }),
    ];
    const r = aggregateTimeseries(entries, { bucket: "month" });
    expect(r.excluded.unreconciledCount).toBe(1);
    expect(r.points[0].entryCount).toBe(1);
  });
});
