/**
 * CF-PLAYER-MOMENTUM-THIN-COMP-PROJECTION — pins the vendor-neutral
 * momentum computation.
 *
 * Anchored on the actual Eric Hartman 8-week bucket cohort captured
 * from prod on 2026-07-01 (via CH /cards/sales-stats-by-player). Real
 * shapes = catches drift when a future provider ships wrong.
 */

import { describe, it, expect } from "vitest";
import { computeMomentumFromNormalizedWeeks } from "../src/services/playerTrend/momentum.compute";
import type { NormalizedWeeklySales } from "../src/services/playerTrend/playerTrend.types";

const ERIC_HARTMAN_8WK: NormalizedWeeklySales[] = [
  { weekStart: "2026-05-11", weekEnd: "2026-05-17", count: 247, totalDollars: 25946.31, avgSale: 105.05 },
  { weekStart: "2026-05-18", weekEnd: "2026-05-24", count: 392, totalDollars: 34153.98, avgSale: 87.13 },
  { weekStart: "2026-05-25", weekEnd: "2026-05-31", count: 344, totalDollars: 26675.15, avgSale: 77.54 },
  { weekStart: "2026-06-01", weekEnd: "2026-06-07", count: 419, totalDollars: 30367.00, avgSale: 72.47 },
  { weekStart: "2026-06-08", weekEnd: "2026-06-14", count: 397, totalDollars: 54724.06, avgSale: 137.84 },
  { weekStart: "2026-06-15", weekEnd: "2026-06-21", count: 658, totalDollars: 73353.84, avgSale: 111.48 },
  { weekStart: "2026-06-22", weekEnd: "2026-06-28", count: 646, totalDollars: 59482.28, avgSale: 92.08 },
];

describe("computeMomentumFromNormalizedWeeks", () => {
  it("returns null-heavy shape on empty input", () => {
    const r = computeMomentumFromNormalizedWeeks([]);
    expect(r.latestCompleteWeek).toBeNull();
    expect(r.momentumRatio).toBeNull();
    expect(r.volumeRatio).toBeNull();
    expect(r.priorWeeksCount).toBe(0);
  });

  it("returns null-heavy shape when only one week is available", () => {
    const r = computeMomentumFromNormalizedWeeks(ERIC_HARTMAN_8WK.slice(0, 1));
    expect(r.momentumRatio).toBeNull();
  });

  it("computes correct momentum + volume ratios for Eric Hartman 7-week cohort", () => {
    const r = computeMomentumFromNormalizedWeeks(ERIC_HARTMAN_8WK);
    expect(r.latestCompleteWeek?.weekStart).toBe("2026-06-22");
    expect(r.latestCompleteWeek?.count).toBe(646);
    expect(r.latestCompleteWeek?.avgSale).toBe(92.08);
    // Prior mean of avgSale across weeks 2..6 (indices 2-5, 4 weeks): mean of [77.54, 72.47, 137.84, 111.48] = 99.83
    expect(r.priorMeanAvgSale).toBe(99.83);
    expect(r.priorWeeksCount).toBe(4);
    // 92.08 / 99.83 ≈ 0.922
    expect(r.momentumRatio).toBeCloseTo(0.922, 2);
    // 646 / mean([344, 419, 397, 658]) = 646 / 454.5 ≈ 1.421
    expect(r.volumeRatio).toBeCloseTo(1.421, 2);
  });

  it("prior-window is clamped: 8 weeks in, only last 4 used for mean", () => {
    const r = computeMomentumFromNormalizedWeeks(ERIC_HARTMAN_8WK, 4);
    expect(r.priorWeeksCount).toBe(4);
    // Same 99.83 as above — the first 2 weeks (105.05, 87.13) are dropped.
    expect(r.priorMeanAvgSale).toBe(99.83);
  });

  it("respects custom priorWeekWindow (2 weeks)", () => {
    const r = computeMomentumFromNormalizedWeeks(ERIC_HARTMAN_8WK, 2);
    expect(r.priorWeeksCount).toBe(2);
    // Prior mean of the 2 weeks before latest: [137.84, 111.48] = 124.66
    expect(r.priorMeanAvgSale).toBe(124.66);
    // 92.08 / 124.66 ≈ 0.739
    expect(r.momentumRatio).toBeCloseTo(0.739, 2);
  });

  it("returns null momentumRatio when priorMeanAvgSale is 0 (all zero-priced prior weeks)", () => {
    const buckets: NormalizedWeeklySales[] = [
      { weekStart: "w1", weekEnd: "w1", count: 5, totalDollars: 0, avgSale: 0 },
      { weekStart: "w2", weekEnd: "w2", count: 5, totalDollars: 0, avgSale: 0 },
      { weekStart: "w3", weekEnd: "w3", count: 10, totalDollars: 100, avgSale: 10 },
    ];
    const r = computeMomentumFromNormalizedWeeks(buckets);
    expect(r.momentumRatio).toBeNull(); // division by zero guard
  });
});
