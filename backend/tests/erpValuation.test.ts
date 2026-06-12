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

// ─────────────────────────────────────────────────────────────────────────
// CF-VALUATION-TOTALS-SPLIT (2026-06-12) — counts-only firewall in ERP.
// Estimated holdings carry fairMarketValue=null; they MUST NOT contribute
// any dollar to snapshotValue / unrealizedGainLoss / Schedule D math.
// estimatedCount + pendingCount are the only new signals ERP gets.
// ─────────────────────────────────────────────────────────────────────────
describe("buildValuation — CF-VALUATION-TOTALS-SPLIT counts-only firewall", () => {
  it("estimated holding contributes ZERO dollars; bumps estimatedCount; cost still added", () => {
    // One observed @ $150 FMV / $100 cost; one estimated holding with
    // a $3,260 estimatedValue but fairMarketValue=null + $500 cost.
    // The estimated holding MUST NOT appear in snapshotValue and MUST
    // NOT pollute the unrealized math.
    const holdings: PortfolioHolding[] = [
      h({ id: "observed-1", purchasePrice: 100, totalCostBasis: 100, fairMarketValue: 150 }),
      h({
        id: "estimated-1",
        purchasePrice: 500,
        totalCostBasis: 500,
        fairMarketValue: undefined,
        valuationStatus: "estimated",
        estimatedValue: 3260.40,
        isEstimate: true,
      } as any),
    ];
    const v = buildValuation(holdings, [], Object.fromEntries(holdings.map((x) => [x.id, x])), NOW);
    // The $3,260.40 estimate must not appear in totals.snapshotValue.
    expect(v.totals.snapshotValue).toBe(150);
    expect(v.totals.snapshotValue).not.toBe(3410.40);  // 150 + 3260.40
    // Cost still adds.
    expect(v.totals.costBasis).toBe(600);
    // unrealizedGainLoss is observed-only ($150 - $600 = -$450).
    expect(v.totals.unrealizedGainLoss).toBe(-450);
    // Counts: 1 estimated, 0 pending.
    expect(v.totals.estimatedCount).toBe(1);
    expect(v.totals.pendingCount).toBe(0);
    // The estimated holding's per-row snapshot is null.
    const estimatedRow = v.holdings.find((r) => r.id === "estimated-1")!;
    expect(estimatedRow.snapshotValue).toBeNull();
    expect(estimatedRow.unrealizedGainLoss).toBeNull();
  });

  it("pending holding bumps pendingCount; contributes no dollars", () => {
    const holdings: PortfolioHolding[] = [
      h({ id: "observed-1", fairMarketValue: 100, totalCostBasis: 50 }),
      h({
        id: "pending-1",
        purchasePrice: 200,
        totalCostBasis: 200,
        fairMarketValue: undefined,
        valuationStatus: "pending",
        estimatedValue: undefined,
        isEstimate: true,
      } as any),
    ];
    const v = buildValuation(holdings, [], Object.fromEntries(holdings.map((x) => [x.id, x])), NOW);
    expect(v.totals.snapshotValue).toBe(100);
    expect(v.totals.estimatedCount).toBe(0);
    expect(v.totals.pendingCount).toBe(1);
  });

  it("all-observed portfolio: estimatedCount=0, pendingCount=0 (backward compat)", () => {
    const holdings: PortfolioHolding[] = [
      h({ id: "a", fairMarketValue: 100 }),
      h({ id: "b", fairMarketValue: 200 }),
    ];
    const v = buildValuation(holdings, [], Object.fromEntries(holdings.map((x) => [x.id, x])), NOW);
    expect(v.totals.estimatedCount).toBe(0);
    expect(v.totals.pendingCount).toBe(0);
    expect(v.totals.snapshotValue).toBe(300);
  });
});
