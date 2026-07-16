// CF-RESCUE-TREND-PREDICTION (Drew, 2026-07-13, PR #407) — verifies
// pooled-comp trend + predicted price on the resolver rescue path.
// Cardsight-only SKUs now get our full engine output (FMV + trend +
// predictedPrice) computed off their own raw records, not just FMV.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  computePooledTrend,
  computePooledPrediction,
  pooledTrendToTrendIQShape,
  overlayResolverRescue,
} from "../src/services/compiq/resolverFallbackHelper.js";
import * as resolver from "../src/services/compiq/catalogResolver.service.js";

const NOW = Date.parse("2026-07-15T00:00:00Z");

function saleAt(daysAgo: number, price: number) {
  const ms = NOW - daysAgo * 86_400_000;
  return { saleDate: new Date(ms).toISOString(), price };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computePooledTrend", () => {
  it("returns 'up' when recent 14d median > older 15-45d median by > 3%", () => {
    const raw = [
      saleAt(3, 120), saleAt(5, 110), saleAt(10, 130),   // recent window: median 120
      saleAt(20, 90), saleAt(25, 100), saleAt(35, 85),   // older window: median 90
    ];
    const trend = computePooledTrend(raw, NOW);
    expect(trend).not.toBeNull();
    expect(trend!.direction).toBe("up");
    expect(trend!.pctChange).toBeGreaterThan(3);
    expect(trend!.recentCount).toBe(3);
    expect(trend!.olderCount).toBe(3);
  });

  it("returns 'down' when recent median < older by > 3%", () => {
    const raw = [
      saleAt(2, 80), saleAt(6, 85),
      saleAt(18, 120), saleAt(22, 130), saleAt(40, 115),
    ];
    const trend = computePooledTrend(raw, NOW);
    expect(trend!.direction).toBe("down");
    expect(trend!.pctChange).toBeLessThan(-3);
  });

  it("returns 'flat' when the change is inside the ±3% deadband", () => {
    const raw = [
      saleAt(4, 100), saleAt(7, 101), saleAt(12, 99),
      saleAt(20, 100), saleAt(30, 101), saleAt(40, 99),
    ];
    const trend = computePooledTrend(raw, NOW);
    expect(trend!.direction).toBe("flat");
  });

  it("clamps pctChange to ±50", () => {
    const raw = [
      saleAt(2, 1000), saleAt(4, 1100), saleAt(6, 950),
      saleAt(20, 50), saleAt(25, 40), saleAt(35, 60),
    ];
    const trend = computePooledTrend(raw, NOW);
    expect(trend!.pctChange).toBe(50);
    expect(trend!.multiplier).toBe(1.5);
  });

  it("returns null when either window has < 2 records", () => {
    const raw = [saleAt(3, 100), saleAt(20, 90), saleAt(30, 95)];   // recent=1
    expect(computePooledTrend(raw, NOW)).toBeNull();
  });

  it("drops future-dated and undated records", () => {
    const raw = [
      saleAt(-5, 999),   // future — dropped
      { saleDate: null, price: 999 },   // undated — dropped
      saleAt(3, 100), saleAt(10, 110),
      saleAt(20, 90), saleAt(35, 95),
    ];
    const trend = computePooledTrend(raw, NOW);
    expect(trend!.recentCount).toBe(2);
    expect(trend!.olderCount).toBe(2);
  });
});

describe("computePooledPrediction", () => {
  const upTrend = {
    pctChange: 20,
    multiplier: 1.2,
    direction: "up" as const,
    recentMedian: 120,
    olderMedian: 100,
    recentCount: 5,
    olderCount: 5,
  };

  it("returns predictedPrice = FMV × trend multiplier", () => {
    const pred = computePooledPrediction(500, upTrend);
    expect(pred).not.toBeNull();
    expect(pred!.predictedPrice).toBe(600);
  });

  it("range widens on low sample counts (uncertainty)", () => {
    const lowSample = { ...upTrend, recentCount: 2, olderCount: 2 };
    const pred = computePooledPrediction(500, lowSample);
    // n=4 → 0.30 spread → low=420, high=780
    expect(pred!.predictedPriceRange.low).toBe(420);
    expect(pred!.predictedPriceRange.high).toBe(780);
  });

  it("range tightens on high sample counts", () => {
    const highSample = { ...upTrend, recentCount: 15, olderCount: 15 };
    const pred = computePooledPrediction(500, highSample);
    // n=30 → 0.10 spread → low=540, high=660
    expect(pred!.predictedPriceRange.low).toBe(540);
    expect(pred!.predictedPriceRange.high).toBe(660);
  });

  it("returns null when trend is null", () => {
    expect(computePooledPrediction(500, null)).toBeNull();
  });

  it("returns null on non-positive FMV", () => {
    expect(computePooledPrediction(0, upTrend)).toBeNull();
    expect(computePooledPrediction(-10, upTrend)).toBeNull();
  });

  it("attribution identifies the method as pooled-comp-trend", () => {
    const pred = computePooledPrediction(500, upTrend);
    expect(pred!.attribution.method).toBe("pooled-comp-trend");
    expect(pred!.attribution.trendPct).toBe(20);
  });
});

