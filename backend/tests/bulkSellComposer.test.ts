// CF-BULK-SELL-COMPOSER (Drew, 2026-07-17). Pinning tests for the
// individual-vs-bundle strategy math.

import { describe, it, expect } from "vitest";
import { composeBulkSell, type BulkSellHolding } from "../src/services/portfolioiq/bulkSellComposer.js";

function h(id: string, predicted: number): BulkSellHolding {
  return {
    holdingId: id,
    playerName: "Test Player",
    cardTitle: `Card ${id}`,
    predictedPrice: predicted,
    marketValue: predicted,
    purchasePrice: predicted * 0.7,
  };
}

describe("composeBulkSell — strategy recommendation", () => {
  it("all-similar prices: bundle discount eats the gain → all_individual", () => {
    // 3 cards at $100 each. Individual: 3 × (100×0.87 − 5) = 3 × 82 = 246
    // Bundle: 3×100×0.85×0.87 − 12 = 220.65
    // Individual wins by ~$25
    const r = composeBulkSell([h("a", 100), h("b", 100), h("c", 100)]);
    expect(r.totals.recommendedStrategy).toBe("all_individual");
    expect(r.totals.individualStrategyNet).toBeGreaterThan(r.totals.bundleStrategyNet);
  });

  it("high-count low-value: bundle shipping savings help but discount still hurts", () => {
    // 10 cards at $30 each. Individual: 10 × (30×0.87 − 5) = 10 × 21.1 = 211
    // Bundle: 300×0.85×0.87 − 12 = 209.85
    // Individual still slightly better
    const cards = Array.from({ length: 10 }, (_, i) => h(`c${i}`, 30));
    const r = composeBulkSell(cards);
    expect(r.totals.individualStrategyNet).toBeCloseTo(211, 0);
    expect(r.totals.bundleStrategyNet).toBeCloseTo(209.85, 1);
  });

  it("per-card net proceeds accounts for eBay fee + shipping", () => {
    const r = composeBulkSell([h("a", 100)]);
    // $100 × 0.87 − $5 = $82
    expect(r.candidates[0].individualNetProceeds).toBeCloseTo(82, 1);
  });

  it("missing predicted price → skip_missing_predicted strategy", () => {
    const r = composeBulkSell([
      h("a", 100),
      { holdingId: "b", playerName: "x", cardTitle: "y", predictedPrice: null, marketValue: null, purchasePrice: null },
    ]);
    const skipped = r.candidates.find((c) => c.holdingId === "b");
    expect(skipped?.strategy).toBe("skip_missing_predicted");
    expect(skipped?.individualNetProceeds).toBe(0);
  });
});

describe("composeBulkSell — per-card share math", () => {
  it("bundle share proportional to card's contribution", () => {
    // Two cards: $100 and $200. Total = $300.
    // Bundle net = 300 × 0.85 × 0.87 − 12 = 209.85 - 12 = ~209.85
    // Share of card A ($100): 100/300 × 209.85 ≈ 69.95
    // Share of card B ($200): 200/300 × 209.85 ≈ 139.9
    const r = composeBulkSell([h("a", 100), h("b", 200)]);
    const bundleShareA = r.candidates.find((c) => c.holdingId === "a")!.bundleShareOfNet;
    const bundleShareB = r.candidates.find((c) => c.holdingId === "b")!.bundleShareOfNet;
    expect(bundleShareA + bundleShareB).toBeCloseTo(r.totals.bundleStrategyNet, 1);
    // B's share should be roughly 2× A's (proportional to prices)
    expect(bundleShareB / bundleShareA).toBeCloseTo(2, 1);
  });

  it("netDelta positive → prefer individual; negative → prefer bundle", () => {
    const r = composeBulkSell([h("a", 100), h("b", 100), h("c", 100)]);
    for (const c of r.candidates.filter((x) => x.strategy !== "skip_missing_predicted")) {
      if (c.strategy === "list_individually") expect(c.netDelta).toBeGreaterThan(0);
      if (c.strategy === "add_to_bundle") expect(c.netDelta).toBeLessThanOrEqual(0);
    }
  });
});

describe("composeBulkSell — options overrides", () => {
  it("Higher bundle discount tips toward individual sales", () => {
    const rLow = composeBulkSell([h("a", 100), h("b", 100)], { bundleDiscountPct: 0.05 });
    const rHigh = composeBulkSell([h("a", 100), h("b", 100)], { bundleDiscountPct: 0.30 });
    expect(rLow.totals.bundleStrategyNet).toBeGreaterThan(rHigh.totals.bundleStrategyNet);
  });

  it("Zero shipping → higher net for both strategies", () => {
    const r = composeBulkSell([h("a", 100)], {
      perCardShippingCost: 0,
      bundleShippingCost: 0,
    });
    expect(r.candidates[0].individualNetProceeds).toBeCloseTo(87, 1);   // 100 × 0.87
  });
});

describe("composeBulkSell — assumptions passthrough", () => {
  it("emits eBay fee, bundle discount, shipping costs so iOS can display", () => {
    const r = composeBulkSell([h("a", 100)]);
    expect(r.assumptions.ebayFeePct).toBeCloseTo(0.13, 3);
    expect(r.assumptions.bundleDiscountPct).toBeCloseTo(0.15, 3);
    expect(r.assumptions.perCardShippingCost).toBe(5);
    expect(r.assumptions.bundleShippingCost).toBe(12);
  });
});
