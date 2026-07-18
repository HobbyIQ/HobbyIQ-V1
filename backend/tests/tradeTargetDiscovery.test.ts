// CF-TRADE-TARGET-DISCOVERY (Drew, 2026-07-17). Pinning tests for the
// undervalued-listing discovery filter + rank.

import { describe, it, expect } from "vitest";
import { discoverTradeTargets, type TradeTargetListing } from "../src/services/portfolioiq/tradeTargetDiscovery.js";

function listing(overrides: Partial<TradeTargetListing> = {}): TradeTargetListing {
  return {
    id: "listing-1",
    cardId: "card-a",
    cardTitle: "Test Card",
    playerName: "Test Player",
    askPrice: 100,
    imageUrl: null,
    listingUrl: "https://ebay/example",
    sellerUsername: "seller1",
    sellerFeedbackScore: 500,
    engineMarketValue: 150,
    enginePredictedPrice: 160,
    isGuestimate: false,
    matchScore: 90,
    ...overrides,
  };
}

describe("discoverTradeTargets — basic gate", () => {
  it("Ask below engine by 33% → surfaced", () => {
    const results = discoverTradeTargets([listing()]);
    expect(results).toHaveLength(1);
    expect(results[0].discountPct).toBeCloseTo(1 - 100 / 150, 4);
    expect(results[0].confidence).toBe("high");
  });

  it("Ask at engine value → not surfaced", () => {
    const r = discoverTradeTargets([listing({ askPrice: 150 })]);
    expect(r).toHaveLength(0);
  });

  it("Ask below 60% (suspicious) → filtered out", () => {
    const r = discoverTradeTargets([listing({ askPrice: 40 })]);   // 73% below
    expect(r).toHaveLength(0);
  });

  it("Match score below threshold → filtered out", () => {
    const r = discoverTradeTargets([listing({ matchScore: 30 })]);
    expect(r).toHaveLength(0);
  });

  it("Missing engine value → filtered", () => {
    const r = discoverTradeTargets([listing({
      engineMarketValue: null, enginePredictedPrice: null,
    })]);
    expect(r).toHaveLength(0);
  });
});

describe("discoverTradeTargets — confidence + ranking", () => {
  it("Guestimate flips to low confidence", () => {
    const r = discoverTradeTargets([listing({ isGuestimate: true })]);
    expect(r[0].confidence).toBe("low");
    expect(r[0].reason).toContain("guestimate");
  });

  it("High match score + observed → high confidence", () => {
    const r = discoverTradeTargets([listing({ matchScore: 90, isGuestimate: false })]);
    expect(r[0].confidence).toBe("high");
    expect(r[0].reason).toContain("high-confidence");
  });

  it("Medium match score → medium confidence", () => {
    const r = discoverTradeTargets([listing({ matchScore: 60, isGuestimate: false })]);
    expect(r[0].confidence).toBe("medium");
    expect(r[0].reason).toContain("solid match");
  });

  it("Sorted by confidence then discount", () => {
    const r = discoverTradeTargets([
      listing({ id: "low-conf-big-discount", askPrice: 60, isGuestimate: true, cardId: "c1" }),   // 60% below, low conf
      listing({ id: "high-conf-small-discount", askPrice: 120, isGuestimate: false, cardId: "c2" }), // 20% below, high conf
    ]);
    // High confidence beats big discount from guestimate
    expect(r[0].cardId).toBe("c2");
    expect(r[1].cardId).toBe("c1");
  });

  it("Missing MV → falls back to predicted", () => {
    const r = discoverTradeTargets([listing({
      engineMarketValue: null,
      enginePredictedPrice: 160,
    })]);
    expect(r[0].engineValue).toBe(160);
  });
});

describe("discoverTradeTargets — options overrides", () => {
  it("Lower minDiscountPct surfaces more candidates", () => {
    const smallDiscount = listing({ askPrice: 140 });  // 6% below
    const rDefault = discoverTradeTargets([smallDiscount]);   // filtered out (below 15%)
    const rLoose = discoverTradeTargets([smallDiscount], { minDiscountPct: 0.05 });
    expect(rDefault).toHaveLength(0);
    expect(rLoose).toHaveLength(1);
  });

  it("Limit caps results", () => {
    const many = Array.from({ length: 30 }, (_, i) => listing({
      id: `l${i}`, cardId: `c${i}`, askPrice: 100 + i,
    }));
    const r = discoverTradeTargets(many, { limit: 5 });
    expect(r).toHaveLength(5);
  });
});
