// CF-ONE-CLICK-LISTING (Drew, 2026-07-17). Pinning tests for the
// holding → listing-input derivation.

import { describe, it, expect } from "vitest";
import { composeListingInput } from "../src/services/portfolioiq/oneClickListingComposer.service.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Eric Hartman",
    cardYear: 2026,
    setName: "2026 Bowman Chrome",
    parallel: "Orange Shimmer Refractor",
    cardNumber: "CPA-EHA",
    team: "Atlanta Braves",
    sport: "Baseball",
    predictedPrice: 2639,
    fairMarketValue: 1990,
    estimatedValue: null,
    quantity: 1,
    purchasePrice: 1190,
    purchaseDate: "2026-06-25",
    lastUpdated: "2026-07-17",
    ...(overrides as any),
  } as PortfolioHolding;
}

describe("composeListingInput — happy path", () => {
  it("derives a complete input from a well-formed holding", () => {
    const input = composeListingInput(holding());
    expect(input).not.toBeNull();
    expect(input!.playerName).toBe("Eric Hartman");
    expect(input!.cardYear).toBe(2026);
    expect(input!.setName).toBe("2026 Bowman Chrome");
    expect(input!.parallel).toBe("Orange Shimmer Refractor");
    expect(input!.cardNumber).toBe("CPA-EHA");
    expect(input!.brand).toBe("Bowman");
    expect(input!.listingPrice).toBe(2639);
    expect(input!.bestOfferEnabled).toBe(true);
    expect(input!.bestOfferMinPrice).toBeCloseTo(2639 * 0.85, 0);
    expect(input!.quantity).toBe(1);
  });

  it("prefers predictedPrice over marketValue over estimatedValue", () => {
    const p = composeListingInput(holding({ predictedPrice: 2500, fairMarketValue: 1000 }));
    expect(p!.listingPrice).toBe(2500);

    const m = composeListingInput(holding({ predictedPrice: null, fairMarketValue: 1000 }));
    expect(m!.listingPrice).toBe(1000);

    const e = composeListingInput(holding({
      predictedPrice: null, fairMarketValue: null, estimatedValue: 500,
    }));
    expect(e!.listingPrice).toBe(500);
  });

  it("targetPrice override wins over holding's stored values", () => {
    const input = composeListingInput(holding(), { targetPrice: 3000 });
    expect(input!.listingPrice).toBe(3000);
  });
});

describe("composeListingInput — auto-inference", () => {
  it("detects auto from parallel string containing 'auto'", () => {
    const input = composeListingInput(holding({ parallel: "Orange Shimmer Refractor Auto /25" }));
    expect(input!.isAuto).toBe(true);
  });

  it("detects rookie from parallel or title", () => {
    const input = composeListingInput(holding({ parallel: "1st Bowman Rookie" }));
    expect(input!.isRookie).toBe(true);
  });

  it("explicit isAuto boolean overrides inference", () => {
    const input = composeListingInput(holding({
      parallel: "Base",
      // @ts-expect-error — inject the field for the test
      isAuto: true,
    }));
    expect(input!.isAuto).toBe(true);
  });
});

describe("composeListingInput — bail conditions", () => {
  it("returns null when playerName is missing", () => {
    expect(composeListingInput(holding({ playerName: "" }))).toBeNull();
  });

  it("returns null when cardYear is missing", () => {
    expect(composeListingInput(holding({ cardYear: null as any }))).toBeNull();
  });

  it("returns null when setName+product both missing", () => {
    expect(composeListingInput(holding({
      setName: null as any, product: null as any,
    }))).toBeNull();
  });

  it("returns null when no target price can be derived", () => {
    expect(composeListingInput(holding({
      predictedPrice: null, fairMarketValue: null, estimatedValue: null,
    }))).toBeNull();
  });
});

describe("composeListingInput — overrides", () => {
  it("bestOfferEnabled=false disables best offer + min price", () => {
    const input = composeListingInput(holding(), { bestOfferEnabled: false });
    expect(input!.bestOfferEnabled).toBe(false);
    expect(input!.bestOfferMinPrice).toBeUndefined();
  });

  it("custom bestOfferAutoDeclinePct changes the min price", () => {
    const input = composeListingInput(holding(), { bestOfferAutoDeclinePct: 0.30 });
    expect(input!.bestOfferMinPrice).toBeCloseTo(2639 * 0.70, 0);
  });

  it("description override passes through", () => {
    const input = composeListingInput(holding(), { description: "Custom copy" });
    expect(input!.description).toBe("Custom copy");
  });

  it("quantity override passes through", () => {
    const input = composeListingInput(holding(), { quantity: 5 });
    expect(input!.quantity).toBe(5);
  });
});

describe("composeListingInput — cardNumber sanitization", () => {
  it("strips leading '#' from cardNumber (per HobbyIQ memory)", () => {
    const input = composeListingInput(holding({ cardNumber: "#CPA-EHA" }));
    expect(input!.cardNumber).toBe("CPA-EHA");
  });
});
