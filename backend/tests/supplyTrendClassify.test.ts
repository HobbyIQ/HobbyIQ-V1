/**
 * CF-PLAYER-MOMENTUM-SUPPLY-TREND — pins the classification + adjuster.
 *
 * The 4-quadrant matrix is the whole point of this CF; every quadrant
 * gets a positive pin AND a "just below threshold → flat" pin so the
 * MIN_MEANINGFUL_DEVIATION guard is well-tested.
 */

import { describe, it, expect } from "vitest";
import {
  classifySupplyTrend,
  supplyTrendProjectionAdjuster,
  SUPPLY_DRY_BOOST,
  SUPPLY_FLOOD_DISCOUNT,
} from "../src/services/playerTrend/supplyTrend.classify";
import type { PlayerMomentumSignal } from "../src/services/playerTrend/playerTrend.types";

function makeMomentum(momentumRatio: number | null, volumeRatio: number | null): PlayerMomentumSignal {
  return {
    latestCompleteWeek: {
      weekStart: "2026-06-22",
      weekEnd: "2026-06-28",
      count: 500,
      totalDollars: 50000,
      avgSale: 100,
    },
    priorMeanAvgSale: 80,
    priorMeanCount: 400,
    priorWeeksCount: 4,
    momentumRatio,
    volumeRatio,
  };
}

describe("classifySupplyTrend — 4-quadrant matrix", () => {
  // Volume ↑ + Price ↑ → demand_growth
  it("vol=1.25, price=1.25 → demand_growth (buyers absorbing supply)", () => {
    expect(classifySupplyTrend(makeMomentum(1.25, 1.25))).toBe("demand_growth");
  });

  // Volume ↓ + Price ↑ → SUPPLY_DRY (leading indicator BULLISH)
  it("vol=0.7, price=1.25 → supply_dry (fewer listings, buyers competing) — bullish leading indicator", () => {
    expect(classifySupplyTrend(makeMomentum(1.25, 0.7))).toBe("supply_dry");
  });

  // Volume ↑ + Price ↓ → SUPPLY_FLOOD (leading indicator BEARISH)
  it("vol=1.5, price=0.7 → supply_flood (sellers dumping) — bearish leading indicator", () => {
    expect(classifySupplyTrend(makeMomentum(0.7, 1.5))).toBe("supply_flood");
  });

  // Volume ↓ + Price ↓ → demand_crash
  it("vol=0.6, price=0.6 → demand_crash (no buyers even at cheap prices)", () => {
    expect(classifySupplyTrend(makeMomentum(0.6, 0.6))).toBe("demand_crash");
  });
});

describe("classifySupplyTrend — noise-threshold guards", () => {
  it("both ratios inside ±0.05 → flat", () => {
    expect(classifySupplyTrend(makeMomentum(1.03, 1.02))).toBe("flat");
    expect(classifySupplyTrend(makeMomentum(0.98, 0.97))).toBe("flat");
    expect(classifySupplyTrend(makeMomentum(1.0, 1.0))).toBe("flat");
  });

  it("price meaningful but volume flat → flat (both signals required)", () => {
    // 25% price move but only 3% volume move — not classifiable as a
    // leading indicator. Momentum path picks this up on its own.
    expect(classifySupplyTrend(makeMomentum(1.25, 1.03))).toBe("flat");
  });

  it("volume meaningful but price flat → flat (both signals required)", () => {
    expect(classifySupplyTrend(makeMomentum(1.03, 1.5))).toBe("flat");
  });

  it("null momentumRatio → flat", () => {
    expect(classifySupplyTrend(makeMomentum(null, 1.5))).toBe("flat");
  });

  it("null volumeRatio → flat", () => {
    expect(classifySupplyTrend(makeMomentum(1.25, null))).toBe("flat");
  });

  it("both null → flat", () => {
    expect(classifySupplyTrend(makeMomentum(null, null))).toBe("flat");
  });
});

describe("classifySupplyTrend — Eric Hartman real data (2026-07-01 prod probe)", () => {
  it("Eric Hartman 7-week: vol=1.421 + price=0.922 → supply_flood", () => {
    // Real snapshot: volume ↑ 42%, avg price ↓ 8%. Classic supply-flood
    // pattern — cards being sold faster but at lower prices. Bearish
    // leading indicator. Aligned with the "hot prospect starting to fade"
    // pattern DailyIQ should surface.
    expect(classifySupplyTrend(makeMomentum(0.922, 1.421))).toBe("supply_flood");
  });
});

describe("supplyTrendProjectionAdjuster", () => {
  it("supply_dry → +5% boost", () => {
    expect(supplyTrendProjectionAdjuster("supply_dry")).toBe(SUPPLY_DRY_BOOST);
    expect(SUPPLY_DRY_BOOST).toBe(1.05);
  });

  it("supply_flood → -5% discount", () => {
    expect(supplyTrendProjectionAdjuster("supply_flood")).toBe(SUPPLY_FLOOD_DISCOUNT);
    expect(SUPPLY_FLOOD_DISCOUNT).toBe(0.95);
  });

  it("demand_growth → 1.0 (no nudge; already reflected in momentum ratio)", () => {
    expect(supplyTrendProjectionAdjuster("demand_growth")).toBe(1.0);
  });

  it("demand_crash → 1.0 (no nudge; already reflected in momentum ratio)", () => {
    expect(supplyTrendProjectionAdjuster("demand_crash")).toBe(1.0);
  });

  it("flat → 1.0", () => {
    expect(supplyTrendProjectionAdjuster("flat")).toBe(1.0);
  });
});
