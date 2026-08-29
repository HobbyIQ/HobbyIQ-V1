// CF-LISTING-PRICE-PRECEDENCE (2026-08-29, checklist D12a §7). The one-click
// listing composer took predictedPrice before fairMarketValue, so a card
// whose exact (identity, grade) pool had spoken was listed at a trend
// extrapolation instead of the pool's projected next sale. fairMarketValue
// IS the headline — the persist sites write it from
// `marketValue ?? predictedPrice ?? fmv` (#1432, D12-a §4) — so it comes
// first here too: targetPrice, then FMV, then predictedPrice, then the
// estimate.

import { describe, expect, it } from "vitest";
import { composeListingInput, pickTargetPrice } from "../src/services/portfolioiq/oneClickListingComposer.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Eric Hartman",
    cardYear: 2026,
    setName: "2026 Bowman Chrome",
    parallel: "Orange Shimmer Refractor",
    cardNumber: "CPA-EHA",
    predictedPrice: 2639,
    fairMarketValue: 1990,
    estimatedValue: null,
    quantity: 1,
    ...(overrides as object),
  } as PortfolioHolding;
}

describe("pickTargetPrice — FMV before predictedPrice", () => {
  it("lists the FMV, not the predicted price, when both exist", () => {
    // Mutation check: the pre-fix order returned 2639 (predictedPrice) here.
    expect(pickTargetPrice(holding())).toBe(1990);
    expect(composeListingInput(holding())?.listingPrice).toBe(1990);
  });

  it("the seller's target outranks everything", () => {
    expect(pickTargetPrice(holding(), 3000)).toBe(3000);
  });

  it("falls to predictedPrice only when there is no FMV, and to the estimate only when there is neither", () => {
    expect(pickTargetPrice(holding({ fairMarketValue: null }))).toBe(2639);
    expect(pickTargetPrice(holding({ fairMarketValue: null, predictedPrice: null, estimatedValue: 500 }))).toBe(500);
    expect(pickTargetPrice(holding({ fairMarketValue: null, predictedPrice: null, estimatedValue: null }))).toBe(0);
  });

  it("a non-positive FMV is not a price", () => {
    expect(pickTargetPrice(holding({ fairMarketValue: 0 }))).toBe(2639);
  });
});
