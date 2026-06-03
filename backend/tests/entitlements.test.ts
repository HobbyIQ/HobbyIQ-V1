// CF-PAYMENTS-A — pure-function locks on the entitlements matrix.
//
// Tests the matrix VALUES against the spec passed in the CF, plus the
// helper functions (hasEntitlement, getCap, minimumTierFor,
// minimumTierForCap, resolveEntitlementsFor) — these are the surface area
// every middleware reads, so any drift in the matrix immediately fails
// the suite.

import { describe, expect, it } from "vitest";
import {
  ENTITLEMENTS,
  hasEntitlement,
  getCap,
  minimumTierFor,
  minimumTierForCap,
  resolveEntitlementsFor,
  PLAN_RANK,
  type Plan,
} from "../src/config/entitlements.js";

const ALL_PLANS: Plan[] = ["free", "collector", "investor", "pro_seller"];

describe("ENTITLEMENTS matrix — caps", () => {
  it("priceChecksPerDay: free=5, collector/investor/pro_seller unlimited", () => {
    expect(ENTITLEMENTS.free.caps.priceChecksPerDay).toBe(5);
    expect(ENTITLEMENTS.collector.caps.priceChecksPerDay).toBe("unlimited");
    expect(ENTITLEMENTS.investor.caps.priceChecksPerDay).toBe("unlimited");
    expect(ENTITLEMENTS.pro_seller.caps.priceChecksPerDay).toBe("unlimited");
  });

  it("holdingsCap: free=25, collector=250, investor/pro_seller unlimited", () => {
    expect(ENTITLEMENTS.free.caps.holdingsCap).toBe(25);
    expect(ENTITLEMENTS.collector.caps.holdingsCap).toBe(250);
    expect(ENTITLEMENTS.investor.caps.holdingsCap).toBe("unlimited");
    expect(ENTITLEMENTS.pro_seller.caps.holdingsCap).toBe("unlimited");
  });

  it("scansPerMonth: free=10, collector/investor/pro_seller unlimited", () => {
    expect(ENTITLEMENTS.free.caps.scansPerMonth).toBe(10);
    expect(ENTITLEMENTS.collector.caps.scansPerMonth).toBe("unlimited");
    expect(ENTITLEMENTS.investor.caps.scansPerMonth).toBe("unlimited");
    expect(ENTITLEMENTS.pro_seller.caps.scansPerMonth).toBe("unlimited");
  });

  it("priceAlerts: free=0, collector=10, investor=30, pro_seller unlimited", () => {
    expect(ENTITLEMENTS.free.caps.priceAlerts).toBe(0);
    expect(ENTITLEMENTS.collector.caps.priceAlerts).toBe(10);
    expect(ENTITLEMENTS.investor.caps.priceAlerts).toBe(30);
    expect(ENTITLEMENTS.pro_seller.caps.priceAlerts).toBe("unlimited");
  });
});

describe("ENTITLEMENTS matrix — features", () => {
  it("free has NO gated features", () => {
    expect(ENTITLEMENTS.free.features.size).toBe(0);
  });

  it("collector+ : predictions, watchlist", () => {
    expect(hasEntitlement("collector", "predictions")).toBe(true);
    expect(hasEntitlement("collector", "watchlist")).toBe(true);
    // collector does NOT get investor+ features
    expect(hasEntitlement("collector", "advancedAlerts")).toBe(false);
    expect(hasEntitlement("collector", "dailyIQBriefs")).toBe(false);
    expect(hasEntitlement("collector", "trendIQComposite")).toBe(false);
    expect(hasEntitlement("collector", "ebayIntegration")).toBe(false);
    expect(hasEntitlement("collector", "marketTrendIndexes")).toBe(false);
  });

  it("investor+ : adds advancedAlerts, dailyIQBriefs, trendIQComposite, ebayIntegration, marketTrendIndexes", () => {
    expect(hasEntitlement("investor", "predictions")).toBe(true);
    expect(hasEntitlement("investor", "watchlist")).toBe(true);
    expect(hasEntitlement("investor", "advancedAlerts")).toBe(true);
    expect(hasEntitlement("investor", "dailyIQBriefs")).toBe(true);
    expect(hasEntitlement("investor", "trendIQComposite")).toBe(true);
    expect(hasEntitlement("investor", "ebayIntegration")).toBe(true);
    expect(hasEntitlement("investor", "marketTrendIndexes")).toBe(true);
    // investor does NOT get pro_seller-only features
    expect(hasEntitlement("investor", "trendIQLayer3Full")).toBe(false);
    expect(hasEntitlement("investor", "erpReconciliation")).toBe(false);
  });

  it("pro_seller only: trendIQLayer3Full, erpReconciliation", () => {
    expect(hasEntitlement("pro_seller", "trendIQLayer3Full")).toBe(true);
    expect(hasEntitlement("pro_seller", "erpReconciliation")).toBe(true);
    // ALL the investor+ inherited too
    expect(hasEntitlement("pro_seller", "predictions")).toBe(true);
    expect(hasEntitlement("pro_seller", "watchlist")).toBe(true);
    expect(hasEntitlement("pro_seller", "advancedAlerts")).toBe(true);
    expect(hasEntitlement("pro_seller", "dailyIQBriefs")).toBe(true);
    expect(hasEntitlement("pro_seller", "trendIQComposite")).toBe(true);
    expect(hasEntitlement("pro_seller", "ebayIntegration")).toBe(true);
    expect(hasEntitlement("pro_seller", "marketTrendIndexes")).toBe(true);
  });

  it("free has none of the gated features", () => {
    const allFeatures = [
      "predictions", "watchlist", "advancedAlerts", "dailyIQBriefs",
      "trendIQComposite", "ebayIntegration", "marketTrendIndexes",
      "trendIQLayer3Full", "erpReconciliation",
    ] as const;
    for (const f of allFeatures) {
      expect(hasEntitlement("free", f)).toBe(false);
    }
  });
});

