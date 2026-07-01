/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM — pins the "prefer matched-cohort
 * over raw signal" behavior in evaluateMomentumProjection.
 *
 * When trendSnapshot.matchedCohort is present (populated by the
 * background job's cache write), the projection uses matchedCohort.
 * medianRatio and NOT momentum.momentumRatio. The Eric Hartman
 * scenario captured from 2026-07-01 prod is one of the pins.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { evaluateMomentumProjection } from "../src/services/compiq/momentumProjection.service";
import type {
  PlayerTrendSnapshot,
  PlayerMatchedCohortSummary,
} from "../src/services/playerTrend/playerTrend.types";

const ORIG_FLAG = process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED;

beforeEach(() => {
  process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = "true";
});
afterEach(() => {
  if (ORIG_FLAG === undefined) delete process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED;
  else process.env.PLAYER_MOMENTUM_PROJECTION_ENABLED = ORIG_FLAG;
});

function makeCohort(medianRatio: number, cohortSize: number = 24): PlayerMatchedCohortSummary {
  return {
    medianRatio,
    meanRatio: medianRatio + 0.02,
    cohortSize,
    latestWeekActiveCards: cohortSize + 3,
    latestWeekStart: "2026-06-22",
    priorWindowWeeksCount: 4,
    computedAtMs: 1_700_000_000_000,
  };
}

function makeSnapshot(
  overrides: Partial<PlayerTrendSnapshot> = {},
): PlayerTrendSnapshot {
  const base: PlayerTrendSnapshot = {
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
      momentumRatio: 0.922, // Eric Hartman raw signal — MISLEADING
      volumeRatio: 1.421,
    },
    supplyTrend: "supply_flood", // What PR #230 (mis-)classified this as
    matchedCohort: null,
    ...overrides,
  };
  return { ...base, ...overrides } as PlayerTrendSnapshot;
}

describe("evaluateMomentumProjection — matched-cohort preference (CF-MATCHED-COHORT-PLAYER-MOMENTUM)", () => {
  it("uses matched-cohort.medianRatio when present, IGNORES raw momentumRatio", () => {
    // Eric Hartman prod scenario:
    //   raw signal: 0.922 (says -8% — WRONG)
    //   matched-cohort: 1.363 (says +36% — CORRECT)
    // With matchedCohort present, projection should use 1.363 (capped).
    const snap = makeSnapshot({
      matchedCohort: makeCohort(1.363),
      // momentum.momentumRatio is 0.922 in the default — should be ignored
    });
    const r = evaluateMomentumProjection({
      playerName: "Eric Hartman",
      trendSnapshot: snap,
      lastCardSalePrice: 100,
      lastCardSaleDate: "2026-05-15",
      directCompCount: 1,
      daysSinceNewestComp: 45,
    });
    if (!r.applied) throw new Error("expected applied");
    // Uses 1.363 (capped to 1.363 since it's < 2.0)
    expect(r.attribution.activeRatio).toBe(1.363);
    expect(r.attribution.activeRatioSource).toBe("matched_cohort");
    expect(r.attribution.cappedRatio).toBe(1.363);
    // Raw ratio still emitted for attribution transparency
    expect(r.attribution.playerMomentumRatio).toBe(0.922);
  });

  it("projected price uses matched-cohort × lastCardSale (not raw × lastCardSale)", () => {
    // With supply_flood: adjuster = 0.95. matchedCohort.medianRatio = 1.363.
    // projectedPrice = 100 × 1.363 × 0.95 = 129.485 (floating-point rounds
    // to 129.48 at 2dp — half-to-even + FP imprecision).
    const snap = makeSnapshot({
      matchedCohort: makeCohort(1.363),
      supplyTrend: "supply_flood",
    });
    const r = evaluateMomentumProjection({
      playerName: "Eric Hartman",
      trendSnapshot: snap,
      lastCardSalePrice: 100,
      lastCardSaleDate: "2026-05-15",
      directCompCount: 1,
      daysSinceNewestComp: 45,
    });
    if (!r.applied) throw new Error("expected applied");
    expect(r.projectedPrice).toBeCloseTo(129.49, 1);
    expect(r.attribution.supplyTrendAdjuster).toBe(0.95);
  });

  it("falls back to raw momentum when matchedCohort is null (backward compat)", () => {
    const snap = makeSnapshot({
      matchedCohort: null,
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
        momentumRatio: 1.25,
        volumeRatio: 1.25,
      },
      supplyTrend: "demand_growth",
    });
    const r = evaluateMomentumProjection({
      playerName: "Fallback Player",
      trendSnapshot: snap,
      lastCardSalePrice: 100,
      lastCardSaleDate: "2026-05-15",
      directCompCount: 1,
      daysSinceNewestComp: 45,
    });
    if (!r.applied) throw new Error("expected applied");
    expect(r.attribution.activeRatioSource).toBe("raw_weekly_avg");
    expect(r.attribution.activeRatio).toBe(1.25);
    expect(r.projectedPrice).toBe(125);
  });

  it("cohort ratio still capped at 2.0 upside", () => {
    const snap = makeSnapshot({ matchedCohort: makeCohort(3.5), supplyTrend: "demand_growth" });
    const r = evaluateMomentumProjection({
      playerName: "Test",
      trendSnapshot: snap,
      lastCardSalePrice: 100,
      lastCardSaleDate: "2026-05-15",
      directCompCount: 1,
      daysSinceNewestComp: 45,
    });
    if (!r.applied) throw new Error("expected applied");
    expect(r.attribution.activeRatio).toBe(3.5); // raw value preserved for attribution
    expect(r.attribution.cappedRatio).toBe(2.0); // clamped
    expect(r.projectedPrice).toBe(200);
  });

  it("cohort ratio at exactly 1.0 → skipped (below MIN_TREND_DELTA)", () => {
    const snap = makeSnapshot({ matchedCohort: makeCohort(1.0) });
    const r = evaluateMomentumProjection({
      playerName: "Test",
      trendSnapshot: snap,
      lastCardSalePrice: 100,
      lastCardSaleDate: "2026-05-15",
      directCompCount: 1,
      daysSinceNewestComp: 45,
    });
    expect(r).toEqual({ applied: false, reason: "trend_below_threshold" });
  });
});
