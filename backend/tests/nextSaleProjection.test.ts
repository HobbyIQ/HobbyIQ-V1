// CF-NO-MEDIAN-FMV — unit tests for projectNextSaleFromComps.
//
// Contract locked in the tests below:
//   1. Empty / no-priced pool → null (honest null, no median)
//   2. n≥2 with distinct dates → linear-regression branch
//   3. Hartman Aqua fixture ($93 → $260.44) projects HIGHER than the
//      arithmetic midpoint ($176.72) — the whole point of this refactor
//   4. Downward trend fixture projects LOWER than the midpoint
//   5. n=1 → trend-adjusted-last-sale (or unchanged when trendPct=0)
//   6. All-same-date, n≥2 → trend-adjusted-last-sale (regression can't fit)
//   7. broaderTrendPctPerMonth rolls the anchor forward
//   8. Never emits a value that came from `sorted[len/2]` semantics

import { describe, it, expect } from "vitest";
import { projectNextSaleFromComps } from "../src/services/compiq/nextSaleProjection.service.js";

describe("projectNextSaleFromComps", () => {
  const NOW = 1_800_000_000_000;
  const daysAgo = (n: number) =>
    new Date(NOW - n * 86_400_000).toISOString();

  it("returns null on empty pool", () => {
    expect(projectNextSaleFromComps([])).toBeNull();
  });

  it("returns null when every comp has non-positive price", () => {
    expect(
      projectNextSaleFromComps([
        { price: 0, soldDate: daysAgo(1) },
        { price: -5, soldDate: daysAgo(2) },
      ]),
    ).toBeNull();
  });

  it("Hartman Aqua fixture: rising pool projects HIGHER than the midpoint (the whole point)", () => {
    const projection = projectNextSaleFromComps(
      [
        { price: 93, soldDate: daysAgo(30) },
        { price: 260.44, soldDate: daysAgo(5) },
      ],
      { nowMs: NOW },
    );
    expect(projection).not.toBeNull();
    expect(projection!.method).toBe("linear-regression");
    // Midpoint of $93 + $260.44 = $176.72 — the RETIRED behavior. Trend
    // projection rolls forward from the newer sale, so must exceed that.
    expect(projection!.nextSaleValue).toBeGreaterThan(176.72);
    expect(projection!.slopePerMonthPct).toBeGreaterThan(0);
  });

  it("downward-trending pool projects LOWER than the midpoint", () => {
    const projection = projectNextSaleFromComps(
      [
        { price: 500, soldDate: daysAgo(60) },
        { price: 300, soldDate: daysAgo(5) },
      ],
      { nowMs: NOW },
    );
    expect(projection).not.toBeNull();
    expect(projection!.method).toBe("linear-regression");
    expect(projection!.nextSaleValue).toBeLessThan(400);
    expect(projection!.slopePerMonthPct).toBeLessThan(0);
  });

  it("n=1 with soldDate → trend-adjusted-last-sale, anchor unchanged when broaderTrendPct=0", () => {
    const projection = projectNextSaleFromComps(
      [{ price: 150, soldDate: daysAgo(15) }],
      { nowMs: NOW, broaderTrendPctPerMonth: 0 },
    );
    expect(projection).not.toBeNull();
    expect(projection!.method).toBe("trend-adjusted-last-sale");
    expect(projection!.n).toBe(1);
    expect(projection!.nextSaleValue).toBeCloseTo(150, 2);
  });

  it("n=1 rolls the anchor forward using broaderTrendPct", () => {
    const projection = projectNextSaleFromComps(
      [{ price: 100, soldDate: daysAgo(0) }],
      { nowMs: NOW, broaderTrendPctPerMonth: 10, monthsForward: 1 },
    );
    expect(projection).not.toBeNull();
    // 100 × (1 + 10% × 1 month forward) = 110
    expect(projection!.nextSaleValue).toBeCloseTo(110, 1);
  });

  it("all-same-date n>=2 → trend-adjusted-last-sale (regression cannot fit)", () => {
    const projection = projectNextSaleFromComps(
      [
        { price: 200, soldDate: daysAgo(10) },
        { price: 210, soldDate: daysAgo(10) },
        { price: 220, soldDate: daysAgo(10) },
      ],
      { nowMs: NOW },
    );
    expect(projection).not.toBeNull();
    expect(projection!.method).toBe("trend-adjusted-last-sale");
    // Anchors on the newest — with all same date, that's the last one in the
    // sorted-newest-first ordering; NOT the median (which would be $210).
    // With broaderTrendPct=0, the anchor projects forward unchanged.
    // Should never equal 210 (the midpoint of 200/210/220).
    expect(projection!.nextSaleValue).not.toBe(210);
  });

  it("no-dates fallback: uses last priced entry, never a median", () => {
    const projection = projectNextSaleFromComps(
      [{ price: 100 }, { price: 200 }, { price: 300 }],
      { nowMs: NOW },
    );
    expect(projection).not.toBeNull();
    expect(projection!.method).toBe("trend-adjusted-last-sale");
    // Anchor is the last entry (300), not median (200) or mean (200).
    expect(projection!.nextSaleValue).toBe(300);
    // Anti-median assertion: never emit 200 as the projection for this
    // fixture because 200 is the arithmetic midpoint.
    expect(projection!.nextSaleValue).not.toBe(200);
  });

  it("bounds widen for single-sample thin path", () => {
    const single = projectNextSaleFromComps(
      [{ price: 100, soldDate: daysAgo(0) }],
      { nowMs: NOW },
    )!;
    const many = projectNextSaleFromComps(
      [
        { price: 90, soldDate: daysAgo(30) },
        { price: 100, soldDate: daysAgo(20) },
        { price: 110, soldDate: daysAgo(10) },
        { price: 120, soldDate: daysAgo(0) },
      ],
      { nowMs: NOW },
    )!;
    const singleSpread = (single.bounds.high - single.bounds.low) / single.nextSaleValue;
    const manySpread = (many.bounds.high - many.bounds.low) / many.nextSaleValue;
    expect(singleSpread).toBeGreaterThan(manySpread);
  });

  it("confidence rises with sample count", () => {
    const twoComps = projectNextSaleFromComps(
      [
        { price: 100, soldDate: daysAgo(20) },
        { price: 120, soldDate: daysAgo(1) },
      ],
      { nowMs: NOW },
    )!;
    const manyComps = projectNextSaleFromComps(
      Array.from({ length: 12 }, (_, i) => ({
        price: 100 + i * 5,
        soldDate: daysAgo(60 - i * 5),
      })),
      { nowMs: NOW },
    )!;
    expect(manyComps.confidence).toBeGreaterThan(twoComps.confidence);
  });

  it("nextSaleValue is always positive when a projection returns", () => {
    const projection = projectNextSaleFromComps(
      [
        { price: 300, soldDate: daysAgo(90) },
        { price: 10, soldDate: daysAgo(1) },
      ],
      { nowMs: NOW },
    );
    expect(projection).not.toBeNull();
    expect(projection!.nextSaleValue).toBeGreaterThan(0);
  });
});
