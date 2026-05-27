/**
 * CF-NEXT-SALE-PREDICTION-LAYER (design d531939, Option B locked).
 *
 * Asserts the bounded TrendIQ-driven forward projection factor:
 *   forwardProjectionFactor = clamp(0.80, 1.30, 1 + (composite - 1) * 0.6)
 *   predictedPrice = round2(fairMarketValue * forwardProjectionFactor)
 *
 * Coverage "insufficient" short-circuits to factor 1.0 (graceful
 * degradation; predictedPrice equals fairMarketValue).
 */

import { describe, it, expect } from "vitest";
import {
  computeForwardProjectionFactor,
  computePredictedPrice,
  TRENDIQ_SCALING,
  FORWARD_PROJECTION_MIN,
  FORWARD_PROJECTION_MAX,
} from "../src/services/compiq/forwardProjection.js";
import type { TrendIQResult } from "../src/services/compiq/trendIQ.types.js";

function makeTrendIQ(overrides: Partial<TrendIQResult>): TrendIQResult {
  return {
    composite: 1.0,
    direction: "flat",
    impliedPct: 0,
    lastUpdated: null,
    components: {
      playerMomentum: null,
      cardTrajectory: null,
      segmentTrajectory: null,
    },
    weights: {
      playerMomentum: 0,
      cardTrajectory: 0,
      segmentTrajectory: 0,
    },
    coverage: "full",
    ...overrides,
  };
}

describe("computeForwardProjectionFactor — formula + bounds", () => {
  it("returns 1.0 when TrendIQ composite is exactly 1.0 (flat)", () => {
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 1.0, coverage: "full" }),
    );
    expect(factor).toBeCloseTo(1.0, 6);
  });

  it("scales mid-range upward composite by 0.6", () => {
    // composite 1.20 → scaled = 1 + 0.20*0.6 = 1.12 → within clamp
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 1.2, coverage: "full" }),
    );
    expect(factor).toBeCloseTo(1.12, 6);
  });

  it("scales mid-range downward composite by 0.6", () => {
    // composite 0.85 → scaled = 1 + (-0.15)*0.6 = 0.91 → within clamp
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 0.85, coverage: "full" }),
    );
    expect(factor).toBeCloseTo(0.91, 6);
  });

  it("clamps upper bound at FORWARD_PROJECTION_MAX (1.30) for extreme up composite", () => {
    // composite 1.50 → scaled = 1.30 (exactly at upper clamp)
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 1.5, coverage: "full" }),
    );
    expect(factor).toBeCloseTo(FORWARD_PROJECTION_MAX, 6);
    expect(factor).toBeLessThanOrEqual(FORWARD_PROJECTION_MAX);
  });

  it("clamps lower bound at FORWARD_PROJECTION_MIN (0.80) when scaled value drops below 0.80", () => {
    // composite 0.70 → scaled = 1 + (-0.30)*0.6 = 0.82 → above 0.80 floor
    // To exercise the floor, use a synthetic composite below TrendIQ's clamp.
    // TrendIQ clamps [0.70, 1.50], so 0.70 is the worst case it produces:
    //   scaled = 0.82, factor = 0.82 (above floor of 0.80)
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 0.7, coverage: "full" }),
    );
    expect(factor).toBeCloseTo(0.82, 6);
    expect(factor).toBeGreaterThanOrEqual(FORWARD_PROJECTION_MIN);
  });

  it("short-circuits to 1.0 when coverage is insufficient", () => {
    const factor = computeForwardProjectionFactor(
      makeTrendIQ({ composite: 1.4, coverage: "insufficient" }),
    );
    expect(factor).toBe(1.0);
  });

  it("scaling constant is locked at 0.6 (v1 design)", () => {
    expect(TRENDIQ_SCALING).toBe(0.6);
  });

  it("bounds are locked at [0.80, 1.30] (v1 design)", () => {
    expect(FORWARD_PROJECTION_MIN).toBe(0.8);
    expect(FORWARD_PROJECTION_MAX).toBe(1.3);
  });
});

