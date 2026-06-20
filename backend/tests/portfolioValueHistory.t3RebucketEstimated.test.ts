// CF-A(a) — Phase 5 integration for T3 base-auto floor re-bucket (2026-06-20).
//
// Asserts that holdings persisted with the T3-stamped shape (FMV null +
// valuationStatus "estimated" + estimatedValue/estimateLow/estimateHigh +
// estimateBasis "base_auto_floor") land in the estimated bucket — NOT
// observed, NOT pending. The invariant: a mixed portfolio's displayableTotal
// is UNCHANGED vs the pre-CF behavior; only the observed/estimated split
// shifts so a known-weak base-auto anchor isn't counted as observed market.

import { describe, it, expect } from "vitest";
import { computeSnapshotFromHoldings } from "../src/services/portfolioiq/portfolioValueHistory.service.js";

// Same factory shape Phase 5's existing test file uses, adapted for the
// T3 wire-stamp produced by autoPriceHolding / repriceHoldingsForUser.
function t3Rebucketed(
  id: string,
  estimatedValue: number,
  estimateLow: number,
  estimateHigh: number,
  qty = 1,
): any {
  return {
    id,
    playerName: "Drake Baldwin",
    cardTitle: "2022 Bowman Chrome Blue Refractor Auto /150",
    quantity: qty,
    // The CF-A(a) T3 stamp:
    fairMarketValue: null,
    valuationStatus: "estimated",
    estimatedValue,
    estimateLow,
    estimateHigh,
    estimateConfidence: "rough",
    estimateBasis: "base_auto_floor",
    isEstimate: true,
  };
}

function observed(id: string, fmv: number, qty = 1): any {
  return {
    id,
    playerName: "Player",
    cardTitle: "Card",
    quantity: qty,
    valuationStatus: "observed",
    fairMarketValue: fmv,
  };
}

describe("CF-A(a) — Phase 5 routing for T3 re-bucketed holdings", () => {
  it("T3 holding lands in estimated bucket, not observed", () => {
    const s = computeSnapshotFromHoldings([
      t3Rebucketed("t3-1", 82, 60, 100),
    ]);
    expect(s.observedValue).toBe(0);
    expect(s.estimatedValue).toBe(82);
    expect(s.rangeLow).toBe(60);
    expect(s.rangeHigh).toBe(100);
    expect(s.observedCount).toBe(0);
    expect(s.estimatedCount).toBe(1);
    expect(s.pendingCount).toBe(0);
    expect(s.holdingCount).toBe(1);
    expect(s.displayableTotal).toBe(82);  // observedValue + estimatedValue
  });

  it("mixed portfolio invariant: displayableTotal unchanged vs hypothetical T3-as-observed; only the split shifts", () => {
    // Pre-CF behavior (T3 stamped as observed): one observed FMV $82, one
    // observed FMV $200 → displayableTotal $282, observed bucket $282.
    const preCfHypothetical = computeSnapshotFromHoldings([
      observed("h1", 82),
      observed("h2", 200),
    ]);

    // Post-CF behavior (T3 re-bucketed): one estimated $82, one observed $200
    // → displayableTotal STILL $282; observed shrinks to $200, estimated $82.
    const postCfActual = computeSnapshotFromHoldings([
      t3Rebucketed("h1", 82, 60, 100),
      observed("h2", 200),
    ]);

    expect(postCfActual.displayableTotal).toBe(preCfHypothetical.displayableTotal);
    expect(postCfActual.displayableTotal).toBe(282);
    expect(postCfActual.observedValue).toBe(200);            // shrunk from 282
    expect(postCfActual.estimatedValue).toBe(82);             // grew from 0
    expect(postCfActual.observedCount).toBe(1);
    expect(postCfActual.estimatedCount).toBe(1);
    expect(postCfActual.pendingCount).toBe(0);
  });

  it("T3 with qty>1 contributes estimatedValue × qty + range bounds × qty", () => {
    const s = computeSnapshotFromHoldings([
      t3Rebucketed("h-qty3", 100, 80, 120, 3),
    ]);
    expect(s.estimatedValue).toBe(300);
    expect(s.rangeLow).toBe(240);
    expect(s.rangeHigh).toBe(360);
    expect(s.estimatedCount).toBe(1);  // one HOLDING (not three)
  });

  it("regression: a holding with FMV null AND valuationStatus undefined is still pending (not silently estimated)", () => {
    // The path-(b) variant-mismatch short-circuit produces a holding with
    // FMV null + valuationStatus undefined (NOT "estimated"). Phase 5 must
    // continue routing those to pending, not into the estimated bucket.
    const pathBHolding: any = {
      id: "p1",
      playerName: "Eric Hartman",
      cardTitle: "2026 Bowman Chrome Eric Hartman Blue X-Fractor Auto /150",
      quantity: 1,
      fairMarketValue: null,
      // valuationStatus: undefined
      // estimatedValue: undefined
      // estimateBasis: undefined
    };
    const s = computeSnapshotFromHoldings([pathBHolding]);
    expect(s.pendingCount).toBe(1);
    expect(s.estimatedCount).toBe(0);
    expect(s.observedCount).toBe(0);
    expect(s.estimatedValue).toBe(0);
    expect(s.observedValue).toBe(0);
  });
});
