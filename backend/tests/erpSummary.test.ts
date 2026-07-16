// CF-ERP-SUMMARY (2026-07-11) — unit tests for the dashboard aggregation.
// Locks the top-mover selection, the change30d threading, and the priced-
// only filter that prevents estimated / missing holdings from lying about
// gains/losses.

import { describe, it, expect } from "vitest";
import { composeErpSummary } from "../src/services/portfolioiq/erpSummary.service";
import type { PortfolioHolding } from "../src/types/portfolioiq.types";

const NOW = Date.parse("2026-07-11T18:00:00Z");

// ─── Fixture helpers ────────────────────────────────────────────────────────

let seqId = 0;
function h(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  seqId += 1;
  return {
    id: `holding-${seqId}`,
    playerName: "Player",
    year: 2020,
    brand: "Topps",
    quantity: 1,
    purchasePrice: 100,
    fairMarketValue: 150,
    lastUpdated: "2026-07-11T12:00:00Z",
    // Fields required by the type but not exercised in these tests
    ...(overrides as PortfolioHolding),
  } as PortfolioHolding;
}

describe("composeErpSummary", () => {
  it("empty portfolio returns zeros + empty arrays (no crash)", () => {
    const r = composeErpSummary([], [], {}, [], NOW);
    expect(r.totals.holdingCount).toBe(0);
    expect(r.totals.snapshotValue).toBe(0);
    expect(r.fullPosition.total).toBe(0);
    expect(r.topGainers).toEqual([]);
    expect(r.topLosers).toEqual([]);
    expect(r.valueTrend30d).toEqual([]);
    expect(r.change30d).toBeNull();
  });

  it("top-mover filter excludes holdings with null snapshotValue", () => {
    const holdings = [
      h({ playerName: "Priced Winner", purchasePrice: 100, fairMarketValue: 200 }),
      h({ playerName: "Unpriced Ghost", purchasePrice: 50, fairMarketValue: null as unknown as number }),
    ];
    const holdingsById = Object.fromEntries(holdings.map((h) => [h.id, h]));
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    // Only priced winner shows up in gainers
    expect(r.topGainers).toHaveLength(1);
    expect(r.topGainers[0].playerName).toBe("Priced Winner");
    // Unpriced ghost never surfaces in either list — an unrealizedGain we
    // can't measure is not a signal, it's a lie.
    expect(r.topGainers.every((g) => g.playerName !== "Unpriced Ghost")).toBe(true);
    expect(r.topLosers.every((l) => l.playerName !== "Unpriced Ghost")).toBe(true);
  });

  it("top gainers sorted by unrealizedPct desc, capped at 5", () => {
    const holdings = Array.from({ length: 8 }, (_, i) =>
      h({
        playerName: `Player ${i}`,
        purchasePrice: 100,
        // 10%, 20%, 30% ... 80% winners
        fairMarketValue: 100 + (i + 1) * 10,
      }),
    );
    const holdingsById = Object.fromEntries(holdings.map((h) => [h.id, h]));
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    expect(r.topGainers).toHaveLength(5);
    // Should be the top 5 pcts descending: 80, 70, 60, 50, 40
    expect(r.topGainers.map((g) => Math.round(g.unrealizedPct))).toEqual([
      80, 70, 60, 50, 40,
    ]);
  });

  it("top losers sorted by unrealizedPct ascending, capped at 5", () => {
    const holdings = Array.from({ length: 8 }, (_, i) =>
      h({
        playerName: `Loser ${i}`,
        purchasePrice: 100,
        // -10%, -20%, -30% ... -80%
        fairMarketValue: 100 - (i + 1) * 10,
      }),
    );
    const holdingsById = Object.fromEntries(holdings.map((h) => [h.id, h]));
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    expect(r.topLosers).toHaveLength(5);
    // Worst 5 losers ascending pct: -80, -70, -60, -50, -40
    expect(r.topLosers.map((l) => Math.round(l.unrealizedPct))).toEqual([
      -80, -70, -60, -50, -40,
    ]);
  });

  it("gainers exclude zero-pct rows (a 0% holding is neither winning nor losing)", () => {
    const holdings = [
      h({ playerName: "Flat", purchasePrice: 100, fairMarketValue: 100 }),
      h({ playerName: "Winner", purchasePrice: 100, fairMarketValue: 110 }),
    ];
    const holdingsById = Object.fromEntries(holdings.map((h) => [h.id, h]));
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    expect(r.topGainers.map((g) => g.playerName)).toEqual(["Winner"]);
    expect(r.topLosers).toEqual([]);
  });

  it("change30d fires from value history when snapshots span the window", () => {
    const holdings = [h({ purchasePrice: 100, fairMarketValue: 150 })];
    const holdingsById = { [holdings[0].id]: holdings[0] };
    const valueHistory = [
      { userId: "u", date: "2026-06-01", displayableTotal: 100, id: "s1" } as any,
      { userId: "u", date: "2026-06-11", displayableTotal: 120, id: "s2" } as any,
      { userId: "u", date: "2026-07-11", displayableTotal: 150, id: "s3" } as any,
    ];
    const r = composeErpSummary(holdings, [], holdingsById, valueHistory, NOW);
    // Latest ($150) vs baseline ≤30d ago ($120 on 6/11) → +30 absolute, +25%
    expect(r.change30d).not.toBeNull();
    expect(r.change30d!.absolute).toBeCloseTo(30);
    expect(r.change30d!.percent).toBeCloseTo(25);
    expect(r.change30d!.rangeWeak).toBe(false);
  });

  it("valueTrend30d truncates to the last 30 snapshots (not last 30 days)", () => {
    const valueHistory = Array.from({ length: 45 }, (_, i) => ({
      userId: "u",
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      displayableTotal: 100 + i,
      id: `s${i}`,
    }));
    const r = composeErpSummary([], [], {}, valueHistory as any, NOW);
    expect(r.valueTrend30d).toHaveLength(30);
    // Should be the LAST 30, so first entry is snapshot 16 (100+15=115)
    expect(r.valueTrend30d[0].displayableTotal).toBe(115);
    expect(r.valueTrend30d[29].displayableTotal).toBe(144);
  });

  it("fullPosition.total = ytdRealized + unrealized (composition math)", () => {
    // 1 winner: $100 → $150 = +$50 unrealized
    const holdings = [h({ purchasePrice: 100, fairMarketValue: 150 })];
    const holdingsById = { [holdings[0].id]: holdings[0] };
    // No ledger entries → ytdRealized = 0
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    expect(r.fullPosition.realizedYtd).toBe(0);
    expect(r.fullPosition.unrealized).toBeCloseTo(50);
    expect(r.fullPosition.total).toBeCloseTo(50);
  });

  it("asOf reflects the freshest holding.lastUpdated when history is empty", () => {
    const holdings = [h({ lastUpdated: "2026-07-10T09:15:00Z" })];
    const holdingsById = { [holdings[0].id]: holdings[0] };
    const r = composeErpSummary(holdings, [], holdingsById, [], NOW);
    // buildValuation sets asOf to the freshest holding.lastUpdated
    expect(r.asOf).toBe("2026-07-10T09:15:00.000Z");
  });
});
