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

  // CF-THIN-POOL-SLOPE-CAP (Drew, 2026-07-31). Regression on a thin
  // (n<5), short-time-window (<14d) pool clamped to ±25% around the
  // newest sale to prevent wild extrapolations. Discovered via Hartman
  // Orange Shimmer PSA 10: 3 raws in 5 days ($1185 → $1531) projecting
  // to $9,828 (× PSA 10 multiplier). The regression slope
  // (+188.96%/month) is real but the SIGNAL is over-fit noise.
  describe("thin-pool short-window slope cap", () => {
    it("Hartman Orange Shimmer regression: 3 raws in 5 days clamped to ±25% of newest sale", () => {
      const projection = projectNextSaleFromComps(
        [
          { price: 1185.02, soldDate: daysAgo(9) },
          { price: 1190.26, soldDate: daysAgo(8) },
          { price: 1531,   soldDate: daysAgo(4) },  // newest anchor
        ],
        { nowMs: NOW, minNForRegression: 3 },
      );
      expect(projection).not.toBeNull();
      expect(projection!.method).toBe("linear-regression");
      // Uncapped, the regression would extrapolate way past ±25% of $1531
      // (i.e. > $1913 = 1531 × 1.25). With the cap, nextSaleValue must
      // fall in [$1148, $1914].
      expect(projection!.nextSaleValue).toBeLessThanOrEqual(1531 * 1.25);
      expect(projection!.nextSaleValue).toBeGreaterThanOrEqual(1531 * 0.75);
      // Slope signal is preserved for downstream telemetry — the cap
      // only clamps the OUTPUT, not the reported slope.
      expect(projection!.slopePerMonthPct).toBeGreaterThan(50);
    });

    it("does NOT clamp when time window is >= 14 days (spread apart, real signal)", () => {
      const projection = projectNextSaleFromComps(
        [
          { price: 500,  soldDate: daysAgo(60) },
          { price: 1200, soldDate: daysAgo(35) },
          { price: 2000, soldDate: daysAgo(5) },  // newest anchor
        ],
        { nowMs: NOW, minNForRegression: 3 },
      );
      expect(projection).not.toBeNull();
      expect(projection!.method).toBe("linear-regression");
      // CF-CAP-ANCHOR-IS-THE-LAST-SALE (Drew, 2026-08-17: "Lets fix that so it
      // is accurate"). The always-on cap anchors on the NEWEST observed sale for
      // a pool whose trend is trustworthy, not on the median of the whole
      // window. Median-anchoring capped this rising card at 1500 — BELOW its own
      // last real sale of 2000, which is a median wearing a trend's name.
      //
      // A projected next sale must never sit below the price the market just
      // paid. Ceiling is now newest +/-25% = 2500.
      expect(projection!.nextSaleValue).toBeGreaterThanOrEqual(2000);
      expect(projection!.nextSaleValue).toBeCloseTo(2000 * 1.25, 2);
      // The slope signal survives the clamp — only the OUTPUT is bounded.
      expect(projection!.slopePerMonthPct).toBeGreaterThan(0);
    });

    it("does NOT clamp when pool has 5+ points even in short window", () => {
      const projection = projectNextSaleFromComps(
        [
          { price: 1185, soldDate: daysAgo(9) },
          { price: 1190, soldDate: daysAgo(8) },
          { price: 1300, soldDate: daysAgo(7) },
          { price: 1400, soldDate: daysAgo(6) },
          { price: 1531, soldDate: daysAgo(4) },
        ],
        { nowMs: NOW, minNForRegression: 3 },
      );
      expect(projection).not.toBeNull();
      // n=5 makes the trend trustworthy, so the cap anchors on the newest sale
      // (1531) rather than the median (1300). Was clamped to 1625; now 1913.75,
      // and never below the last real sale.
      expect(projection!.nextSaleValue).toBeGreaterThanOrEqual(1531);
      expect(projection!.nextSaleValue).toBeCloseTo(1531 * 1.25, 2);
    });

    // CF-CAP-ANCHOR-IS-THE-LAST-SALE guard tests. Moving the anchor off the
    // median must NOT reopen the case the cap was built for.
    it("still blocks an outlier-driven collapse (Griffey LD1 shape)", () => {
      // The live case: 17 sales over 60d, and ONE $125 outlier that is the
      // OLDEST sale, dragging the regression to about -60%/month. That is why
      // anchoring on the newest sale is safe here — the outlier is not the
      // newest sale, so it cannot move the anchor.
      const comps = [{ price: 125, soldDate: daysAgo(59) }];
      for (let i = 0; i < 16; i++) comps.push({ price: 300 + (i % 5) * 8, soldDate: daysAgo(55 - i * 3) });
      const projection = projectNextSaleFromComps(comps, { nowMs: NOW, minNForRegression: 3 });
      expect(projection).not.toBeNull();
      // Must stay near the observed clearing price, nowhere near the outlier.
      expect(projection!.nextSaleValue).toBeGreaterThan(250);
    });

    it("a genuinely falling card is still allowed to fall to its last sale", () => {
      // The floor must not become a ratchet: anchoring on the newest sale has to
      // permit real declines, not hold FMV up at a stale median.
      const projection = projectNextSaleFromComps(
        [
          { price: 2000, soldDate: daysAgo(60) },
          { price: 1200, soldDate: daysAgo(35) },
          { price: 500,  soldDate: daysAgo(5) },
        ],
        { nowMs: NOW, minNForRegression: 3 },
      );
      expect(projection).not.toBeNull();
      // Median x 0.75 would have floored this at 900, well above the $500 the
      // market actually last paid.
      expect(projection!.nextSaleValue).toBeLessThanOrEqual(500);
    });

    it("clamps a thin downward-trending pool as well (symmetric)", () => {
      const projection = projectNextSaleFromComps(
        [
          { price: 1700, soldDate: daysAgo(9) },
          { price: 1500, soldDate: daysAgo(4) },  // newest anchor
        ],
        { nowMs: NOW, minNForRegression: 2 },  // allow branch 1 at n=2
      );
      expect(projection).not.toBeNull();
      expect(projection!.method).toBe("linear-regression");
      // $200 drop in 5 days = -40/day = -1200/month = -80%/month. Forward
      // 30d off $1500 = $1500 × (1 - 0.80) = $300 uncapped. Clamp holds
      // it above the $1500 × 0.75 = $1125 floor.
      expect(projection!.nextSaleValue).toBeGreaterThanOrEqual(1500 * 0.75);
      expect(projection!.slopePerMonthPct).toBeLessThan(0);
    });
  });
});