describe("pooledTrendToTrendIQShape", () => {
  it("produces the card_only coverage tier with weights 0/1/0", () => {
    const shape = pooledTrendToTrendIQShape({
      pctChange: 10,
      multiplier: 1.1,
      direction: "up",
      recentMedian: 110,
      olderMedian: 100,
      recentCount: 3,
      olderCount: 3,
    });
    expect(shape.coverage).toBe("card_only");
    expect(shape.weights).toEqual({
      playerMomentum: 0,
      cardTrajectory: 1,
      segmentTrajectory: 0,
    });
    expect(shape.components.cardTrajectory).not.toBeNull();
    expect(shape.components.playerMomentum).toBeNull();
    expect(shape.components.segmentTrajectory).toBeNull();
  });
});

describe("overlayResolverRescue — trend + prediction integration", () => {
  const query = {
    playerName: "Eric Hartman",
    cardYear: 2026,
    setName: "2026 Bowman Baseball",
    cardNumber: "CPA-EHA",
  };

  it("populates trendIQ + predictedPrice on the rescue response", async () => {
    const rawComps = [
      saleAt(3, 120), saleAt(5, 130), saleAt(10, 115),
      saleAt(20, 90), saleAt(25, 100), saleAt(35, 95),
    ];
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardsight",
        cardId: "cs-abc",
        fairMarketValue: 500,
        compCount: 6,
        freshestSaleDate: new Date(NOW - 3 * 86_400_000).toISOString(),
        confidence: "high",
        rawComps,
        gradedComps: [],
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      fairMarketValueLive: null,
      marketValue: null,
    };
    await overlayResolverRescue(response, query);
    expect(response.fairMarketValueLive).toBe(500);
    expect(response.trendIQ).toBeTruthy();
    expect(response.trendIQ.direction).toBe("up");
    expect(response.predictedPrice).toBeGreaterThan(500);
    expect(response.predictedPriceRange).toBeTruthy();
    expect(response.predictedPriceAttribution.method).toBe("pooled-comp-trend");
  });

  it("does not overwrite trendIQ or predictedPrice when the response already has them", async () => {
    const rawComps = [
      saleAt(3, 120), saleAt(5, 130), saleAt(10, 115),
      saleAt(20, 90), saleAt(25, 100), saleAt(35, 95),
    ];
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardsight",
        cardId: "cs-abc",
        fairMarketValue: 500,
        compCount: 6,
        freshestSaleDate: new Date(NOW - 3 * 86_400_000).toISOString(),
        confidence: "high",
        rawComps,
        gradedComps: [],
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      fairMarketValueLive: null,
      marketValue: null,
      trendIQ: { composite: 1.0, direction: "flat", coverage: "full" },
      predictedPrice: 400,
    };
    await overlayResolverRescue(response, query);
    expect(response.trendIQ.coverage).toBe("full");
    expect(response.predictedPrice).toBe(400);
  });

  it("leaves trendIQ null when the pooled records are too thin", async () => {
    vi.spyOn(resolver, "resolveCard").mockResolvedValue({
      winner: {
        vendor: "cardsight",
        cardId: "cs-abc",
        fairMarketValue: 500,
        compCount: 1,
        freshestSaleDate: new Date(NOW - 3 * 86_400_000).toISOString(),
        confidence: "medium",
        rawComps: [saleAt(3, 100)],
        gradedComps: [],
      },
      responses: [],
      fromCache: false,
    });
    const response: any = {
      fairMarketValueLive: null,
      marketValue: null,
    };
    await overlayResolverRescue(response, query);
    expect(response.fairMarketValueLive).toBe(500);
    expect(response.trendIQ).toBeUndefined();
    expect(response.predictedPrice).toBeUndefined();
  });
});
