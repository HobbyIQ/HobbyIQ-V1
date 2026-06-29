/**
 * CF-NEAREST-ANCHOR-WIRE (2026-06-29) — ADDITIVE INVARIANT.
 *
 * `nearestGradedAnchor` is persisted on PortfolioHolding when the
 * grade-ladder fallback rescued an estimate. Pre-CF, the field was
 * NOT in the wire shape — iOS reading from the inventory endpoint
 * never saw it even though the data was in Cosmos. This CF adds it
 * to PortfolioHoldingWire via conditional-spread (matches the
 * lastSaleSurface / modelExpectation pattern) so:
 *
 *   1. Holding WITHOUT nearestGradedAnchor → wire key omitted entirely
 *      (byte-identical to pre-CF for the universal case)
 *   2. Holding WITH nearestGradedAnchor → wire surfaces the full
 *      snapshot (grade, price, daysOld, sampleSize, confidence) so
 *      iOS can render "Last sold: PSA 9 $1325 · 236 days ago"
 */
import { describe, expect, it } from "vitest";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

const baseHolding: PortfolioHolding = {
  id: "h-1",
  playerName: "Mickey Mantle",
  cardYear: 1952,
  product: "Topps",
  parallel: "Base",
  quantity: 1,
  purchasePrice: 100,
  totalCostBasis: 100,
};

describe("CF-NEAREST-ANCHOR-WIRE — composeHoldingWireShape", () => {
  it("holding WITHOUT nearestGradedAnchor → wire key absent (byte-identical pre-CF)", () => {
    const wire = composeHoldingWireShape({ ...baseHolding });
    expect("nearestGradedAnchor" in wire).toBe(false);
  });

  it("holding WITH nearestGradedAnchor → wire surfaces the full snapshot", () => {
    const wire = composeHoldingWireShape({
      ...baseHolding,
      nearestGradedAnchor: {
        grade: "PSA 9",
        price: 1325,
        daysOld: 236,
        sampleSize: 3,
        confidence: 0.42,
      },
    });
    expect(wire.nearestGradedAnchor).toEqual({
      grade: "PSA 9",
      price: 1325,
      daysOld: 236,
      sampleSize: 3,
      confidence: 0.42,
    });
  });

  it("vintage HOF case from 2026-06-29 volume test: 1952 Mantle ladder fallback round-trips", () => {
    // After PR #180 (vintage-multipliers) + the sanity gate from PR #177,
    // a Mantle PSA 8 anchor at $1.83M with cardYear=1952 routes through
    // the vintage table at 5000+ tier (19.3×). The ladder rescue persists
    // the anchor so iOS shows "based on PSA 8 sale $1,830,000".
    const wire = composeHoldingWireShape({
      ...baseHolding,
      cardYear: 1952,
      nearestGradedAnchor: {
        grade: "PSA 8",
        price: 1830000,
        daysOld: 14,
        sampleSize: 1,
        confidence: 0.3,
      },
    });
    expect(wire.nearestGradedAnchor?.grade).toBe("PSA 8");
    expect(wire.nearestGradedAnchor?.price).toBe(1830000);
    expect(wire.nearestGradedAnchor?.daysOld).toBe(14);
  });

  it("byte-identical guarantee: no extra keys leak on holdings without the anchor", () => {
    // Defensive: composeHoldingWireShape should not introduce stray
    // nearestGradedAnchor=null / undefined / {} on holdings that don't
    // have the field. The conditional-spread pattern is what enforces
    // this; this test pins it against accidental regression.
    const wire = composeHoldingWireShape({ ...baseHolding });
    const json = JSON.parse(JSON.stringify(wire));
    expect(json.nearestGradedAnchor).toBeUndefined();
    expect(Object.keys(json)).not.toContain("nearestGradedAnchor");
  });
});
