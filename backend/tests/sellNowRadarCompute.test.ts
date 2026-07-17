// CF-SELL-NOW-RADAR (Drew, 2026-07-17). Pinning tests for the pure-math
// gate. Every gate branch has a test — velocity, momentum, direction,
// sparse-pool. Constants are pinned so a threshold drift can't ship
// silently.

import { describe, it, expect } from "vitest";
import {
  evaluateSellNowCandidate,
  _SELL_RADAR_DEFAULTS,
  type SellRadarCardTrend,
  type SellRadarPlayerTrend,
} from "../src/services/portfolioiq/sellNowRadarCompute.service.js";

function card(overrides: Partial<SellRadarCardTrend> = {}): SellRadarCardTrend {
  return {
    velocityPerWeek: 6,       // hot
    velocityBaseline: 2,       // typical = 2/wk → 3x multiple
    direction: "up",
    slopePerDay: 0.01,
    ...overrides,
  };
}

function player(overrides: Partial<SellRadarPlayerTrend> = {}): SellRadarPlayerTrend {
  return {
    momentum: 1.18,           // +18%
    direction: "up",
    flags: [],
    ...overrides,
  };
}

describe("sellNowRadarCompute — pinned constants", () => {
  it("locks default thresholds so drift can't ship silently", () => {
    expect(_SELL_RADAR_DEFAULTS.minVelocityMultiple).toBe(2.0);
    expect(_SELL_RADAR_DEFAULTS.minPlayerMomentum).toBe(1.10);
    expect(_SELL_RADAR_DEFAULTS.urgencyCap).toBe(10.0);
    expect(_SELL_RADAR_DEFAULTS.urgencyFloor).toBe(1.0);
  });
});

describe("evaluateSellNowCandidate — happy path", () => {
  it("flags the candidate with a human reason when all gates pass", () => {
    const r = evaluateSellNowCandidate(card(), player());
    expect(r.isCandidate).toBe(true);
    expect(r.rejectedBy).toBeNull();
    expect(r.velocityMultiple).toBeCloseTo(3.0);
    expect(r.reason).toMatch(/3\.0x baseline/);
    expect(r.reason).toMatch(/\+18%/);
  });

  it("urgencyScore = velocityMultiple x max(momentum,1), clamped to [1,10]", () => {
    // 3x velocity, 1.18 momentum → 3.54, well inside cap
    const r = evaluateSellNowCandidate(card(), player());
    expect(r.urgencyScore).toBeCloseTo(3.54, 2);
  });

  it("clamps runaway urgencyScore at cap", () => {
    // 15x velocity, 1.5 momentum → 22.5, capped at 10
    const r = evaluateSellNowCandidate(
      card({ velocityPerWeek: 30, velocityBaseline: 2 }),
      player({ momentum: 1.5 }),
    );
    expect(r.urgencyScore).toBe(10);
    expect(r.isCandidate).toBe(true);
  });
});

describe("evaluateSellNowCandidate — gate rejections", () => {
  it("rejects when card velocity multiple < 2x gate", () => {
    // velocityPerWeek = 3, baseline = 2 → 1.5x, below 2x gate
    const r = evaluateSellNowCandidate(
      card({ velocityPerWeek: 3, velocityBaseline: 2 }),
      player(),
    );
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("velocity_below_gate");
    expect(r.velocityMultiple).toBeCloseTo(1.5);
  });

  it("rejects when player momentum below 1.10", () => {
    // 1.05 momentum, direction=up but too weak
    const r = evaluateSellNowCandidate(card(), player({ momentum: 1.05 }));
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("momentum_below_gate");
  });

  it("rejects when player direction is flat", () => {
    const r = evaluateSellNowCandidate(card(), player({ direction: "flat" }));
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("player_direction_not_up");
  });

  it("rejects when player direction is down", () => {
    const r = evaluateSellNowCandidate(card(), player({ direction: "down" }));
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("player_direction_not_up");
  });

  it("rejects when card is trending down (never sell into a falling market)", () => {
    const r = evaluateSellNowCandidate(card({ direction: "down" }), player());
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("card_direction_down");
  });

  it("allows sell into flat card direction (player momentum saves it)", () => {
    // Card is flat, but strong player momentum + 3x velocity gets it through
    const r = evaluateSellNowCandidate(card({ direction: "flat" }), player());
    expect(r.isCandidate).toBe(true);
  });

  it("rejects when baseline velocity is 0 (can't compute multiple)", () => {
    const r = evaluateSellNowCandidate(
      card({ velocityPerWeek: 5, velocityBaseline: 0 }),
      player(),
    );
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("no_baseline");
  });

  it("rejects when player pool is sparse — flag beats numeric momentum", () => {
    // Momentum passes but flag says the pool isn't trustworthy
    const r = evaluateSellNowCandidate(
      card(),
      player({ momentum: 1.50, flags: ["sparse"] }),
    );
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("player_pool_sparse");
  });

  it("rejects when cardTrend is null (no comps in window)", () => {
    const r = evaluateSellNowCandidate(null, player());
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("missing_card_trend");
  });

  it("rejects when playerTrend is null", () => {
    const r = evaluateSellNowCandidate(card(), null);
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("missing_player_trend");
  });
});

describe("evaluateSellNowCandidate — options override the gates", () => {
  it("options.minVelocityMultiple = 1.5 lets a 1.5x pass", () => {
    const r = evaluateSellNowCandidate(
      card({ velocityPerWeek: 3, velocityBaseline: 2 }),
      player(),
      { minVelocityMultiple: 1.5 },
    );
    expect(r.isCandidate).toBe(true);
  });

  it("options.minPlayerMomentum = 1.20 rejects a 1.18 that would otherwise pass", () => {
    const r = evaluateSellNowCandidate(card(), player(), { minPlayerMomentum: 1.20 });
    expect(r.isCandidate).toBe(false);
    expect(r.rejectedBy).toBe("momentum_below_gate");
  });

  it("options.urgencyCap = 3 clamps a hot signal", () => {
    // Raw score would be 3 x 1.5 = 4.5, cap at 3
    const r = evaluateSellNowCandidate(
      card({ velocityPerWeek: 6, velocityBaseline: 2 }),
      player({ momentum: 1.5 }),
      { urgencyCap: 3 },
    );
    expect(r.urgencyScore).toBe(3);
  });
});
