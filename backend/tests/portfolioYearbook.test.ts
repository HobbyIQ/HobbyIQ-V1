// CF-SOCIAL-SURFACES (Drew, 2026-07-17): pinning tests for the Portfolio
// Yearbook math. Pure — no Cosmos, no I/O.

import { describe, it, expect } from "vitest";
import {
  computeYearbook,
  parsePeriod,
  YEARBOOK_MIN_HELD_MULTIPLIER,
  YEARBOOK_MAX_HELD_MULTIPLIER,
  YEARBOOK_TOP_N,
} from "../src/services/portfolioiq/portfolioYearbook.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import type { PortfolioLedgerEntry } from "../src/services/portfolioiq/portfolioStore.service.js";

// ── Fixture builders ────────────────────────────────────────────────────────

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: overrides.id ?? "h",
    playerName: overrides.playerName ?? "Player",
    cardTitle: overrides.cardTitle ?? "Card",
    purchasePrice: overrides.purchasePrice ?? 100,
    fairMarketValue: overrides.fairMarketValue ?? 200,
    quantity: overrides.quantity ?? 1,
    purchaseDate: overrides.purchaseDate ?? "2026-01-15T00:00:00Z",
    ...overrides,
  } as PortfolioHolding;
}

function ledgerEntry(overrides: Partial<PortfolioLedgerEntry> = {}): PortfolioLedgerEntry {
  return {
    id: overrides.id ?? "l1",
    userId: "u1",
    holdingId: overrides.holdingId ?? "h",
    playerName: overrides.playerName ?? "Player",
    cardTitle: overrides.cardTitle ?? "Card",
    quantitySold: overrides.quantitySold ?? 1,
    unitSalePrice: overrides.unitSalePrice ?? 150,
    grossProceeds: overrides.grossProceeds ?? 150,
    fees: overrides.fees ?? 0,
    tax: overrides.tax ?? 0,
    shipping: overrides.shipping ?? 0,
    netProceeds: overrides.netProceeds ?? 150,
    costBasisSold: overrides.costBasisSold ?? 100,
    realizedProfitLoss: overrides.realizedProfitLoss ?? 50,
    realizedProfitLossPct: overrides.realizedProfitLossPct ?? 50,
    soldAt: overrides.soldAt ?? "2026-06-01T00:00:00Z",
    ...overrides,
  } as PortfolioLedgerEntry;
}

// ── Constants + parsePeriod ─────────────────────────────────────────────────

describe("Yearbook constants pinned", () => {
  it("pins bounds", () => {
    expect(YEARBOOK_MIN_HELD_MULTIPLIER).toBe(0.5);
    expect(YEARBOOK_MAX_HELD_MULTIPLIER).toBe(3.0);
    expect(YEARBOOK_TOP_N).toBe(3);
  });
});