describe("PLAN_RANK", () => {
  it("orders plans low -> high", () => {
    expect(PLAN_RANK.free).toBeLessThan(PLAN_RANK.collector);
    expect(PLAN_RANK.collector).toBeLessThan(PLAN_RANK.investor);
    expect(PLAN_RANK.investor).toBeLessThan(PLAN_RANK.pro_seller);
  });
});

describe("getCap", () => {
  it("returns plan-specific cap values", () => {
    expect(getCap("free", "holdingsCap")).toBe(25);
    expect(getCap("collector", "holdingsCap")).toBe(250);
    expect(getCap("investor", "holdingsCap")).toBe("unlimited");
    expect(getCap("pro_seller", "priceAlerts")).toBe("unlimited");
  });
});

describe("minimumTierFor", () => {
  it("returns the lowest plan that has the feature", () => {
    expect(minimumTierFor("predictions")).toBe("collector");
    expect(minimumTierFor("watchlist")).toBe("collector");
    expect(minimumTierFor("advancedAlerts")).toBe("investor");
    expect(minimumTierFor("dailyIQBriefs")).toBe("investor");
    expect(minimumTierFor("ebayIntegration")).toBe("investor");
    expect(minimumTierFor("trendIQLayer3Full")).toBe("pro_seller");
    expect(minimumTierFor("erpReconciliation")).toBe("pro_seller");
  });
});

describe("minimumTierForCap", () => {
  it("priceAlerts: with 0 alerts, collector is the minimum (cap=10>0)", () => {
    // free has cap=0, so 0 alerts is already at the limit -> need collector
    expect(minimumTierForCap("priceAlerts", 0)).toBe("collector");
  });
  it("priceAlerts: with 9 alerts, collector still fits (cap=10)", () => {
    expect(minimumTierForCap("priceAlerts", 9)).toBe("collector");
  });
  it("priceAlerts: with 10 alerts, collector is full -> investor", () => {
    expect(minimumTierForCap("priceAlerts", 10)).toBe("investor");
  });
  it("priceAlerts: with 30 alerts, investor is full -> pro_seller", () => {
    expect(minimumTierForCap("priceAlerts", 30)).toBe("pro_seller");
  });
  it("holdingsCap: with 24 holdings, free still fits", () => {
    expect(minimumTierForCap("holdingsCap", 24)).toBe("free");
  });
  it("holdingsCap: with 25 holdings, free is full -> collector", () => {
    expect(minimumTierForCap("holdingsCap", 25)).toBe("collector");
  });
  it("holdingsCap: with 250 holdings, collector is full -> investor", () => {
    expect(minimumTierForCap("holdingsCap", 250)).toBe("investor");
  });
});

describe("resolveEntitlementsFor (wire shape used by GET /api/entitlements/me)", () => {
  it("free: empty features array, all caps echoed", () => {
    const r = resolveEntitlementsFor("free");
    expect(r.plan).toBe("free");
    expect(r.features).toEqual([]);
    expect(r.caps.priceChecksPerDay).toBe(5);
    expect(r.caps.holdingsCap).toBe(25);
    expect(r.caps.scansPerMonth).toBe(10);
    expect(r.caps.priceAlerts).toBe(0);
  });

  it("pro_seller: features sorted alphabetically; caps all unlimited", () => {
    const r = resolveEntitlementsFor("pro_seller");
    expect(r.plan).toBe("pro_seller");
    // Alphabetically sorted feature list.
    expect(r.features).toEqual([...r.features].sort());
    // Spot check that pro_seller-only flags are present.
    expect(r.features).toContain("trendIQLayer3Full");
    expect(r.features).toContain("erpReconciliation");
    expect(r.caps.priceChecksPerDay).toBe("unlimited");
    expect(r.caps.holdingsCap).toBe("unlimited");
    expect(r.caps.scansPerMonth).toBe("unlimited");
    expect(r.caps.priceAlerts).toBe("unlimited");
  });

  it("monotonic feature inclusion across tiers", () => {
    // higher tier ⊇ lower tier
    for (let i = 1; i < ALL_PLANS.length; i++) {
      const lower = resolveEntitlementsFor(ALL_PLANS[i - 1]).features;
      const higher = resolveEntitlementsFor(ALL_PLANS[i]).features;
      for (const f of lower) {
        expect(higher).toContain(f);
      }
    }
  });
});
