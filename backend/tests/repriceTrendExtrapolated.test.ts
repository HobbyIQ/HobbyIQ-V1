/**
 * CF-TREND-EXTRAPOLATED (2026-06-10) — repriceTrendExtrapolated unit tests.
 *
 * Asserts the corrected damping direction:
 *   - gap=0 → ~zero adjustment (fresh anchor ≈ current market)
 *   - gap=WINDOW → full multiplier applied
 *   - gap>WINDOW → still capped at full multiplier (single window of drift,
 *                  anti-compounding intact)
 *   - gap>CUTOFF → null (fall to last-sale)
 *
 * Plus range-widens-with-gap and edge-case nulls.
 */
import { describe, it, expect } from "vitest";
import {
  repriceTrendExtrapolated,
  TREND_CUTOFF_DAYS,
  TREND_WINDOW_DAYS,
} from "../src/services/compiq/compiqEstimate.service";

describe("repriceTrendExtrapolated — corrected damping direction", () => {
  const ANCHOR = 100;

  it("gap=0 (fresh anchor): adjustment ≈ 0, estimatedValue ≈ anchor", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, 0, 1.20);
    expect(out).not.toBeNull();
    // gapFactor = min(0, 14)/14 = 0 → adjustment = 0 → estVal = anchor
    expect(out!.basis.gapFactor).toBe(0);
    expect(out!.basis.adjustment).toBe(0);
    expect(out!.estimatedValue).toBeCloseTo(ANCHOR, 2);
  });

  it("gap=7 (half window): half the multiplier applied", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, 7, 1.20);
    expect(out).not.toBeNull();
    // gapFactor = 7/14 = 0.5 → adjustment = 0.20 × 0.5 = 0.10 → estVal = 110
    expect(out!.basis.gapFactor).toBeCloseTo(0.5, 3);
    expect(out!.basis.adjustment).toBeCloseTo(0.10, 3);
    expect(out!.estimatedValue).toBeCloseTo(110, 2);
  });

  it("gap=WINDOW (14): FULL multiplier applied", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, TREND_WINDOW_DAYS, 1.20);
    expect(out).not.toBeNull();
    // gapFactor = 14/14 = 1.0 → adjustment = 0.20 → estVal = 120
    expect(out!.basis.gapFactor).toBe(1.0);
    expect(out!.basis.adjustment).toBeCloseTo(0.20, 3);
    expect(out!.estimatedValue).toBeCloseTo(120, 2);
  });

  it("gap=25 (past WINDOW, before CUTOFF): STILL capped at full multiplier (anti-compounding)", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, 25, 1.20);
    expect(out).not.toBeNull();
    // gapFactor = min(25, 14)/14 = 1.0 (CAPPED) → adjustment = 0.20 → estVal = 120
    expect(out!.basis.gapFactor).toBe(1.0);
    expect(out!.basis.adjustment).toBeCloseTo(0.20, 3);
    expect(out!.estimatedValue).toBeCloseTo(120, 2);
  });

  it("gap=CUTOFF (30): still produces value (range will be widest, but adj still capped)", () => {
    // CUTOFF is the LAST gap that still fires. At 30 the gapFactor cap
    // is still 1.0 (anti-compounding holds). At gap > CUTOFF, null.
    const out = repriceTrendExtrapolated({ price: ANCHOR }, TREND_CUTOFF_DAYS, 1.20);
    expect(out).not.toBeNull();
    expect(out!.basis.gapFactor).toBe(1.0);
    expect(out!.estimatedValue).toBeCloseTo(120, 2);
  });

  it("gap=CUTOFF+1 (31): null (cutoff falls through to last-sale)", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, TREND_CUTOFF_DAYS + 1, 1.20);
    expect(out).toBeNull();
  });

  it("gap=60 (well past CUTOFF): null", () => {
    const out = repriceTrendExtrapolated({ price: ANCHOR }, 60, 1.20);
    expect(out).toBeNull();
  });
});

