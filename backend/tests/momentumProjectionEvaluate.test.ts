/**
 * CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION — pins evaluateMomentumProjection.
 *
 * Every trigger-skip path + the "applied" happy path with cap enforcement
 * and confidence downgrade. Env flag is stubbed per-test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateMomentumProjection,
  isMomentumProjectionEnabled,
  isThinCompCard,
  type MomentumProjectionInput,
} from "../src/services/compiq/momentumProjection.service";
import type { PlayerTrendSnapshot } from "../src/services/playerTrend/playerTrend.types";

const ORIG_FLAG = process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED;

beforeEach(() => {
  process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = "true";
});
afterEach(() => {
  if (ORIG_FLAG === undefined) delete process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED;
  else process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = ORIG_FLAG;
});

function makeSnapshot(overrides: Partial<PlayerTrendSnapshot> = {}): PlayerTrendSnapshot {
  return {
    player: "Test Player",
    providerName: "cardhedge",
    capturedAtMs: 1_700_000_000_000,
    totalSales30d: 2000,
    momentum: {
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
      momentumRatio: 1.25, // 25% up
      volumeRatio: 1.25,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<MomentumProjectionInput> = {}): MomentumProjectionInput {
  return {
    playerName: "Test Player",
    trendSnapshot: makeSnapshot(),
    lastCardSalePrice: 100,
    lastCardSaleDate: "2026-05-01",
    directCompCount: 1,
    daysSinceNewestComp: 45,
    ...overrides,
  };
}

describe("isMomentumProjectionEnabled", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["false", false],
    ["1", false],
    ["yes", false],
    ["", false],
  ])("env=%s → %s", (val, expected) => {
    process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = val;
    expect(isMomentumProjectionEnabled()).toBe(expected);
  });

  it("unset env → false", () => {
    delete process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED;
    expect(isMomentumProjectionEnabled()).toBe(false);
  });
});

describe("isThinCompCard", () => {
  it.each([
    [0, null, true],
    [1, null, true],
    [2, null, true],
    [3, 10, false],   // 3 comps + fresh → not thin
    [3, 30, false],
    [3, 61, true],    // 3 comps but stale → thin
    [10, 100, true],  // many comps but all very stale → thin
    [10, 60, false],  // 10 comps, 60d exactly → NOT thin (boundary)
  ])("count=%s days=%s → %s", (count, days, expected) => {
    expect(isThinCompCard(count, days)).toBe(expected);
  });
});

describe("evaluateMomentumProjection — skip paths", () => {
  it("skips when flag disabled", () => {
    process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = "false";
    const r = evaluateMomentumProjection(makeInput());
    expect(r).toEqual({ applied: false, reason: "flag_disabled" });
  });

  it("skips when card has enough fresh comps (not thin)", () => {
    const r = evaluateMomentumProjection(makeInput({ directCompCount: 5, daysSinceNewestComp: 10 }));
    expect(r).toEqual({ applied: false, reason: "not_thin_comp" });
  });

  it("skips when no trend snapshot available", () => {
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: null }));
    expect(r).toEqual({ applied: false, reason: "no_trend_snapshot" });
  });

  it("skips when player's latest week has < 50 sales", () => {
    const snap = makeSnapshot({
      momentum: {
        ...makeSnapshot().momentum,
        latestCompleteWeek: { weekStart: "x", weekEnd: "x", count: 30, totalDollars: 3000, avgSale: 100 },
      },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap }));
    expect(r).toEqual({ applied: false, reason: "player_week_too_thin" });
  });

  it("skips when momentumRatio is null", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: null },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap }));
    expect(r).toEqual({ applied: false, reason: "no_momentum_ratio" });
  });

  it("skips when trend is below threshold (|1 - ratio| < 0.05)", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: 1.03 },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap }));
    expect(r).toEqual({ applied: false, reason: "trend_below_threshold" });
  });

  it("skips when lastCardSalePrice is null", () => {
    const r = evaluateMomentumProjection(makeInput({ lastCardSalePrice: null }));
    expect(r).toEqual({ applied: false, reason: "no_last_card_sale" });
  });

  it("skips when lastCardSalePrice is 0", () => {
    const r = evaluateMomentumProjection(makeInput({ lastCardSalePrice: 0 }));
    expect(r).toEqual({ applied: false, reason: "no_last_card_sale" });
  });
});

describe("evaluateMomentumProjection — applied paths", () => {
  it("happy path: 25% up projection, uncapped, confidence downgraded", () => {
    const r = evaluateMomentumProjection(makeInput());
    if (!r.applied) throw new Error("expected applied");
    // 100 × 1.25 = 125
    expect(r.projectedPrice).toBe(125);
    // Confidence: 0.5 - 0.25 * 0.4 = 0.4
    expect(r.confidence).toBe(0.4);
    expect(r.attribution.playerMomentumRatio).toBe(1.25);
    expect(r.attribution.cappedRatio).toBe(1.25);
    expect(r.attribution.providerName).toBe("cardhedge");
  });

  it("caps upside at 2.0× — runaway 5× ratio → 2× projected", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: 5.0 },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap, lastCardSalePrice: 100 }));
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBe(200); // 100 × 2.0
    expect(r.attribution.cappedRatio).toBe(2.0);
    expect(r.attribution.playerMomentumRatio).toBe(5.0);
  });

  it("caps downside at 0.5× — crashed 0.2 ratio → 0.5× projected", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: 0.2 },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap, lastCardSalePrice: 100 }));
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBe(50); // 100 × 0.5
    expect(r.attribution.cappedRatio).toBe(0.5);
  });

  it("confidence is symmetric on downside — 25% down → 0.4", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: 0.75 },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap }));
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBe(75);
    expect(r.confidence).toBe(0.4);
  });

  it("confidence floor is 0.15 — 100% cap-crash → 0.15", () => {
    const snap = makeSnapshot({
      momentum: { ...makeSnapshot().momentum, momentumRatio: 3.0 },
    });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap, lastCardSalePrice: 100 }));
    if (!r.applied) throw new Error("expected applied");
    // cappedRatio = 2.0, delta = 1.0, conf = max(0.15, 0.5 - 1.0*0.4) = max(0.15, 0.1) = 0.15
    expect(r.confidence).toBe(0.15);
  });

  it("carries provider name for eBay-direct migration observability", () => {
    const snap = makeSnapshot({ providerName: "ebay-direct" });
    const r = evaluateMomentumProjection(makeInput({ trendSnapshot: snap }));
    if (!r.applied) throw new Error("expected applied");
    expect(r.attribution.providerName).toBe("ebay-direct");
  });

  it("fires on thin comps by count (0 comps + stale)", () => {
    const r = evaluateMomentumProjection(
      makeInput({ directCompCount: 0, daysSinceNewestComp: null, lastCardSalePrice: 100 }),
    );
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBe(125);
  });

  it("fires on thin comps by age (3 comps but all > 60d)", () => {
    const r = evaluateMomentumProjection(
      makeInput({ directCompCount: 3, daysSinceNewestComp: 90, lastCardSalePrice: 100 }),
    );
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBe(125);
  });
});
