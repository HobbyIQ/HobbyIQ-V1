// CF-VALUATION-TOTALS-SPLIT (2026-06-12) — coverage for:
//   • summarizeHoldings observed/estimated/pending split + observedPct
//   • composeHoldingWireShape displayableValue + displayableValueSource
//   • evaluateHoldingAlerts observed↔estimated flip guard
// ERP counts-only coverage lives in tests/erpValuation.test.ts.

import { describe, expect, it } from "vitest";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";
import {
  summarizeHoldings,
  __portfolioStoreInternals,
} from "../src/services/portfolioiq/portfolioStore.service.js";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";

function makeHolding(over: Partial<PortfolioHolding>): PortfolioHolding {
  return {
    id: "h",
    playerName: "Test",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    fairMarketValue: 150,
    ...over,
  } as PortfolioHolding;
}

describe("summarizeHoldings — observed/estimated/pending split", () => {
  it("observed-only portfolio: observedValue=Σ, estimatedValue=0, observedPct=1", () => {
    const items = [
      makeHolding({ id: "a", fairMarketValue: 100, quantity: 1 }),
      makeHolding({ id: "b", fairMarketValue: 200, quantity: 2 }),
    ];
    const s = summarizeHoldings(items);
    // observed: 100 + 200*2 = 500
    expect(s.observedValue).toBe(500);
    expect(s.estimatedValue).toBe(0);
    expect(s.estimatedCount).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.observedPct).toBe(1);
  });

  it("mixed: observed + estimated + pending split correctly; observedPct reflects the mix", () => {
    const items: PortfolioHolding[] = [
      makeHolding({ id: "obs-1", fairMarketValue: 100, quantity: 1, valuationStatus: "observed" }),
      makeHolding({
        id: "est-1",
        purchasePrice: 50,
        totalCostBasis: 50,
        fairMarketValue: undefined,
        quantity: 2,
        valuationStatus: "estimated",
        estimatedValue: 200,   // per-unit
        isEstimate: true,
      } as any),
      makeHolding({
        id: "pend-1",
        purchasePrice: 30,
        totalCostBasis: 30,
        fairMarketValue: undefined,
        valuationStatus: "pending",
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    expect(s.observedValue).toBe(100);                    // observed: 100×1
    expect(s.estimatedValue).toBe(400);                    // estimated: 200×2
    expect(s.estimatedCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    // observedPct = 100 / (100 + 400) = 0.2
    expect(s.observedPct).toBeCloseTo(0.2, 4);
    // Backward compat: totalValue (legacy field) keeps using computeDisplayValue
    // which falls back to cost for null-FMV holdings.
    // Estimated holding: cost=50, FMV=null → contributes 50; pending: cost=30.
    // observed: 100. So legacy totalValue = 100 + 50 + 30 = 180.
    expect(s.totalValue).toBe(180);
  });

  it("missing valuationStatus treated as observed (pre-Step-1 holdings, backward compat)", () => {
    // Holding without valuationStatus set — pre-Step-1 docs in Cosmos
    // never had the field. Must continue to be treated as observed so
    // existing portfolios don't suddenly stop contributing to observedValue.
    const items: PortfolioHolding[] = [
      makeHolding({ id: "legacy", fairMarketValue: 250, quantity: 1 }),
    ];
    const s = summarizeHoldings(items);
    expect(s.observedValue).toBe(250);
    expect(s.estimatedCount).toBe(0);
    expect(s.pendingCount).toBe(0);
  });

  it("empty portfolio: observedPct=null, totals zero", () => {
    const s = summarizeHoldings([]);
    expect(s.observedValue).toBe(0);
    expect(s.estimatedValue).toBe(0);
    expect(s.observedPct).toBeNull();
  });

  it("observedPct rounds to 4 decimals (60% → 0.6)", () => {
    const items: PortfolioHolding[] = [
      makeHolding({ id: "a", fairMarketValue: 600, valuationStatus: "observed" }),
      makeHolding({
        id: "b",
        fairMarketValue: undefined,
        valuationStatus: "estimated",
        estimatedValue: 400,
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    expect(s.observedPct).toBeCloseTo(0.6, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CF-HEADLINE-HONEST-TOTAL (2026-06-12) — explicit honest fields
// alongside the legacy cost-proxy fields. Hard rule: no estimated dollar
// ever enters observedGainLoss / observedGainLossPct.
// ─────────────────────────────────────────────────────────────────────────
describe("summarizeHoldings — CF-HEADLINE-HONEST-TOTAL", () => {
  it("3-holding brief example: observed Trout + estimated Leo Blue PSA 10 + pending Leo Blue BGS 9.5", () => {
    const items: PortfolioHolding[] = [
      // Trout PSA 10 — observed @ $956, cost $700
      makeHolding({
        id: "trout",
        purchasePrice: 700,
        totalCostBasis: 700,
        fairMarketValue: 956,
        quantity: 1,
        valuationStatus: "observed",
      }),
      // Leo Blue PSA 10 — estimated @ $3,260.40, cost $1,000
      makeHolding({
        id: "leo-psa10",
        purchasePrice: 1000,
        totalCostBasis: 1000,
        fairMarketValue: undefined,
        quantity: 1,
        valuationStatus: "estimated",
        estimatedValue: 3260.40,
        isEstimate: true,
      } as any),
      // Leo Blue BGS 9.5 — pending (no number), cost $800
      makeHolding({
        id: "leo-bgs95",
        purchasePrice: 800,
        totalCostBasis: 800,
        fairMarketValue: undefined,
        quantity: 1,
        valuationStatus: "pending",
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    // Honest fields:
    expect(s.displayableTotalValue).toBe(4216.40);   // 956 + 3260.40
    expect(s.observedValue).toBe(956);
    expect(s.estimatedValue).toBe(3260.40);
    expect(s.observedPct).toBeCloseTo(0.2267, 4);
    expect(s.observedCostBasis).toBe(700);            // Trout cost ONLY
    expect(s.observedGainLoss).toBe(256);              // 956 - 700
    expect(s.observedGainLossPct).toBeCloseTo(0.3657, 4);  // 256 / 700
    expect(s.estimatedCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    // Legacy fields BYTE-IDENTICAL to pre-CF behavior — cost-proxy fallback
    // means: Trout observed → 956, Leo PSA 10 (null FMV) → cost 1000,
    // Leo BGS 9.5 (null FMV) → cost 800. Sum 2756.
    expect(s.totalValue).toBe(2756);
    expect(s.totalCost).toBe(2500);
    expect(s.totalGainLoss).toBe(256);
    expect(s.cardCount).toBe(3);
  });

  it("HARD RULE: estimated dollar contributes ZERO to observedGainLoss/Pct", () => {
    // One estimated holding with massive estimatedValue and tiny cost.
    // observedGainLoss must be 0 (no observed holdings).
    // observedGainLossPct must be null (no observed cost basis).
    const items: PortfolioHolding[] = [
      makeHolding({
        id: "lottery",
        purchasePrice: 1,
        totalCostBasis: 1,
        fairMarketValue: undefined,
        valuationStatus: "estimated",
        estimatedValue: 100000,    // $100K estimate, $1 cost — would be huge gain if folded in
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    expect(s.observedGainLoss).toBe(0);
    expect(s.observedGainLossPct).toBeNull();      // no observed cost basis → null, not 0
    expect(s.observedValue).toBe(0);
    expect(s.estimatedValue).toBe(100000);
    expect(s.displayableTotalValue).toBe(100000);
  });

  it("pending holdings contribute ZERO to observedCostBasis (and thus ZERO to observed gain)", () => {
    const items: PortfolioHolding[] = [
      makeHolding({ id: "obs", fairMarketValue: 500, totalCostBasis: 400, valuationStatus: "observed" }),
      makeHolding({
        id: "pend",
        purchasePrice: 999,
        totalCostBasis: 999,
        fairMarketValue: undefined,
        valuationStatus: "pending",
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    expect(s.observedCostBasis).toBe(400);          // ONLY the observed holding's cost
    expect(s.observedGainLoss).toBe(100);           // 500 - 400; pending's $999 cost ignored
    expect(s.observedGainLossPct).toBeCloseTo(0.25, 4);
  });

  it("empty portfolio: observedGainLossPct=null, observedGainLoss=0, displayableTotalValue=0", () => {
    const s = summarizeHoldings([]);
    expect(s.observedGainLoss).toBe(0);
    expect(s.observedGainLossPct).toBeNull();
    expect(s.observedCostBasis).toBe(0);
    expect(s.displayableTotalValue).toBe(0);
  });

  it("all-observed portfolio: legacy and honest fields agree (no estimated holdings → no divergence)", () => {
    const items: PortfolioHolding[] = [
      makeHolding({ id: "a", fairMarketValue: 100, totalCostBasis: 80, valuationStatus: "observed" }),
      makeHolding({ id: "b", fairMarketValue: 250, totalCostBasis: 200, valuationStatus: "observed" }),
    ];
    const s = summarizeHoldings(items);
    expect(s.displayableTotalValue).toBe(s.observedValue);
    expect(s.observedGainLoss).toBe(s.totalGainLoss);
    // Legacy totalGainLossPct is *100 scale; observedGainLossPct is fractional.
    expect(s.observedGainLossPct).toBeCloseTo(s.totalGainLossPct / 100, 4);
  });

  it("legacy fields BYTE-IDENTICAL to pre-CF behavior (regression guard)", () => {
    // A portfolio with one of each status. Legacy fields must equal the
    // exact values they would have produced before CF-HEADLINE-HONEST-TOTAL.
    const items: PortfolioHolding[] = [
      makeHolding({ id: "o", fairMarketValue: 500, totalCostBasis: 300, valuationStatus: "observed" }),
      makeHolding({
        id: "e",
        purchasePrice: 50,
        totalCostBasis: 50,
        fairMarketValue: undefined,
        valuationStatus: "estimated",
        estimatedValue: 1000,
        isEstimate: true,
      } as any),
      makeHolding({
        id: "p",
        purchasePrice: 25,
        totalCostBasis: 25,
        fairMarketValue: undefined,
        valuationStatus: "pending",
        isEstimate: true,
      } as any),
    ];
    const s = summarizeHoldings(items);
    // computeDisplayValue: observed=500, estimated (null FMV)→cost=50, pending (null FMV)→cost=25
    expect(s.totalValue).toBe(575);
    expect(s.totalCost).toBe(375);
    expect(s.totalGainLoss).toBe(200);
    expect(s.totalGainLossPct).toBeCloseTo((200 / 375) * 100, 2);
    expect(s.cardCount).toBe(3);
  });
});

describe("composeHoldingWireShape — displayableValue + displayableValueSource", () => {
  it("observed holding: displayableValue = fmv × qty; source = 'observed'", () => {
    const wire = composeHoldingWireShape(makeHolding({
      fairMarketValue: 150,
      quantity: 2,
    }));
    expect(wire.displayableValue).toBe(300);
    expect(wire.displayableValueSource).toBe("observed");
    expect(wire.fairMarketValue).toBe(150);  // observed slot stays as before
  });

  it("estimated holding: displayableValue = estimatedValue × qty; source = 'estimated'; fairMarketValue=null", () => {
    const wire = composeHoldingWireShape({
      ...makeHolding({}),
      fairMarketValue: undefined,
      quantity: 1,
      valuationStatus: "estimated",
      estimatedValue: 3260.40,
      isEstimate: true,
    } as PortfolioHolding);
    expect(wire.displayableValue).toBe(3260.40);
    expect(wire.displayableValueSource).toBe("estimated");
    expect(wire.fairMarketValue).toBeNull();
  });

  it("pending holding: displayableValue = null; source = null", () => {
    const wire = composeHoldingWireShape({
      ...makeHolding({}),
      fairMarketValue: undefined,
      valuationStatus: "pending",
      isEstimate: true,
    } as PortfolioHolding);
    expect(wire.displayableValue).toBeNull();
    expect(wire.displayableValueSource).toBeNull();
    expect(wire.fairMarketValue).toBeNull();
  });

  it("currentValue stays observed-only (cost fallback) — does NOT fold in estimate", () => {
    // Estimated holding: cost=100, estimatedValue=3260, fmv=null.
    // currentValue must use computeDisplayValue → cost ($100), NOT $3,260.
    // displayableValue separately surfaces the $3,260.
    const wire = composeHoldingWireShape({
      ...makeHolding({}),
      purchasePrice: 100,
      totalCostBasis: 100,
      fairMarketValue: undefined,
      quantity: 1,
      valuationStatus: "estimated",
      estimatedValue: 3260.40,
      isEstimate: true,
    } as PortfolioHolding);
    expect(wire.currentValue).toBe(100);          // observed slot unchanged
    expect(wire.displayableValue).toBe(3260.40);   // new slot has estimate
    expect(wire.quickSaleValue).toBeNull();        // observed-only multiplier
    expect(wire.premiumValue).toBeNull();
    expect(wire.suggestedListPrice).toBeNull();
  });
});

describe("evaluateHoldingAlerts — observed↔estimated flip guard", () => {
  const { evaluateHoldingAlerts } = __portfolioStoreInternals;
  function emptyDoc(): any {
    return { alerts: [], holdings: {}, priceHistoryByHolding: {}, ledger: [] };
  }

  it("observed → estimated flip: NO value-move alert emitted (0% drop is synthetic)", () => {
    const doc = emptyDoc();
    const previous = makeHolding({ id: "h", fairMarketValue: 1000, valuationStatus: "observed" });
    const next = {
      ...previous,
      fairMarketValue: undefined,
      valuationStatus: "estimated",
      estimatedValue: 3260.40,
      isEstimate: true,
    } as PortfolioHolding;
    evaluateHoldingAlerts(doc, previous, next);
    expect(doc.alerts).toEqual([]);
  });

  it("estimated → observed flip: NO synthetic infinite-gain alert emitted", () => {
    const doc = emptyDoc();
    const previous = {
      ...makeHolding({ id: "h" }),
      fairMarketValue: undefined,
      valuationStatus: "estimated",
      estimatedValue: 2000,
      isEstimate: true,
    } as PortfolioHolding;
    const next = makeHolding({ id: "h", fairMarketValue: 1850, valuationStatus: "observed" });
    evaluateHoldingAlerts(doc, previous, next);
    expect(doc.alerts).toEqual([]);
  });

  it("observed → pending flip: NO alert", () => {
    const doc = emptyDoc();
    const previous = makeHolding({ id: "h", fairMarketValue: 500, valuationStatus: "observed" });
    const next = {
      ...previous,
      fairMarketValue: undefined,
      valuationStatus: "pending",
      isEstimate: true,
    } as PortfolioHolding;
    evaluateHoldingAlerts(doc, previous, next);
    expect(doc.alerts).toEqual([]);
  });

  it("observed → observed real value move (≥10%): value-move alert STILL fires (guard is targeted)", () => {
    const doc = emptyDoc();
    const previous = makeHolding({ id: "h", fairMarketValue: 1000, valuationStatus: "observed" });
    const next = makeHolding({ id: "h", fairMarketValue: 1200, valuationStatus: "observed" });
    evaluateHoldingAlerts(doc, previous, next);
    const move = doc.alerts.find((a: any) => a.type === "value-move");
    expect(move).toBeDefined();
    expect(move.context.movePct).toBeCloseTo(20, 0);
  });

  it("pre-Step-1 (no valuationStatus) → estimated: guard fires (treats undefined as observed)", () => {
    const doc = emptyDoc();
    const previous = makeHolding({ id: "h", fairMarketValue: 500 });  // no valuationStatus
    const next = {
      ...previous,
      fairMarketValue: undefined,
      valuationStatus: "estimated",
      estimatedValue: 800,
      isEstimate: true,
    } as PortfolioHolding;
    evaluateHoldingAlerts(doc, previous, next);
    expect(doc.alerts).toEqual([]);
  });
});
