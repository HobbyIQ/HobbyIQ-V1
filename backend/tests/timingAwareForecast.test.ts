// CF-TIMING-FORECAST (Drew, 2026-07-17). Pinning tests.

import { describe, it, expect } from "vitest";
import {
  computeTimingAwareForecast,
  _PLAYER_MOMENTUM_WEIGHT,
  _VELOCITY_HOT_MULTIPLE,
  _VELOCITY_COLD_MULTIPLE,
  _MIN_WINDOW_FOR_HIGH_CONF,
  _MIN_WINDOW_FOR_MEDIUM_CONF,
} from "../src/services/portfolioiq/timingAwareForecast.service.js";
import type {
  CardTrendInputs,
  PlayerTrendInputs,
} from "../src/types/timingForecast.types.js";

function cardTrend(overrides: Partial<CardTrendInputs> = {}): CardTrendInputs {
  return {
    projectedNextSalePrice: 100,
    slopePerDay: 0,
    volatility: 0.15,
    windowSales: 25,
    latestPrice: 100,
    ...overrides,
  };
}

function playerTrend(overrides: Partial<PlayerTrendInputs> = {}): PlayerTrendInputs {
  return {
    allMomentum: 1.2,
    rawMomentum: 1.1,
    gradedMomentum: 1.5,
    playerVelocityPerWeek: 100,
    playerFlags: [],
    ...overrides,
  };
}

describe("computeTimingAwareForecast — bail-outs", () => {
  it("returns insufficient when both cardTrend and playerTrend are null", () => {
    const r = computeTimingAwareForecast({
      cardTrend: null,
      playerTrend: null,
      skuVelocityPerWeek: 0,
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("insufficient");
    expect(r.predictedPrice).toBe(0);
    expect(r.contributingSignals.playerMomentumSource).toBe("none");
  });

  it("returns insufficient when anchor is 0 (no projected + no latest price)", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: null, latestPrice: null }),
      playerTrend: playerTrend(),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("insufficient");
    expect(r.predictedPrice).toBe(0);
  });
});

describe("computeTimingAwareForecast — anchor + player + slope math", () => {
  it("flat slope + flat player momentum → anchor is unchanged", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.predictedPrice).toBeCloseTo(100, 0);
  });

  it("positive slope compounds over 30 days (+1%/day → ~35% over 30d)", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0.01 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    // exp(0.01 * 30) = 1.3498...
    expect(r.predictedPrice).toBeCloseTo(134.99, 0);
  });

  it("negative slope compounds down", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: -0.005 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    // exp(-0.005 * 30) = 0.8607
    expect(r.predictedPrice).toBeCloseTo(86.07, 0);
  });

  it("player momentum is dampened by PLAYER_MOMENTUM_WEIGHT", () => {
    // Raw momentum +50% (1.5). Expected multiplier = 1 + (1.5-1)*0.4 = 1.2
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0 }),
      playerTrend: playerTrend({ rawMomentum: 1.5, allMomentum: 1.5 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.predictedPrice).toBeCloseTo(120, 0);
  });

  it("pins PLAYER_MOMENTUM_WEIGHT to 0.4", () => {
    expect(_PLAYER_MOMENTUM_WEIGHT).toBe(0.4);
  });
});

describe("computeTimingAwareForecast — stratified player-momentum selection", () => {
  it("raw holding uses rawMomentum when available", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0 }),
      playerTrend: playerTrend({
        rawMomentum: 1.1, gradedMomentum: 1.5, allMomentum: 1.3,
      }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.contributingSignals.playerMomentumSource).toBe("raw");
    expect(r.contributingSignals.playerMomentumUsed).toBe(1.1);
  });

  it("graded holding uses gradedMomentum when available", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0 }),
      playerTrend: playerTrend({
        rawMomentum: 1.1, gradedMomentum: 1.5, allMomentum: 1.3,
      }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "PSA 10",
    });
    expect(r.contributingSignals.playerMomentumSource).toBe("graded");
    expect(r.contributingSignals.playerMomentumUsed).toBe(1.5);
  });

  it("falls back to allMomentum when preferred variant is null", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, slopePerDay: 0 }),
      playerTrend: playerTrend({
        rawMomentum: null, gradedMomentum: 1.5, allMomentum: 1.3,
      }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.contributingSignals.playerMomentumSource).toBe("all");
    expect(r.contributingSignals.playerMomentumUsed).toBe(1.3);
  });
});

