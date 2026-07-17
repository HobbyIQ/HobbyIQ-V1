// CF-PREDICTED-MATCHED-COHORT (Drew, 2026-07-17). Pinning tests for the
// pure math extracted from compiqEstimate. Verifies the Orange Shimmer
// Hartman regression scenario: at rate +32.6%/week + $1990 MV, predicted
// must land at $2639 — matching what iOS shows on the priced-card page.

import { describe, it, expect } from "vitest";
import { computeCohortPredicted } from "../src/services/compiq/matchedCohortPredicted.js";

describe("computeCohortPredicted", () => {
  it("Orange Shimmer Hartman regression: rate +0.326 × $1990.30 → $2639.14", () => {
    const r = computeCohortPredicted(1990.30, 0.326);
    expect(r).not.toBeNull();
    expect(r!.predictedPrice).toBeCloseTo(2639.14, 2);
    expect(r!.direction).toBe("up");
    // ±8% band on 2639.13. Matches the exact values card-panel persisted
    // for cardId 1778542131154x443622612761809900 on 2026-07-17.
    expect(r!.predictedPriceRange.low).toBeCloseTo(2428.01, 2);
    expect(r!.predictedPriceRange.high).toBeCloseTo(2850.27, 2);
  });

  it("negative rate → predicted below MV, direction down", () => {
    const r = computeCohortPredicted(1000, -0.10);
    expect(r).not.toBeNull();
    expect(r!.predictedPrice).toBeCloseTo(900, 2);
    expect(r!.direction).toBe("down");
  });

  it("zero rate → predicted equals MV, direction static", () => {
    const r = computeCohortPredicted(1000, 0);
    expect(r).not.toBeNull();
    expect(r!.predictedPrice).toBeCloseTo(1000, 2);
    expect(r!.direction).toBe("static");
    expect(r!.predictedPriceRange.low).toBeCloseTo(920, 2);
    expect(r!.predictedPriceRange.high).toBeCloseTo(1080, 2);
  });

  it("returns null when marketValue is not positive", () => {
    expect(computeCohortPredicted(0, 0.3)).toBeNull();
    expect(computeCohortPredicted(-100, 0.3)).toBeNull();
    expect(computeCohortPredicted(null, 0.3)).toBeNull();
    expect(computeCohortPredicted(undefined, 0.3)).toBeNull();
  });

  it("returns null when rate is not finite", () => {
    expect(computeCohortPredicted(1000, null)).toBeNull();
    expect(computeCohortPredicted(1000, undefined)).toBeNull();
    expect(computeCohortPredicted(1000, NaN)).toBeNull();
    expect(computeCohortPredicted(1000, Infinity)).toBeNull();
  });

  it("high-momentum player: +50%/week → 1.5× MV", () => {
    const r = computeCohortPredicted(500, 0.5);
    expect(r!.predictedPrice).toBeCloseTo(750, 2);
    expect(r!.direction).toBe("up");
  });

  it("crash: -50%/week → 0.5× MV", () => {
    const r = computeCohortPredicted(500, -0.5);
    expect(r!.predictedPrice).toBeCloseTo(250, 2);
    expect(r!.direction).toBe("down");
  });

  it("range is symmetric ±8% around predicted", () => {
    const r = computeCohortPredicted(1000, 0.2);
    expect(r!.predictedPrice).toBeCloseTo(1200, 2);
    // ±8% of 1200
    expect(r!.predictedPriceRange.low).toBeCloseTo(1104, 2);
    expect(r!.predictedPriceRange.high).toBeCloseTo(1296, 2);
  });
});