describe("repriceTrendExtrapolated — direction is signed (down-trend)", () => {
  it("multiplier < 1.0 produces negative adjustment", () => {
    const out = repriceTrendExtrapolated({ price: 100 }, 7, 0.85);
    expect(out).not.toBeNull();
    // gapFactor = 0.5; adjustment = (0.85 - 1.0) × 0.5 = -0.075
    expect(out!.basis.adjustment).toBeCloseTo(-0.075, 3);
    expect(out!.estimatedValue).toBeCloseTo(92.5, 2);
  });

  it("multiplier == 1.0 (flat trend) → estimatedValue == anchor at any gap", () => {
    for (const gap of [0, 7, 14, 25, 30]) {
      const out = repriceTrendExtrapolated({ price: 200 }, gap, 1.0);
      expect(out).not.toBeNull();
      expect(out!.basis.adjustment).toBeCloseTo(0, 3);
      expect(out!.estimatedValue).toBeCloseTo(200, 2);
    }
  });
});

describe("repriceTrendExtrapolated — range widens with total gap", () => {
  it("spread at gap=0 < spread at gap=14 < spread at gap=25", () => {
    const r0 = repriceTrendExtrapolated({ price: 100 }, 0, 1.20)!;
    const r14 = repriceTrendExtrapolated({ price: 100 }, 14, 1.20)!;
    const r25 = repriceTrendExtrapolated({ price: 100 }, 25, 1.20)!;
    expect(r0.basis.spread).toBeLessThan(r14.basis.spread);
    expect(r14.basis.spread).toBeLessThan(r25.basis.spread);
  });

  it("spread floor at SPREAD_BASE=0.12 (flat trend, gap=0)", () => {
    const out = repriceTrendExtrapolated({ price: 100 }, 0, 1.0);
    expect(out!.basis.spread).toBeCloseTo(0.12, 3);
  });

  it("spread cap at SPREAD_MAX=0.30 (max trend, max gap)", () => {
    const out = repriceTrendExtrapolated({ price: 100 }, TREND_CUTOFF_DAYS, 1.20);
    // 0.12 + (30/30)×0.10 + 0.20×0.25 = 0.27 — under cap
    // Bump multiplier hypothetically past clamp to test SPREAD_MAX
    const outExtreme = repriceTrendExtrapolated({ price: 100 }, TREND_CUTOFF_DAYS, 2.0);
    expect(outExtreme!.basis.spread).toBe(0.30);
  });

  it("range bounds derive from estimatedValue × (1 ± spread)", () => {
    const out = repriceTrendExtrapolated({ price: 100 }, TREND_WINDOW_DAYS, 1.20)!;
    // estVal=120, spread=0.12 + (14/30)×0.10 + 0.20×0.25 = 0.21666...
    expect(out.estimateRange.low).toBeCloseTo(120 * (1 - out.basis.spread), 1);
    expect(out.estimateRange.high).toBeCloseTo(120 * (1 + out.basis.spread), 1);
  });
});

describe("repriceTrendExtrapolated — null returns", () => {
  it("non-finite multiplier → null", () => {
    expect(repriceTrendExtrapolated({ price: 100 }, 7, NaN)).toBeNull();
    expect(repriceTrendExtrapolated({ price: 100 }, 7, Infinity)).toBeNull();
  });

  it("non-positive anchor price → null", () => {
    expect(repriceTrendExtrapolated({ price: 0 }, 7, 1.20)).toBeNull();
    expect(repriceTrendExtrapolated({ price: -5 }, 7, 1.20)).toBeNull();
  });

  it("negative gap → null", () => {
    expect(repriceTrendExtrapolated({ price: 100 }, -1, 1.20)).toBeNull();
  });

  it("non-finite gap → null", () => {
    expect(repriceTrendExtrapolated({ price: 100 }, NaN, 1.20)).toBeNull();
  });
});

describe("repriceTrendExtrapolated — worked example table (HALT-approved curve)", () => {
  it("matches the approved table values within rounding", () => {
    const cases = [
      { gap: 0,  mult: 1.20, expEst: 100, expAdj: 0.000 },
      { gap: 7,  mult: 1.20, expEst: 110, expAdj: 0.100 },
      { gap: 14, mult: 1.20, expEst: 120, expAdj: 0.200 },
      { gap: 25, mult: 1.20, expEst: 120, expAdj: 0.200 }, // capped
      { gap: 5,  mult: 0.85, expEst: 94.64, expAdj: -0.054 },
      { gap: 15, mult: 1.05, expEst: 105, expAdj: 0.050 }, // capped at gap=14
    ];
    for (const c of cases) {
      const out = repriceTrendExtrapolated({ price: 100 }, c.gap, c.mult)!;
      expect(out.basis.adjustment).toBeCloseTo(c.expAdj, 3);
      expect(out.estimatedValue).toBeCloseTo(c.expEst, 2);
    }
  });
});