describe("parsePeriod", () => {
  it("annual window: 2026 → [2026-01-01, 2027-01-01)", () => {
    const p = parsePeriod(2026);
    expect(p.label).toBe("2026");
    expect(p.windowStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(p.windowEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("Q4 spans Oct-Dec and rolls to next year", () => {
    const p = parsePeriod(2026, "Q4");
    expect(p.label).toBe("2026-Q4");
    expect(p.windowStart.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p.windowEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("Q1 spans Jan-Mar", () => {
    const p = parsePeriod(2026, "Q1");
    expect(p.windowStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(p.windowEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("throws on invalid year", () => {
    expect(() => parsePeriod(1999)).toThrow(/invalid year/);
    expect(() => parsePeriod(NaN)).toThrow();
  });
});

// ── Aggregation ─────────────────────────────────────────────────────────────

describe("computeYearbook — aggregation", () => {
  const period = parsePeriod(2026);

  it("sums totalRealizedGainUsd from ledger entries in-window", () => {
    const ledger = [
      ledgerEntry({ id: "l1", realizedProfitLoss: 100, soldAt: "2026-03-01T00:00:00Z" }),
      ledgerEntry({ id: "l2", realizedProfitLoss: 200, soldAt: "2026-08-01T00:00:00Z" }),
      // out of window — must be excluded
      ledgerEntry({ id: "l3", realizedProfitLoss: 999, soldAt: "2025-12-31T23:00:00Z" }),
    ];
    const y = computeYearbook({ period, holdings: [], ledger });
    expect(y.totalRealizedGainUsd).toBe(300);
    expect(y.cardsSold).toBe(2);
  });

  it("excludes regrade audit entries from realized totals", () => {
    const ledger = [
      ledgerEntry({ id: "sale", realizedProfitLoss: 50 }),
      ledgerEntry({
        id: "regrade",
        action: "regrade",
        realizedProfitLoss: 0,   // regrade entries carry 0 P&L but we filter by action too
        grossProceeds: 0,
      }),
    ];
    const y = computeYearbook({ period, holdings: [], ledger });
    expect(y.totalRealizedGainUsd).toBe(50);
    expect(y.cardsSold).toBe(1);   // regrade not counted
  });

  it("computes totalUnrealizedGainUsd across all held rows", () => {
    const holdings = [
      holding({ id: "h1", purchasePrice: 100, fairMarketValue: 200 }),   // +100
      holding({ id: "h2", purchasePrice: 50, fairMarketValue: 200, quantity: 2 }),  // +300 (basis 100, current 400)
    ];
    const y = computeYearbook({ period, holdings, ledger: [] });
    expect(y.totalUnrealizedGainUsd).toBe(400);
    expect(y.totalCurrentValue).toBe(600);
    expect(y.totalCostBasis).toBe(200);
  });

  it("counts cardsBought as purchases inside the window", () => {
    const holdings = [
      holding({ id: "in1", purchaseDate: "2026-03-15T00:00:00Z" }),
      holding({ id: "in2", purchaseDate: "2026-11-01T00:00:00Z" }),
      holding({ id: "out", purchaseDate: "2025-11-01T00:00:00Z" }),
      holding({ id: "nodate", purchaseDate: undefined }),
    ];
    const y = computeYearbook({ period, holdings, ledger: [] });
    expect(y.cardsBought).toBe(2);
  });
});

// ── Rankings ────────────────────────────────────────────────────────────────

describe("computeYearbook — rankings", () => {
  const period = parsePeriod(2026);

  it("topPerformers = top 3 by gainPct DESC across realized + unrealized", () => {
    const holdings = [
      holding({ id: "u1", playerName: "Mega Up", purchasePrice: 100, fairMarketValue: 500 }),   // +400%
      holding({ id: "u2", playerName: "Small Up", purchasePrice: 100, fairMarketValue: 110 }), // +10%
    ];
    const ledger = [
      ledgerEntry({
        id: "r1", playerName: "Sold Winner",
        realizedProfitLoss: 300, realizedProfitLossPct: 300,
        costBasisSold: 100, grossProceeds: 400,
      }),
      ledgerEntry({
        id: "r2", playerName: "Meh Winner",
        realizedProfitLoss: 20, realizedProfitLossPct: 20,
        costBasisSold: 100, grossProceeds: 120,
      }),
    ];
    const y = computeYearbook({ period, holdings, ledger });
    expect(y.topPerformers.length).toBe(3);
    expect(y.topPerformers[0].player).toBe("Mega Up");     // 400%
    expect(y.topPerformers[1].player).toBe("Sold Winner"); // 300%
    expect(y.topPerformers[2].player).toBe("Meh Winner");  // 20%
  });

  it("biggestMisses only includes rows with gainPct < 0", () => {
    const holdings = [
      holding({ id: "u1", playerName: "Winner", purchasePrice: 100, fairMarketValue: 200 }),
      holding({ id: "u2", playerName: "Loser 1", purchasePrice: 100, fairMarketValue: 70 }),  // -30%
    ];
    const ledger = [
      ledgerEntry({
        id: "r1", playerName: "Sold Loser",
        realizedProfitLoss: -50, realizedProfitLossPct: -50,
        costBasisSold: 100, grossProceeds: 50,
      }),
    ];
    const y = computeYearbook({ period, holdings, ledger });
    expect(y.biggestMisses.length).toBe(2);
    expect(y.biggestMisses[0].player).toBe("Sold Loser");   // -50%
    expect(y.biggestMisses[1].player).toBe("Loser 1");       // -30%
    // Winner (positive gain) never appears in misses
    expect(y.biggestMisses.map((r) => r.player)).not.toContain("Winner");
  });

  it("empty misses when no losers", () => {
    const holdings = [holding({ purchasePrice: 100, fairMarketValue: 200 })];
    const y = computeYearbook({ period, holdings, ledger: [] });
    expect(y.biggestMisses).toEqual([]);
  });

  it("caps to YEARBOOK_TOP_N (3) even with more candidates", () => {
    const holdings = Array.from({ length: 10 }, (_, i) =>
      holding({
        id: `h${i}`,
        playerName: `Player ${i}`,
        purchasePrice: 100,
        fairMarketValue: 100 + i * 10,   // ascending gains
      }),
    );
    const y = computeYearbook({ period, holdings, ledger: [] });
    expect(y.topPerformers.length).toBe(3);
  });
});

// ── Counterfactual ──────────────────────────────────────────────────────────

describe("computeYearbook — whatIfHeldAll", () => {
  const period = parsePeriod(2026);

  it("counterfactualCurrentValue = totalCurrentValue + soldProceeds × heldMultiplier", () => {
    // Held: basis 100, current 200 → heldMultiplier = 2.0
    // Sold: grossProceeds 100. Counterfactual sold value = 100 × 2.0 = 200.
    // counterfactualCurrentValue = 200 + 200 = 400.
    // opportunityCostUsd = 200 (counterfactual) - 100 (proceeds) = 100.
    const holdings = [
      holding({ id: "held", purchasePrice: 100, fairMarketValue: 200 }),
    ];
    const ledger = [
      ledgerEntry({
        id: "sold", grossProceeds: 100, costBasisSold: 100,
        realizedProfitLoss: 0, realizedProfitLossPct: 0,
      }),
    ];
    const y = computeYearbook({ period, holdings, ledger });
    expect(y.whatIfHeldAll.counterfactualCurrentValue).toBe(400);
    expect(y.whatIfHeldAll.opportunityCostUsd).toBe(100);
    expect(y.whatIfHeldAll.note).toMatch(/would be worth ~\$400/);
  });

  it("clamps held multiplier to MAX (thin portfolio in bull run doesn't 10x)", () => {
    // Held: basis 10, current 500 → raw multiplier = 50.0. Clamped to 3.0.
    // Sold: grossProceeds 100. Counterfactual = 100 × 3.0 = 300.
    // opportunityCostUsd = 300 - 100 = 200.
    const holdings = [
      holding({ id: "held", purchasePrice: 10, fairMarketValue: 500 }),
    ];
    const ledger = [
      ledgerEntry({ id: "sold", grossProceeds: 100, costBasisSold: 100 }),
    ];
    const y = computeYearbook({ period, holdings, ledger });
    expect(y.whatIfHeldAll.opportunityCostUsd).toBe(200);
  });

  it("clamps held multiplier to MIN in a bear market (avoids depressing sold value to zero)", () => {
    // Held: basis 100, current 10 → raw multiplier = 0.1. Clamped to 0.5.
    // Sold: grossProceeds 100. Counterfactual = 100 × 0.5 = 50.
    // opportunityCostUsd = 50 - 100 = -50 (i.e. sold was the right call).
    const holdings = [
      holding({ id: "held", purchasePrice: 100, fairMarketValue: 10 }),
    ];
    const ledger = [
      ledgerEntry({ id: "sold", grossProceeds: 100, costBasisSold: 100 }),
    ];
    const y = computeYearbook({ period, holdings, ledger });
    expect(y.whatIfHeldAll.opportunityCostUsd).toBe(-50);
  });

  it("note explains no-sales case", () => {
    const y = computeYearbook({ period, holdings: [], ledger: [] });
    expect(y.whatIfHeldAll.note).toMatch(/no sales/i);
    expect(y.cardsSold).toBe(0);
  });
});

// ── Boundary cases ──────────────────────────────────────────────────────────

describe("computeYearbook — window boundary", () => {
  it("sale at 2026-12-31T23:59:59Z lands in 2026", () => {
    const y = computeYearbook({
      period: parsePeriod(2026),
      holdings: [],
      ledger: [
        ledgerEntry({
          id: "eoy",
          soldAt: "2026-12-31T23:59:59Z",
          realizedProfitLoss: 42,
        }),
      ],
    });
    expect(y.totalRealizedGainUsd).toBe(42);
  });

  it("sale at 2027-01-01T00:00:00Z (window edge) is EXCLUDED", () => {
    const y = computeYearbook({
      period: parsePeriod(2026),
      holdings: [],
      ledger: [
        ledgerEntry({
          id: "boundary",
          soldAt: "2027-01-01T00:00:00Z",
          realizedProfitLoss: 42,
        }),
      ],
    });
    expect(y.totalRealizedGainUsd).toBe(0);
  });

  it("Q4 boundary: Oct 1 in, Sep 30 out", () => {
    const q4 = parsePeriod(2026, "Q4");
    const y = computeYearbook({
      period: q4,
      holdings: [],
      ledger: [
        ledgerEntry({ id: "in", soldAt: "2026-10-01T00:00:00Z", realizedProfitLoss: 10 }),
        ledgerEntry({ id: "out", soldAt: "2026-09-30T23:59:59Z", realizedProfitLoss: 99 }),
      ],
    });
    expect(y.totalRealizedGainUsd).toBe(10);
  });
});
