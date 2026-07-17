// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Pinning tests for the trend
// math. Fixture-driven so a change to slope/momentum/velocity gets
// caught before it ships.

import { describe, it, expect } from "vitest";
import {
  computeTrend,
  linearRegression,
  _MOMENTUM_SLOPE_UP,
  _MOMENTUM_SLOPE_DOWN,
} from "../src/services/portfolioiq/localCompTrend.service.js";
import type { LocalCompSale } from "../src/types/localComp.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function makeSale(daysAgo: number, price: number, overrides: Partial<LocalCompSale> = {}): LocalCompSale {
  return {
    priceHistoryId: `phid-${daysAgo}-${price}`,
    cardId: "card-1",
    saleDate: new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString(),
    price,
    grade: "PSA 10",
    grader: "PSA",
    variant: "Base",
    saleType: "BIN",
    imageUrl: "",
    listingUrl: "",
    description: "",
    ...overrides,
  };
}

describe("linearRegression", () => {
  it("fits a flat line through equal ys", () => {
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [5, 5, 5, 5]);
    expect(slope).toBeCloseTo(0);
    expect(intercept).toBeCloseTo(5);
  });

  it("fits a rising line through y=x", () => {
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [0, 1, 2, 3]);
    expect(slope).toBeCloseTo(1);
    expect(intercept).toBeCloseTo(0);
  });

  it("fits a falling line", () => {
    const { slope, intercept } = linearRegression([0, 1, 2, 3], [10, 8, 6, 4]);
    expect(slope).toBeCloseTo(-2);
    expect(intercept).toBeCloseTo(10);
  });

  it("returns zero slope on empty input", () => {
    expect(linearRegression([], [])).toEqual({ slope: 0, intercept: 0 });
  });

  it("handles all-same x (degenerate) without NaN", () => {
    const { slope } = linearRegression([5, 5, 5], [1, 2, 3]);
    expect(slope).toBe(0);
  });
});

describe("computeTrend", () => {
  it("returns null when zero sales", () => {
    expect(computeTrend([], 90, NOW)).toBeNull();
  });

  it("emits flat momentum + single-price fields when only 1 sale", () => {
    const t = computeTrend([makeSale(2, 100)], 90, NOW)!;
    expect(t.momentum).toBe("flat");
    expect(t.slope).toBe(0);
    expect(t.velocityPerWeek).toBeCloseTo(7 / 90);
    expect(t.projectedNextSalePrice).toBe(100);
    expect(t.earliestPrice).toBe(100);
    expect(t.latestPrice).toBe(100);
  });

  it("classifies steadily rising sales as up", () => {
    // 10 sales from $100 → $200 over 60 days ~= +100% log growth
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 10; i++) {
      const daysAgo = 60 - i * 6;
      const price = 100 * Math.pow(2, i / 9);
      sales.push(makeSale(daysAgo, price));
    }
    const t = computeTrend(sales, 90, NOW)!;
    expect(t.momentum).toBe("up");
    expect(t.slope).toBeGreaterThan(_MOMENTUM_SLOPE_UP);
    expect(t.projectedNextSalePrice).toBeGreaterThan(190);
  });

  it("classifies steadily falling sales as down", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 10; i++) {
      const daysAgo = 60 - i * 6;
      const price = 200 * Math.pow(0.5, i / 9);
      sales.push(makeSale(daysAgo, price));
    }
    const t = computeTrend(sales, 90, NOW)!;
    expect(t.momentum).toBe("down");
    expect(t.slope).toBeLessThan(_MOMENTUM_SLOPE_DOWN);
    expect(t.projectedNextSalePrice).toBeLessThan(120);
  });

  it("classifies noisy-but-level sales as flat", () => {
    const sales: LocalCompSale[] = [];
    const rng = seededPrng(42);
    for (let i = 0; i < 15; i++) {
      const daysAgo = 60 - i * 4;
      const price = 100 * (0.9 + 0.2 * rng());
      sales.push(makeSale(daysAgo, price));
    }
    const t = computeTrend(sales, 90, NOW)!;
    expect(t.momentum).toBe("flat");
  });

  it("excludes sales outside window", () => {
    const insideWindow = makeSale(30, 100);
    const outsideWindow = makeSale(200, 999); // 200d ago, past 90d window
    const t = computeTrend([insideWindow, outsideWindow], 90, NOW)!;
    expect(t.projectedNextSalePrice).toBeCloseTo(100, 0);
    expect(t.earliestPrice).toBe(100);
    expect(t.latestPrice).toBe(100);
  });

  it("velocityPerWeek scales with sale count over window", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 30; i++) sales.push(makeSale(i * 3, 100));
    const t = computeTrend(sales, 90, NOW)!;
    // 30 sales in 90d → 30/90*7 = 2.33/week
    expect(t.velocityPerWeek).toBeCloseTo(30 * 7 / 90, 1);
  });

  it("volatility is 0 on a perfect line", () => {
    const sales: LocalCompSale[] = [];
    for (let i = 0; i < 10; i++) sales.push(makeSale(60 - i * 6, 100 + i * 10));
    const t = computeTrend(sales, 90, NOW)!;
    // log residuals should be effectively 0 — perfectly linear on price, near-linear on log
    expect(t.volatility).toBeLessThan(0.05);
  });

  it("volatility is elevated on noisy sales", () => {
    const sales: LocalCompSale[] = [];
    const rng = seededPrng(7);
    for (let i = 0; i < 15; i++) sales.push(makeSale(60 - i * 4, 100 * (0.5 + rng())));
    const t = computeTrend(sales, 90, NOW)!;
    expect(t.volatility).toBeGreaterThan(0.1);
  });

  it("rejects sale rows with invalid or non-positive prices", () => {
    const good = makeSale(30, 100);
    const badZero = makeSale(20, 0);
    const badNaN = makeSale(10, NaN as unknown as number);
    const t = computeTrend([good, badZero, badNaN], 90, NOW)!;
    // Only one valid sale remaining — flat + single-price
    expect(t.momentum).toBe("flat");
    expect(t.projectedNextSalePrice).toBe(100);
  });
});

/** Small deterministic PRNG so noisy-flat / noisy-volatile tests are stable. */
function seededPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
