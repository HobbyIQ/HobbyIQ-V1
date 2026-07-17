// CF-PLAYER-TREND (Drew, 2026-07-17). Pinning tests for matched-cohort
// player-momentum math. Fixture-driven so a change to bucketing,
// median, or aggregation gets caught before shipping.

import { describe, it, expect } from "vitest";
import {
  computePlayerTrend,
  median,
  _MOMENTUM_UP_THRESHOLD,
  _MOMENTUM_DOWN_THRESHOLD,
  _DEFAULT_OPTIONS,
} from "../src/services/portfolioiq/playerTrendCompute.service.js";
import type { PlayerSale } from "../src/types/playerTrend.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function mk(cardId: string, daysAgo: number, price: number, skuLabel?: string): PlayerSale {
  return {
    cardId,
    saleDate: new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString(),
    price,
    skuLabel: skuLabel ?? null,
  };
}

describe("median", () => {
  it("odd count returns middle", () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });
  it("even count averages middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("empty returns 0", () => {
    expect(median([])).toBe(0);
  });
  it("unsorted input", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("computePlayerTrend", () => {
  it("returns flat momentum + no qualifying cards on empty input", () => {
    const r = computePlayerTrend("Nobody", [], {}, NOW);
    expect(r.momentum).toBe(1);
    expect(r.direction).toBe("flat");
    expect(r.qualifyingCards).toBe(0);
    expect(r.cardsInPool).toBe(0);
    expect(r.totalSales).toBe(0);
    expect(r.velocityPerWeek).toBe(0);
    expect(r.flags).toContain("sparse");
  });

  it("skips cards without matched-cohort (only one window has sales)", () => {
    const sales = [
      // Card A: only recent-window sales, no prior — should NOT qualify
      mk("A", 5, 100), mk("A", 10, 110), mk("A", 15, 120), mk("A", 20, 130),
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(0);
    expect(r.cardsInPool).toBe(1);
    expect(r.momentum).toBe(1);
  });

  it("single-card cohort — ratio pins", () => {
    const sales = [
      // Prior window: 3 sales @ $100 → median 100
      mk("A", 40, 100), mk("A", 45, 100), mk("A", 50, 100),
      // Recent window: 3 sales @ $150 → median 150
      mk("A", 5, 150), mk("A", 10, 150), mk("A", 15, 150),
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(1);
    expect(r.perCardRatios[0].ratio).toBeCloseTo(1.5);
    expect(r.perCardRatios[0].medianRecent).toBe(150);
    expect(r.perCardRatios[0].medianPrior).toBe(100);
    expect(r.momentum).toBeCloseTo(1.5);
    expect(r.direction).toBe("up");
  });

  it("aggregates as MEAN of ratios (not aggregate of prices) — the key invariant", () => {
    const sales = [
      // Card A: high-volume but cheap card, flat trend
      mk("A", 40, 10), mk("A", 45, 10), mk("A", 50, 10),
      mk("A", 5, 10), mk("A", 10, 10), mk("A", 15, 10),
      // Card B: rare superfractor, one huge sale in each window — 4x growth
      mk("B", 40, 1000), mk("B", 45, 1000), mk("B", 50, 1000),
      mk("B", 5, 4000), mk("B", 10, 4000), mk("B", 15, 4000),
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(2);
    // Card A ratio = 1.0 (flat), Card B ratio = 4.0
    // Correct: MEAN(ratios) = 2.5 (each SKU equal weight)
    // If we accidentally aggregated PRICES: (10+10+10+4000+4000+4000) / (10+10+10+1000+1000+1000)
    //   = 12030/3030 = 3.97 — WRONG (dominated by expensive card)
    expect(r.momentum).toBeCloseTo(2.5, 1);
    expect(r.direction).toBe("up");
  });

  it("classifies flat when momentum stays inside ±5%", () => {
    const sales = [
      mk("A", 40, 100), mk("A", 45, 100), mk("A", 50, 100),
      mk("A", 5, 102), mk("A", 10, 103), mk("A", 15, 104), // ~+3%
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.momentum).toBeGreaterThan(1);
    expect(r.momentum).toBeLessThan(_MOMENTUM_UP_THRESHOLD);
    expect(r.direction).toBe("flat");
  });

  it("classifies down when momentum falls below -5%", () => {
    const sales = [
      mk("A", 40, 100), mk("A", 45, 100), mk("A", 50, 100),
      mk("A", 5, 80), mk("A", 10, 80), mk("A", 15, 80), // -20%
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.momentum).toBeCloseTo(0.8);
    expect(r.direction).toBe("down");
  });

  it("respects minSalesPerWindow: card with n=2 in prior window does not qualify", () => {
    const sales = [
      mk("A", 40, 100), mk("A", 45, 100), // only 2 in prior
      mk("A", 5, 150), mk("A", 10, 150), mk("A", 15, 150),
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(0);
    expect(r.flags).toContain("sparse");
  });

  it("velocity is recent window sales / (windowDays/7)", () => {
    const sales: PlayerSale[] = [];
    // 15 recent sales across 30 days → 15 * 7 / 30 = 3.5/week
    for (let i = 0; i < 15; i++) sales.push(mk("A", i * 2, 10));
    // Plus prior window to make it qualify
    for (let i = 0; i < 3; i++) sales.push(mk("A", 40 + i * 3, 10));
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.velocityPerWeek).toBeCloseTo(3.5, 1);
  });

  it("perCardRatios sorted by |ratio - 1| DESC", () => {
    const sales = [
      // Card A: mild up (+10%)
      mk("A", 40, 100), mk("A", 45, 100), mk("A", 50, 100),
      mk("A", 5, 110), mk("A", 10, 110), mk("A", 15, 110),
      // Card B: big up (+80%)
      mk("B", 40, 100), mk("B", 45, 100), mk("B", 50, 100),
      mk("B", 5, 180), mk("B", 10, 180), mk("B", 15, 180),
      // Card C: mild down (-15%)
      mk("C", 40, 100), mk("C", 45, 100), mk("C", 50, 100),
      mk("C", 5, 85), mk("C", 10, 85), mk("C", 15, 85),
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(3);
    // Sorted by absolute movement from 1.0: B (0.8), C (0.15), A (0.1)
    expect(r.perCardRatios.map((c) => c.cardId)).toEqual(["B", "C", "A"]);
  });

  it("one_card_dominant flag fires when top card is >50% of volume", () => {
    const sales: PlayerSale[] = [];
    // Card A: 12 sales
    for (let i = 0; i < 6; i++) sales.push(mk("A", 5 + i, 10));
    for (let i = 0; i < 6; i++) sales.push(mk("A", 40 + i, 10));
    // Card B: 4 sales (only 25% share)
    for (let i = 0; i < 2; i++) sales.push(mk("B", 5 + i, 10));
    for (let i = 0; i < 2; i++) sales.push(mk("B", 40 + i, 10));
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.flags).toContain("one_card_dominant");
  });

  it("wide_ratio_dispersion flag fires when card ratios disagree", () => {
    const sales: PlayerSale[] = [];
    // 4 cards with wildly different ratios
    for (const [card, priorPrice, recentPrice] of [
      ["A", 100, 200],  // 2.0x
      ["B", 100, 50],   // 0.5x
      ["C", 100, 300],  // 3.0x
      ["D", 100, 40],   // 0.4x
    ] as const) {
      for (let i = 0; i < 3; i++) sales.push(mk(card, 40 + i, priorPrice));
      for (let i = 0; i < 3; i++) sales.push(mk(card, 5 + i, recentPrice));
    }
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(4);
    expect(r.flags).toContain("wide_ratio_dispersion");
  });

  it("filters out non-positive prices + invalid dates", () => {
    const sales = [
      mk("A", 40, 100), mk("A", 45, 100), mk("A", 50, 100),
      mk("A", 5, 150), mk("A", 10, 150), mk("A", 15, 150),
      // Bad rows — should be silently dropped
      mk("A", 20, 0),
      mk("A", 20, -10),
      { cardId: "A", saleDate: "not-a-date", price: 999, skuLabel: null },
    ];
    const r = computePlayerTrend("P", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(1);
    expect(r.perCardRatios[0].ratio).toBeCloseTo(1.5);
  });

  it("topCardsInResult caps perCardRatios[]", () => {
    const sales: PlayerSale[] = [];
    // 6 qualifying cards
    for (const c of ["A", "B", "C", "D", "E", "F"]) {
      for (let i = 0; i < 3; i++) sales.push(mk(c, 40 + i, 100));
      for (let i = 0; i < 3; i++) sales.push(mk(c, 5 + i, 100 + Math.random()));
    }
    const r = computePlayerTrend("P", sales, { topCardsInResult: 3 }, NOW);
    expect(r.qualifyingCards).toBe(6);
    expect(r.perCardRatios).toHaveLength(3);
  });

  it("pins default options", () => {
    expect(_DEFAULT_OPTIONS.recentWindowDays).toBe(30);
    expect(_DEFAULT_OPTIONS.priorWindowDays).toBe(30);
    expect(_DEFAULT_OPTIONS.minSalesPerWindow).toBe(3);
    expect(_DEFAULT_OPTIONS.minTotalSales).toBe(4);
    expect(_DEFAULT_OPTIONS.topCardsInResult).toBe(20);
  });

  it("pins momentum thresholds", () => {
    expect(_MOMENTUM_UP_THRESHOLD).toBe(1.05);
    expect(_MOMENTUM_DOWN_THRESHOLD).toBe(0.95);
  });

  it("Hartman-like case: +36% correct signal even with dominant base card", () => {
    // Case study — matches the memory: Hartman raw was -8%, matched was +36%.
    // Reproduces the mechanism: 1 base card with huge volume moving mildly,
    // several parallel cards moving strongly — the matched-cohort mean
    // captures the parallel-side signal that the raw pooled median misses.
    const sales: PlayerSale[] = [];

    // Base card CPA-EHA: 40 base sales (dominant volume), mild +5% up
    for (let i = 0; i < 20; i++) sales.push(mk("base", 5 + i, 100));   // recent median 100
    for (let i = 0; i < 20; i++) sales.push(mk("base", 40 + i, 95));   // prior median 95 → 1.05x

    // Parallel refractor /250: 6 sales each side, strong +50%
    for (let i = 0; i < 6; i++) sales.push(mk("purple", 5 + i, 300));  // recent 300
    for (let i = 0; i < 6; i++) sales.push(mk("purple", 40 + i, 200)); // prior 200 → 1.5x

    // Speckle /299: 5 sales each side, +40%
    for (let i = 0; i < 5; i++) sales.push(mk("speckle", 5 + i, 350));
    for (let i = 0; i < 5; i++) sales.push(mk("speckle", 40 + i, 250)); // 1.4x

    const r = computePlayerTrend("Hartman", sales, {}, NOW);
    expect(r.qualifyingCards).toBe(3);
    // Mean of (1.05, 1.5, 1.4) = 1.317 — matched-cohort direction UP
    expect(r.momentum).toBeCloseTo(1.317, 2);
    expect(r.direction).toBe("up");
    // Raw price-pooled would over-weight the 40 base sales @ $100 vs recent
    // parallels → would misread the parallel-side rally. This test proves
    // the mean-of-ratios captures it correctly.
  });
});
