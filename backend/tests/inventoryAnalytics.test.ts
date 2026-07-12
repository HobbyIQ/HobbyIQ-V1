// CF-INVENTORY-TURNOVER-AGING (2026-07-12) — analytics service tests.
// Focus: aging bucket bounds, oldest-N sort, turnover proxy math, guards
// against empty portfolios + missing acquisition dates.

import { describe, it, expect } from "vitest";
import { buildInventoryAnalytics } from "../src/services/portfolioiq/inventoryAnalytics.service";
import type { PortfolioHolding } from "../src/types/portfolioiq.types";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service";

const NOW = new Date("2026-07-12T00:00:00Z");

function h(overrides: Partial<PortfolioHolding> & { id: string }): PortfolioHolding {
  return {
    playerName: "P",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    ...overrides,
  } as PortfolioHolding;
}

function ledgerEntry(overrides: Partial<LedgerEntryForErp>): LedgerEntryForErp {
  return {
    id: "L",
    userId: "u",
    holdingId: "h",
    playerName: "P",
    cardTitle: "C",
    quantitySold: 1,
    unitSalePrice: 200,
    grossProceeds: 200,
    fees: 0,
    tax: 0,
    shipping: 0,
    netProceeds: 200,
    costBasisSold: 100,
    realizedProfitLoss: 100,
    realizedProfitLossPct: 100,
    soldAt: "2026-07-01T00:00:00Z",
    ...overrides,
  } as LedgerEntryForErp;
}