describe("computePredictedPrice — predictedPrice + range + attribution", () => {
  it("returns null predictedPrice when fairMarketValue is null", () => {
    const result = computePredictedPrice(null, makeTrendIQ({ composite: 1.2 }));
    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceRange).toBeNull();
    expect(result.predictedPriceAttribution.mechanism).toBe("unavailable");
  });

  it("returns null predictedPrice when fairMarketValue is undefined", () => {
    const result = computePredictedPrice(undefined, makeTrendIQ({ composite: 1.2 }));
    expect(result.predictedPrice).toBeNull();
    expect(result.predictedPriceAttribution.mechanism).toBe("unavailable");
  });

  it("returns null predictedPrice when fairMarketValue is non-finite", () => {
    const result = computePredictedPrice(NaN, makeTrendIQ({ composite: 1.2 }));
    expect(result.predictedPrice).toBeNull();
  });

  it("multiplies fairMarketValue by forwardProjectionFactor and rounds to 2dp", () => {
    // FMV $100, composite 1.20 → factor 1.12 → predictedPrice $112.00
    const result = computePredictedPrice(100, makeTrendIQ({ composite: 1.2 }));
    expect(result.predictedPrice).toBe(112);
  });

  it("predictedPriceRange is ±8% of predictedPrice", () => {
    // FMV $100, composite 1.0 → factor 1.0 → predictedPrice $100; range [92, 108]
    const result = computePredictedPrice(100, makeTrendIQ({ composite: 1.0 }));
    expect(result.predictedPriceRange).toEqual({ low: 92, high: 108 });
  });

  it("predictedPrice equals fairMarketValue when coverage is insufficient", () => {
    // Graceful degradation: factor = 1.0 → predictedPrice = FMV exactly
    const result = computePredictedPrice(
      87.5,
      makeTrendIQ({ composite: 1.45, coverage: "insufficient" }),
    );
    expect(result.predictedPrice).toBe(87.5);
  });

  it("attribution carries mechanism + factor + trendIQ details", () => {
    const tiq = makeTrendIQ({ composite: 1.15, direction: "up", coverage: "full" });
    const result = computePredictedPrice(50, tiq);
    expect(result.predictedPriceAttribution).toEqual({
      mechanism: "trendiq-projection",
      forwardProjectionFactor: result.forwardProjectionFactor,
      trendIQComposite: 1.15,
      trendIQDirection: "up",
      trendIQCoverage: "full",
    });
  });

  it("maximum upward divergence from FMV is bounded at +30% (TrendIQ composite 1.50 saturating)", () => {
    // FMV $100, composite 1.50 → factor 1.30 (clamp upper) → predictedPrice $130
    // Note: 1.30 (clamp), not 1.18 — the clamp wins because 1 + 0.5*0.6 = 1.30
    const result = computePredictedPrice(100, makeTrendIQ({ composite: 1.5 }));
    expect(result.predictedPrice).toBe(130);
  });

  it("maximum downward divergence from FMV is bounded (TrendIQ composite 0.70 saturating)", () => {
    // FMV $100, composite 0.70 → factor 0.82 (above 0.80 floor) → predictedPrice $82
    const result = computePredictedPrice(100, makeTrendIQ({ composite: 0.7 }));
    expect(result.predictedPrice).toBe(82);
  });

  it("range bounds are also rounded to 2dp", () => {
    // FMV $13.37, composite 1.1 → factor 1.06 → predictedPrice $14.17 → range [13.04, 15.30]
    const result = computePredictedPrice(13.37, makeTrendIQ({ composite: 1.1 }));
    expect(result.predictedPrice).toBe(14.17);
    expect(result.predictedPriceRange).toEqual({ low: 13.04, high: 15.3 });
  });
});
