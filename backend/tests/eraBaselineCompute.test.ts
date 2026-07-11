// CF-NO-NULL-PRICING PR 4 (2026-07-11, Drew — era-baseline compute tests).
// Locks the recency-weighting + trend-fit + trend-direction bucketing.

import { describe, it, expect } from "vitest";
import { computeEraBaselineForBucket } from "../src/services/compiq/eraBaselineCompute";

const NOW = "2026-07-11T00:00:00Z";
const nowMs = Date.parse(NOW);
const dayMs = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(nowMs - d * dayMs).toISOString();

describe("computeEraBaselineForBucket", () => {
  it("returns null when fewer than 3 valid comps", () => {
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 10, saleDate: daysAgo(1) },
        { price: 12, saleDate: daysAgo(2) },
      ],
      now: NOW,
    });
    expect(doc).toBeNull();
  });

  it("filters invalid prices (NaN, 0, negative) — not enough survive → null", () => {
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: NaN, saleDate: daysAgo(1) },
        { price: 0, saleDate: daysAgo(2) },
        { price: -5, saleDate: daysAgo(3) },
        { price: 10, saleDate: daysAgo(4) },
        { price: 12, saleDate: daysAgo(5) },
      ],
      now: NOW,
    });
    // Only 2 valid comps → null
    expect(doc).toBeNull();
  });

  it("computes recency-weighted currentValue (recent sales dominate)", () => {
    // Recent sales at $20, older sales at $10. Weighted by 14-day half-life
    // means recent should pull the currentValue higher than the flat mean.
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 20, saleDate: daysAgo(1) },
        { price: 20, saleDate: daysAgo(2) },
        { price: 20, saleDate: daysAgo(3) },
        { price: 10, saleDate: daysAgo(45) },
        { price: 10, saleDate: daysAgo(50) },
        { price: 10, saleDate: daysAgo(55) },
      ],
      now: NOW,
    });
    const flatMean = (20 * 3 + 10 * 3) / 6; // 15
    expect(doc).not.toBeNull();
    // Recent sales weighted heavier → currentValue should exceed flat mean
    expect(doc!.currentValue).toBeGreaterThan(flatMean);
    expect(doc!.sampleSize).toBe(6);
  });

  it("sets trendDirection=up when prices are rising", () => {
    // Clear up-trend: older sales at $10, then $12, then $15, then $18 recent.
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 18, saleDate: daysAgo(1) },
        { price: 18, saleDate: daysAgo(2) },
        { price: 15, saleDate: daysAgo(10) },
        { price: 15, saleDate: daysAgo(12) },
        { price: 12, saleDate: daysAgo(20) },
        { price: 12, saleDate: daysAgo(22) },
        { price: 10, saleDate: daysAgo(35) },
        { price: 10, saleDate: daysAgo(40) },
      ],
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.trendDirection).toBe("up");
    expect(doc!.trendPct).toBeGreaterThan(0);
    expect(doc!.predictedValue).toBeGreaterThan(doc!.currentValue);
  });

  it("sets trendDirection=down when prices are falling", () => {
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 10, saleDate: daysAgo(1) },
        { price: 10, saleDate: daysAgo(2) },
        { price: 12, saleDate: daysAgo(10) },
        { price: 12, saleDate: daysAgo(12) },
        { price: 15, saleDate: daysAgo(20) },
        { price: 15, saleDate: daysAgo(22) },
        { price: 18, saleDate: daysAgo(35) },
        { price: 18, saleDate: daysAgo(40) },
      ],
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.trendDirection).toBe("down");
    expect(doc!.trendPct).toBeLessThan(0);
  });

  it("sets trendDirection=flat when prices are stable (within ±3%)", () => {
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 20, saleDate: daysAgo(1) },
        { price: 19.5, saleDate: daysAgo(5) },
        { price: 20.5, saleDate: daysAgo(10) },
        { price: 20, saleDate: daysAgo(20) },
        { price: 20.5, saleDate: daysAgo(30) },
        { price: 19.5, saleDate: daysAgo(40) },
      ],
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.trendDirection).toBe("flat");
    expect(Math.abs(doc!.trendPct)).toBeLessThan(0.03);
  });

  it("clamps predictedValue at 50% of currentValue (guard against wild fits)", () => {
    // Wildly negative slope from a tiny sample — clamp should keep
    // predictedValue >= currentValue × 0.5
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 10, saleDate: daysAgo(1) },
        { price: 20, saleDate: daysAgo(10) },
        { price: 40, saleDate: daysAgo(20) },
      ],
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.predictedValue).toBeGreaterThanOrEqual(doc!.currentValue * 0.5);
  });

  it("populates all required fields including currentRange + schemaVersion", () => {
    const doc = computeEraBaselineForBucket({
      productKey: "bowman-chrome",
      year: 2020,
      cardClass: "base",
      comps: [
        { price: 20, saleDate: daysAgo(1) },
        { price: 21, saleDate: daysAgo(5) },
        { price: 19, saleDate: daysAgo(10) },
      ],
      now: NOW,
    });
    expect(doc!.id).toMatch(/^[0-9a-f]{40}$/);
    expect(doc!.productKey).toBe("bowman-chrome");
    expect(doc!.year).toBe(2020);
    expect(doc!.cardClass).toBe("base");
    expect(doc!.currentValue).toBeGreaterThan(0);
    expect(doc!.currentRange.low).toBe(Math.round(doc!.currentValue * 0.5 * 100) / 100);
    expect(doc!.currentRange.high).toBe(Math.round(doc!.currentValue * 2.0 * 100) / 100);
    expect(doc!.computedAt).toBe(NOW);
    expect(doc!.schemaVersion).toBe(2);
  });

  it("throws on invalid `now` timestamp", () => {
    expect(() =>
      computeEraBaselineForBucket({
        productKey: "bowman-chrome",
        year: 2020,
        cardClass: "base",
        comps: [{ price: 10, saleDate: "2026-07-01" }],
        now: "not-a-date",
      }),
    ).toThrow();
  });
});
