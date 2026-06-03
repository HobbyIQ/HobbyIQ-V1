// CF-ERP-EXPANSION-#3 (2026-06-03): valuation pure-service coverage.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import { buildValuation } from "../src/services/portfolioiq/erpValuation.service.js";
import type { LedgerEntryForErp } from "../src/services/portfolioiq/erpReconciliation.service.js";

const NOW = Date.parse("2026-06-03T12:00:00.000Z");

function h(over: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    id: "h",
    playerName: "Skenes",
    purchasePrice: 100,
    totalCostBasis: 100,
    quantity: 1,
    fairMarketValue: 150,
    lastUpdated: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(), // 6h ago → fresh
    ...over,
  } as PortfolioHolding;
}

describe("buildValuation — freshness", () => {
  it("labels ≤ 12h as fresh, 12-72h as stale, no FMV as missing", () => {
    const holdings: PortfolioHolding[] = [
      h({ id: "fresh-1" }),
      h({
        id: "stale-1",
        lastUpdated: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      }),
      h({ id: "missing-1", fairMarketValue: undefined }),
    ];
    const v = buildValuation(holdings, [], Object.fromEntries(holdings.map((x) => [x.id, x])), NOW);
    const byId = new Map(v.holdings.map((row) => [row.id, row.freshness]));
    expect(byId.get("fresh-1")).toBe("fresh");
    expect(byId.get("stale-1")).toBe("stale");
    expect(byId.get("missing-1")).toBe("missing");
    expect(v.totals.freshCount).toBe(1);
    expect(v.totals.staleCount).toBe(1);
    expect(v.totals.missingCount).toBe(1);
  });
});

describe("buildValuation — unrealized math", () => {
  it("snapshotValue = fairMarketValue × quantity; unrealizedGainLoss = snapshot − cost", () => {
    const holdings: PortfolioHolding[] = [
      h({ id: "x", purchasePrice: 100, totalCostBasis: 100, quantity: 2, fairMarketValue: 120 }),
    ];
    const v = buildValuation(holdings, [], { x: holdings[0] }, NOW);
    expect(v.totals.snapshotValue).toBe(240);  // 120 × 2
    expect(v.totals.costBasis).toBe(100);
    expect(v.totals.unrealizedGainLoss).toBe(140);
  });

  it("missing-FMV holdings NOT folded into snapshotValue (honest gap)", () => {
    const holdings: PortfolioHolding[] = [
      h({ id: "x", totalCostBasis: 100, fairMarketValue: 150 }),
      h({ id: "y", totalCostBasis: 100, fairMarketValue: undefined }),
    ];
    const v = buildValuation(holdings, [], Object.fromEntries(holdings.map((x) => [x.id, x])), NOW);
    expect(v.totals.snapshotValue).toBe(150);
    expect(v.totals.missingCount).toBe(1);
    // missing row's unrealizedGainLoss is null, not 0.
    const missing = v.holdings.find((r) => r.id === "y");
    expect(missing?.unrealizedGainLoss).toBeNull();
  });

  it("fullPosition: total = realizedYtd + unrealized; note flags excluded unreconciled", () => {
    const holdings: PortfolioHolding[] = [h({ id: "x" })];
    const ledger: LedgerEntryForErp[] = [
      {
        id: "L1",
        userId: "u",
        holdingId: "h-sold-1",
        playerName: "Skenes",
        cardTitle: "Card",
        quantitySold: 1,
        unitSalePrice: 200,
        grossProceeds: 200,
        fees: 20,
        tax: 0,
        shipping: 0,
        netProceeds: 180,
        costBasisSold: 100,
        realizedProfitLoss: 80,
        realizedProfitLossPct: 80,
        soldAt: `${new Date(NOW).getUTCFullYear()}-02-15T00:00:00Z`,
        source: "manual",
      },
    ];
    const v = buildValuation(holdings, ledger, { x: holdings[0] }, NOW);
    expect(v.fullPosition.realizedYtd).toBe(80);
    expect(v.fullPosition.unrealized).toBe(v.totals.unrealizedGainLoss);
    expect(v.fullPosition.total).toBe(v.fullPosition.realizedYtd + v.fullPosition.unrealized);
    expect(v.fullPosition.realizedYtdNote).toMatch(/CF-ERP rule/);
  });
});