describe("computeTimingAwareForecast — range width from volatility", () => {
  it("higher volatility → wider range", () => {
    const low = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, volatility: 0.1 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    const high = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100, volatility: 0.3 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    const lowWidth = low.priceRange.high - low.priceRange.low;
    const highWidth = high.priceRange.high - high.priceRange.low;
    expect(highWidth).toBeGreaterThan(lowWidth);
  });

  it("longer horizon widens the range (sqrt scaling)", () => {
    const short = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
      horizonDays: 30,
    });
    const long = computeTimingAwareForecast({
      cardTrend: cardTrend({ projectedNextSalePrice: 100 }),
      playerTrend: playerTrend({ rawMomentum: 1.0, allMomentum: 1.0 }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
      horizonDays: 120,
    });
    const shortW = short.priceRange.high - short.priceRange.low;
    const longW = long.priceRange.high - long.priceRange.low;
    expect(longW).toBeGreaterThan(shortW);
    // sqrt(120/30) = 2, so long range width ≈ 2× short
    expect(longW / shortW).toBeCloseTo(2, 0);
  });
});

describe("computeTimingAwareForecast — confidence", () => {
  it("high: n≥20 + stratified player + no flags", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ windowSales: 25 }),
      playerTrend: playerTrend({ rawMomentum: 1.1, playerFlags: [] }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("high");
  });

  it("medium: n≥8 + player present but flags penalize", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ windowSales: 12 }),
      playerTrend: playerTrend({ playerFlags: ["sparse"] }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("medium");
  });

  it("low: minimal card data + player data", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend({ windowSales: 3 }),
      playerTrend: playerTrend({ playerFlags: ["sparse"] }),
      skuVelocityPerWeek: 5,
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("low");
  });

  it("pins confidence thresholds", () => {
    expect(_MIN_WINDOW_FOR_HIGH_CONF).toBe(20);
    expect(_MIN_WINDOW_FOR_MEDIUM_CONF).toBe(8);
  });
});

describe("computeTimingAwareForecast — velocity classification", () => {
  it("hot when skuVelocity ≥ 2× per-sku baseline", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend(),
      playerTrend: playerTrend({ playerVelocityPerWeek: 100 }),
      skuVelocityPerWeek: 20, // baseline is 100/20=5, hot at ≥10
      currentGraderTier: "Raw",
    });
    expect(r.contributingSignals.velocitySignal).toBe("hot");
  });

  it("cold when skuVelocity ≤ 0.5× per-sku baseline", () => {
    const r = computeTimingAwareForecast({
      cardTrend: cardTrend(),
      playerTrend: playerTrend({ playerVelocityPerWeek: 100 }),
      skuVelocityPerWeek: 1, // baseline 5, cold at ≤2.5
      currentGraderTier: "Raw",
    });
    expect(r.contributingSignals.velocitySignal).toBe("cold");
  });

  it("pins velocity multiples", () => {
    expect(_VELOCITY_HOT_MULTIPLE).toBe(2.0);
    expect(_VELOCITY_COLD_MULTIPLE).toBe(0.5);
  });
});

describe("computeTimingAwareForecast — realistic Hartman-like case", () => {
  it("card up + player raw up + hot velocity → +48% forecast, high conf", () => {
    // Hartman-CPA-EHA-like: 200+ comps, slope +1.8%/day, player raw up +35%
    const r = computeTimingAwareForecast({
      cardTrend: {
        projectedNextSalePrice: 163,   // per real smoke test earlier this session
        slopePerDay: 0.018,             // +1.8%/day
        volatility: 0.15,
        windowSales: 220,
        latestPrice: 155,
      },
      playerTrend: {
        allMomentum: 1.48,
        rawMomentum: 1.35,
        gradedMomentum: null,           // no graded Hartmans yet
        playerVelocityPerWeek: 228,
        playerFlags: [],
      },
      skuVelocityPerWeek: 45,           // dominant SKU in a 20-avg baseline
      currentGraderTier: "Raw",
    });
    expect(r.confidence).toBe("high");
    expect(r.predictedPrice).toBeGreaterThan(163);          // both signals up → forecast up
    expect(r.priceRange.low).toBeLessThan(r.predictedPrice);
    expect(r.priceRange.high).toBeGreaterThan(r.predictedPrice);
    expect(r.contributingSignals.playerMomentumSource).toBe("raw");
    expect(r.contributingSignals.playerMomentumUsed).toBeCloseTo(1.35);
    expect(r.contributingSignals.velocitySignal).toBe("hot");
    expect(r.reason).toContain("high confidence");
  });
});
