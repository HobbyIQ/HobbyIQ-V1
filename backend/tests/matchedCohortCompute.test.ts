/**
 * CF-MATCHED-COHORT-PLAYER-MOMENTUM — pins the compute function.
 *
 * Tests illustrate the mix-bias problem the CF solves. Same aggregate
 * data produces:
 *   - Weekly avgSale (existing) → biased signal
 *   - Matched-cohort ratio (this CF) → unbiased signal
 */

import { describe, it, expect } from "vitest";
import { computeMatchedCohortMomentum } from "../src/services/playerTrend/matchedCohort.compute";
import type { CardWeeklySalesSeries } from "../src/services/playerTrend/matchedCohort.types";

/** Build a series shortcut. Weeks are given as [weekStart, medianPrice, saleCount] tuples. */
function seriesFor(cardId: string, weeks: Array<[string, number, number]>): CardWeeklySalesSeries {
  return {
    cardId,
    grade: "Raw",
    buckets: weeks.map(([ws, mp, count]) => ({
      weekStart: ws,
      weekEnd: addDays(ws, 6),
      medianPrice: mp,
      meanPrice: mp,
      saleCount: count,
    })),
  };
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("computeMatchedCohortMomentum — empty / degenerate", () => {
  it("empty input → empty result", () => {
    const r = computeMatchedCohortMomentum([]);
    expect(r.cohort).toHaveLength(0);
    expect(r.medianRatio).toBeNull();
    expect(r.totalCardsEvaluated).toBe(0);
  });

  it("single card, single week → cohort empty (nothing to compare)", () => {
    const r = computeMatchedCohortMomentum([
      seriesFor("card-1", [["2026-06-22", 100, 5]]),
    ]);
    expect(r.cohort).toHaveLength(0);
    expect(r.medianRatio).toBeNull();
    expect(r.latestWeekActiveCards).toBe(1);
    expect(r.droppedNewOrLongTail).toBe(1); // no prior sales
  });

  it("card with sales in latest but zero in prior window → dropped", () => {
    const r = computeMatchedCohortMomentum([
      seriesFor("card-1", [
        ["2026-06-08", 100, 0], // no sales
        ["2026-06-15", 100, 0], // no sales
        ["2026-06-22", 200, 3], // latest
      ]),
    ]);
    expect(r.cohort).toHaveLength(0);
    expect(r.latestWeekActiveCards).toBe(1);
    expect(r.droppedNewOrLongTail).toBe(1);
  });
});

describe("computeMatchedCohortMomentum — mix-bias illustration", () => {
  it("MIX-BIAS example: naive avg would say -80%, matched-cohort says 0% (correct)", () => {
    // Week 2026-06-15: Superfractor sold at $5000 (rare), 5 base sold at $30 → avgSale ≈ $855
    // Week 2026-06-22: Superfractor did NOT sell, 5 base sold at $30 → avgSale = $30
    // Naive avg → -96% momentum. Matched-cohort sees base sold in both weeks at same price → 0%.
    const cohort = computeMatchedCohortMomentum([
      // Base card sold both weeks at same price
      seriesFor("base", [
        ["2026-06-15", 30, 5],
        ["2026-06-22", 30, 5],
      ]),
      // Superfractor: sold only in the earlier week
      seriesFor("superfractor", [
        ["2026-06-15", 5000, 1],
        // No entry for 2026-06-22
      ]),
    ]);
    expect(cohort.cohort).toHaveLength(1);
    expect(cohort.cohort[0].cardId).toBe("base");
    expect(cohort.medianRatio).toBe(1.0); // no change on the matched card
  });

  it("matched-cohort correctly reports 25% up when all matched cards moved +25%", () => {
    const r = computeMatchedCohortMomentum([
      seriesFor("card-1", [
        ["2026-06-08", 100, 4],
        ["2026-06-15", 100, 5],
        ["2026-06-22", 125, 6],
      ]),
      seriesFor("card-2", [
        ["2026-06-08", 200, 3],
        ["2026-06-15", 200, 3],
        ["2026-06-22", 250, 3],
      ]),
    ]);
    expect(r.cohort).toHaveLength(2);
    expect(r.medianRatio).toBe(1.25);
    expect(r.meanRatio).toBe(1.25);
  });

  it("median is robust to a single outlier card that spiked wildly", () => {
    // 3 cards: two flat at 1.0, one absurd 10× "spike" (probably a data glitch).
    // Median should be 1.0; mean would be misleadingly high.
    const r = computeMatchedCohortMomentum([
      seriesFor("card-1", [["2026-06-15", 100, 5], ["2026-06-22", 100, 5]]),
      seriesFor("card-2", [["2026-06-15", 100, 5], ["2026-06-22", 100, 5]]),
      seriesFor("card-3", [["2026-06-15", 100, 5], ["2026-06-22", 1000, 1]]),
    ]);
    expect(r.cohort).toHaveLength(3);
    expect(r.medianRatio).toBe(1.0);
    // Mean would be (1 + 1 + 10) / 3 ≈ 4.0 — showing the median's value
    expect(r.meanRatio).toBe(4.0);
  });

  it("prior-window uses weighted median across weeks (heavy-volume week dominates)", () => {
    // Prior 4 weeks: three at $50 each with 1 sale, one at $100 with 100 sales.
    // Weighted median should favor the $100 week (higher weight).
    // Latest week: $110 with 5 sales. Ratio = 110/100 = 1.1.
    const r = computeMatchedCohortMomentum([
      seriesFor("card-1", [
        ["2026-05-25", 50, 1],
        ["2026-06-01", 50, 1],
        ["2026-06-08", 50, 1],
        ["2026-06-15", 100, 100], // heavy volume week
        ["2026-06-22", 110, 5],   // latest
      ]),
    ]);
    expect(r.cohort).toHaveLength(1);
    expect(r.cohort[0].priorWindowMedianPrice).toBe(100);
    expect(r.cohort[0].ratio).toBe(1.1);
  });
});

describe("computeMatchedCohortMomentum — supply-thickness metrics", () => {
  it("latestWeekActiveCards counts all cards that sold latest (including new-to-market)", () => {
    const r = computeMatchedCohortMomentum([
      // In cohort
      seriesFor("card-A", [["2026-06-15", 50, 5], ["2026-06-22", 60, 6]]),
      // New: only sold latest week
      seriesFor("card-B", [["2026-06-22", 20, 2]]),
      // Not in latest week (didn't sell this week)
      seriesFor("card-C", [["2026-06-15", 100, 3]]),
    ]);
    expect(r.latestWeekActiveCards).toBe(2); // A + B
    expect(r.cohort).toHaveLength(1); // Only A has both windows
    expect(r.droppedNewOrLongTail).toBe(1); // B
    expect(r.totalCardsEvaluated).toBe(3);
  });
});