describe("buildInventoryAnalytics", () => {
  it("empty portfolio → zero counts, null avg/median, no oldest", () => {
    const a = buildInventoryAnalytics({}, [], { now: NOW });
    expect(a.totals.holdingCount).toBe(0);
    expect(a.totals.totalCostBasis).toBe(0);
    expect(a.aging.avgDaysOnHand).toBeNull();
    expect(a.aging.medianDaysOnHand).toBeNull();
    expect(a.oldestHoldings).toEqual([]);
    // buckets stable shape even on empty
    expect(a.aging.buckets).toHaveLength(5);
    expect(a.aging.buckets.every((b) => b.count === 0 && b.costBasis === 0)).toBe(true);
    // turnover null when no inventory
    expect(a.turnover.turnoverProxy).toBeNull();
  });

  it("bucketizes holdings by days-since-purchaseDate", () => {
    // Prefer purchaseDate. Ages relative to NOW=2026-07-12.
    const holdings = {
      h1: h({ id: "h1", purchaseDate: "2026-07-01T00:00:00Z", totalCostBasis: 100 }), // 11 days
      h2: h({ id: "h2", purchaseDate: "2026-06-01T00:00:00Z", totalCostBasis: 200 }), // 41 days
      h3: h({ id: "h3", purchaseDate: "2026-01-01T00:00:00Z", totalCostBasis: 500 }), // 192 days
      h4: h({ id: "h4", purchaseDate: "2025-01-01T00:00:00Z", totalCostBasis: 750 }), // 557 days
    };
    const a = buildInventoryAnalytics(holdings, [], { now: NOW });
    expect(a.totals.holdingCount).toBe(4);
    expect(a.totals.totalCostBasis).toBe(1550);

    const bucketMap = new Map(a.aging.buckets.map((b) => [b.label, b]));
    expect(bucketMap.get("0-30")!.count).toBe(1);   // h1
    expect(bucketMap.get("0-30")!.costBasis).toBe(100);
    expect(bucketMap.get("30-90")!.count).toBe(1);  // h2
    expect(bucketMap.get("90-180")!.count).toBe(0);
    expect(bucketMap.get("180-365")!.count).toBe(1); // h3
    expect(bucketMap.get("365+")!.count).toBe(1);   // h4
  });

  it("falls back through purchaseDate → addedAt → lastUpdated", () => {
    const holdings = {
      h1: { id: "h1", quantity: 1, purchasePrice: 100, totalCostBasis: 100, addedAt: "2026-07-01T00:00:00Z" } as any,
      h2: { id: "h2", quantity: 1, purchasePrice: 100, totalCostBasis: 100, lastUpdated: "2026-06-15T00:00:00Z" } as any,
    };
    const a = buildInventoryAnalytics(holdings, [], { now: NOW });
    // Both should be aged and bucketed
    expect(a.oldestHoldings).toHaveLength(2);
    // The one with older acquisition date is first
    expect(a.oldestHoldings[0].holdingId).toBe("h2");
  });

  it("skips aging (but counts in totals) for holdings with no timestamps", () => {
    const holdings = {
      h1: { id: "h1", quantity: 1, purchasePrice: 100, totalCostBasis: 100 } as any,
      h2: h({ id: "h2", purchaseDate: "2026-01-01T00:00:00Z", totalCostBasis: 500 }),
    };
    const a = buildInventoryAnalytics(holdings, [], { now: NOW });
    expect(a.totals.holdingCount).toBe(2);       // both count
    expect(a.totals.totalCostBasis).toBe(600);   // both cost
    expect(a.oldestHoldings).toHaveLength(1);    // only h2 is aged
    expect(a.aging.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it("oldestHoldings capped at 10, sorted desc by daysInInventory", () => {
    const holdings: Record<string, PortfolioHolding> = {};
    for (let i = 0; i < 15; i++) {
      const date = new Date(NOW.getTime() - (i + 1) * 24 * 3600 * 1000).toISOString();
      holdings[`h${i}`] = h({ id: `h${i}`, purchaseDate: date, totalCostBasis: 100 });
    }
    const a = buildInventoryAnalytics(holdings, [], { now: NOW });
    expect(a.oldestHoldings).toHaveLength(10);
    // Oldest first
    expect(a.oldestHoldings[0].daysInInventory).toBe(15);
    expect(a.oldestHoldings[9].daysInInventory).toBe(6);
  });

  it("avgDaysOnHand + medianDaysOnHand math", () => {
    const holdings = {
      a: h({ id: "a", purchaseDate: new Date(NOW.getTime() - 10 * 86400000).toISOString() }),
      b: h({ id: "b", purchaseDate: new Date(NOW.getTime() - 30 * 86400000).toISOString() }),
      c: h({ id: "c", purchaseDate: new Date(NOW.getTime() - 60 * 86400000).toISOString() }),
    };
    const a = buildInventoryAnalytics(holdings, [], { now: NOW });
    // Sorted days: [10, 30, 60] → median 30, avg 33.33 → 33 after rounding
    expect(a.aging.medianDaysOnHand).toBe(30);
    expect(a.aging.avgDaysOnHand).toBe(33);
  });

  it("turnover proxy: costBasisSold in window / current inventory cost", () => {
    const holdings = {
      x: h({ id: "x", purchaseDate: "2026-07-01T00:00:00Z", totalCostBasis: 1000 }),
    };
    const ledger = [
      ledgerEntry({ soldAt: "2026-06-15T00:00:00Z", costBasisSold: 500 }),
      ledgerEntry({ soldAt: "2026-07-05T00:00:00Z", costBasisSold: 700 }),
    ];
    const a = buildInventoryAnalytics(holdings, ledger, {
      now: NOW,
      from: "2026-07-01",
      to: "2026-07-31",
    });
    // Only the July entry ($700) is in window
    expect(a.turnover.costBasisSold).toBe(700);
    expect(a.turnover.currentInventoryCost).toBe(1000);
    expect(a.turnover.turnoverProxy).toBe(0.7); // 700 / 1000
  });

  it("turnover excludes unreconciled entries", () => {
    const holdings = { x: h({ id: "x", purchaseDate: "2026-07-01T00:00:00Z", totalCostBasis: 1000 }) };
    const ledger = [
      ledgerEntry({ soldAt: "2026-07-05T00:00:00Z", costBasisSold: 500 }),
      ledgerEntry({ soldAt: "2026-07-06T00:00:00Z", costBasisSold: 300, needsReconciliation: true }),
    ];
    const a = buildInventoryAnalytics(holdings, ledger, { now: NOW, from: "2026-07-01", to: "2026-07-31" });
    expect(a.turnover.costBasisSold).toBe(500);  // unreconciled excluded
  });

  it("turnover excludes regrade entries (action !== 'sale')", () => {
    const holdings = { x: h({ id: "x", purchaseDate: "2026-07-01T00:00:00Z", totalCostBasis: 1000 }) };
    const ledger = [
      ledgerEntry({ soldAt: "2026-07-05T00:00:00Z", costBasisSold: 500 }),
      ledgerEntry({ soldAt: "2026-07-06T00:00:00Z", costBasisSold: 999, action: "regrade" } as any),
    ];
    const a = buildInventoryAnalytics(holdings, ledger, { now: NOW, from: "2026-07-01", to: "2026-07-31" });
    expect(a.turnover.costBasisSold).toBe(500);  // regrade excluded
  });
});
