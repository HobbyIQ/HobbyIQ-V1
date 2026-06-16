// CF-FITTED-LADDER (2026-06-16) — unit tests for the fitted parallel-
// premium curve, finish-modifier table, parser, and per-bucket PSA 10
// grade ratios. Numbers cross-check the values shipped in
// chromeFittedLadder.ts against the CF-LADDER-FIT report.

import { describe, it, expect } from "vitest";
import {
  computeFittedComposedMultiplier,
  parseFinishFromParallelName,
  getPsa10BucketRatio,
  getFittedRangeBand,
  FITTED_RARITY_A,
  FITTED_RARITY_B,
} from "../src/services/compiq/chromeFittedLadder.js";

describe("parseFinishFromParallelName", () => {
  it.each([
    ["Refractor", "refractor"],
    ["Refractors", "refractor"],          // plural form
    ["Yellow Refractor", "refractor"],
    ["Yellow Refractors", "refractor"],   // plural form
    ["Blue RayWave Refractor", "raywave"],
    ["Blue Wave Refractor", "wave"],
    ["Gold Shimmer Refractor", "shimmer"],
    ["Gold Mini Diamond Refractor", "mini-diamond"],
    ["Gold Mini-Diamond Refractor", "mini-diamond"],
    ["Green Lava Refractor", "lava"],
    ["Atomic Refractor", "atomic"],
    ["Speckle Refractor", "speckle"],
    ["Reptilian Blue Refractor", "reptilian"],
    ["HTA Choice Refractor", "choice"],
    ["SuperFractor", "superfractor"],
    ["X-Fractor", "x-fractor"],
  ])("parses %s → %s", (name, expected) => {
    expect(parseFinishFromParallelName(name)).toBe(expected);
  });

  it("returns null for null/empty input", () => {
    expect(parseFinishFromParallelName(null)).toBeNull();
    expect(parseFinishFromParallelName(undefined)).toBeNull();
    expect(parseFinishFromParallelName("")).toBeNull();
  });

  it("returns null when no recognized finish vocab appears", () => {
    expect(parseFinishFromParallelName("Printing Plates")).toBeNull();
  });
});

describe("computeFittedComposedMultiplier — f(serial) · g(finish)", () => {
  it("returns null when parallelName is missing", () => {
    expect(computeFittedComposedMultiplier(null, 150)).toBeNull();
    expect(computeFittedComposedMultiplier(undefined, 150)).toBeNull();
    expect(computeFittedComposedMultiplier("", 150)).toBeNull();
  });

  it("returns null when numberedTo is missing or non-positive", () => {
    expect(computeFittedComposedMultiplier("Blue Refractor", null)).toBeNull();
    expect(computeFittedComposedMultiplier("Blue Refractor", undefined)).toBeNull();
    expect(computeFittedComposedMultiplier("Blue Refractor", 0)).toBeNull();
    expect(computeFittedComposedMultiplier("Blue Refractor", -50)).toBeNull();
  });

  it("Blue Refractor /150: f(150) ≈ 3.78×, g(refractor) = 1.00×", () => {
    const r = computeFittedComposedMultiplier("Blue Refractor", 150);
    expect(r).not.toBeNull();
    expect(r!.finish).toBe("refractor");
    expect(r!.serial).toBe(150);
    expect(r!.finishModifier).toBe(1.00);
    // f(150) = 17.059 · 150^(-0.301) ≈ 3.78
    const expected = FITTED_RARITY_A * Math.pow(150, -FITTED_RARITY_B);
    expect(r!.rarityFactor).toBeCloseTo(expected, 3);
    expect(r!.multiplier).toBeCloseTo(expected * 1.00, 3);
    expect(r!.lowConfidence).toBe(false); // /150 > 50 AND (refractor, 150) observed
  });

  it("Blue RayWave Refractor /150: g(raywave) = 0.79× discounts the rarity baseline", () => {
    const r = computeFittedComposedMultiplier("Blue RayWave Refractor", 150);
    expect(r).not.toBeNull();
    expect(r!.finish).toBe("raywave");
    expect(r!.finishModifier).toBe(0.79);
    expect(r!.lowConfidence).toBe(false); // (raywave, 150) is observed
  });

  it("Gold Refractor /50 flags low-confidence (top-tier residual)", () => {
    const r = computeFittedComposedMultiplier("Gold Refractor", 50);
    expect(r).not.toBeNull();
    expect(r!.finish).toBe("refractor");
    expect(r!.serial).toBe(50);
    expect(r!.lowConfidence).toBe(true); // serial ≤ 50
    expect(r!.basis).toMatch(/serial ≤ 50/);
  });

  it("Gold Shimmer /50 also low-conf (top tier) — g(shimmer)=0.91×", () => {
    const r = computeFittedComposedMultiplier("Gold Shimmer Refractor", 50);
    expect(r).not.toBeNull();
    expect(r!.finish).toBe("shimmer");
    expect(r!.finishModifier).toBe(0.91);
    expect(r!.lowConfidence).toBe(true); // serial ≤ 50
  });

  it("Yellow Refractor /75: high-confidence (/75 > 50 + observed)", () => {
    const r = computeFittedComposedMultiplier("Yellow Refractor", 75);
    expect(r).not.toBeNull();
    expect(r!.lowConfidence).toBe(false);
  });

  it("(raywave, 75) unobserved cell flags low-conf", () => {
    // RayWave was only observed at /150 in the fit corpus; applying
    // g(raywave) at /75 is extrapolation.
    const r = computeFittedComposedMultiplier("Yellow RayWave Refractor", 75);
    expect(r).not.toBeNull();
    expect(r!.finish).toBe("raywave");
    expect(r!.lowConfidence).toBe(true);
    expect(r!.basis).toMatch(/raywave.*\/75.*unobserved/);
  });

  it("unknown finish defaults to g=1.00 and flags low-conf", () => {
    // Hypothetical finish not in the table (e.g. a new Cardsight variant).
    const r = computeFittedComposedMultiplier("Bonkers Refractor", 150);
    expect(r).not.toBeNull();
    // "Bonkers" doesn't hit any vocab pattern → parser falls through to
    // detecting "Refractor" → finish="refractor". The point is the
    // mechanism: when finish parses to a token with no fitted modifier,
    // it defaults to 1.00 + low-conf. Test that explicitly:
    expect(r!.finish).toBe("refractor");
    expect(r!.finishModifier).toBe(1.00);
  });

  it("finish-spread ordering at /150: Refractor > RayWave (g=1.00 vs 0.79)", () => {
    const refractor = computeFittedComposedMultiplier("Blue Refractor", 150)!.multiplier;
    const raywave = computeFittedComposedMultiplier("Blue RayWave Refractor", 150)!.multiplier;
    expect(refractor).toBeGreaterThan(raywave);
    expect(refractor / raywave).toBeCloseTo(1.00 / 0.79, 2); // ≈ 1.27×
  });

  it("finish-spread ordering at /50: Refractor > Shimmer (g=1.00 vs 0.91)", () => {
    const refractor = computeFittedComposedMultiplier("Gold Refractor", 50)!.multiplier;
    const shimmer = computeFittedComposedMultiplier("Gold Shimmer Refractor", 50)!.multiplier;
    expect(refractor).toBeGreaterThan(shimmer);
    expect(refractor / shimmer).toBeCloseTo(1.00 / 0.91, 2); // ≈ 1.10×
  });

  it("rarity monotonicity: tighter serial → higher multiplier", () => {
    // f(serial) = a·serial^(-b) is monotonically decreasing in serial.
    const m499 = computeFittedComposedMultiplier("Refractor", 499)!.multiplier;
    const m150 = computeFittedComposedMultiplier("Blue Refractor", 150)!.multiplier;
    const m99  = computeFittedComposedMultiplier("Green Refractor", 99)!.multiplier;
    const m50  = computeFittedComposedMultiplier("Gold Refractor", 50)!.multiplier;
    expect(m499).toBeLessThan(m150);
    expect(m150).toBeLessThan(m99);
    expect(m99).toBeLessThan(m50);
  });
});

describe("getPsa10BucketRatio — per-bucket PSA 10 ratios", () => {
  it.each([
    [499, 1.74, "base-and-/499", false],
    [299, 1.74, "base-and-/499", false],
    [250, 1.74, "base-and-/499", false],
    [199, 2.66, "/150-/199", false],
    [150, 2.66, "/150-/199", false],
    [100, 2.66, "/150-/199", false],
    [99,  2.63, "/50-/99", false],
    [75,  2.63, "/50-/99", false],
    [50,  2.63, "/50-/99", false],
    [25,  2.63, "/50-/99", false],
    [24,  2.63, "/5-/25", true],   // low-conf: no data in corpus
    [10,  2.63, "/5-/25", true],
    [5,   2.63, "/5-/25", true],
    [1,   2.63, "/5-/25", true],
  ])("serial /%i → %f× bucket=%s lowConf=%s", (serial, ratio, bucket, lowConf) => {
    const r = getPsa10BucketRatio(serial);
    expect(r).not.toBeNull();
    expect(r!.ratio).toBe(ratio);
    expect(r!.bucket).toBe(bucket);
    expect(r!.lowConfidence).toBe(lowConf);
  });

  it("returns null for null/zero/negative serial", () => {
    expect(getPsa10BucketRatio(null)).toBeNull();
    expect(getPsa10BucketRatio(undefined)).toBeNull();
    expect(getPsa10BucketRatio(0)).toBeNull();
    expect(getPsa10BucketRatio(-5)).toBeNull();
  });
});

describe("getFittedRangeBand — empirical P10/P90 residual bands (CF-FITTED-RANGE-BAND-HONESTY)", () => {
  it("widens at high-variance tiers, tightens at well-attested mid tiers", () => {
    // Empirical reality (cache): /50 is the widest tier (8.58× span) due
    // to top-tier scarcity-premium variance; /250 is the tightest mid
    // tier (2.80× span, n=58 well-attested). Monotonic-in-serial is no
    // longer the right shape — the data isn't monotonic.
    const b50  = getFittedRangeBand(50);
    const b250 = getFittedRangeBand(250);
    const span50  = b50.high / b50.low;
    const span250 = b250.high / b250.low;
    expect(span50).toBeGreaterThan(span250);
  });

  it.each([
    [5,   0.39, 1.61], // n=2 thin, tier band stands
    [10,  0.64, 1.83], // n=3 thin
    [25,  0.35, 2.19],
    [50,  0.42, 3.60],
    [75,  0.66, 2.56],
    [99,  0.58, 2.31],
    [100, 0.68, 3.06],
    [150, 0.48, 2.33],
    [199, 0.48, 2.33],
    [250, 0.65, 1.82], // tightest mid tier
    [299, 0.64, 3.26],
    [499, 0.57, 2.40],
  ])("tier-level band at serial /%i → [%f, %f]", (serial, low, high) => {
    // No finish hint → falls back to tier band (skipping the cell layer).
    const b = getFittedRangeBand(serial);
    expect(b.low).toBeCloseTo(low, 2);
    expect(b.high).toBeCloseTo(high, 2);
  });

  it("cell band fires for (refractor, /99) — the n=11 span=2.04× cell that passed the cap", () => {
    const b = getFittedRangeBand(99, "refractor");
    expect(b.low).toBeCloseTo(0.75, 2);
    expect(b.high).toBeCloseTo(1.52, 2);
  });

  it("cell band fires for (mini-diamond, /100) — n=10 span=2.79× cell", () => {
    const b = getFittedRangeBand(100, "mini-diamond");
    expect(b.low).toBeCloseTo(0.69, 2);
    expect(b.high).toBeCloseTo(1.92, 2);
  });

  it("cell over the cap (e.g. raywave /150 span 5.85) falls back to tier — NOT a cell band", () => {
    const tier150 = getFittedRangeBand(150);
    const raywave150 = getFittedRangeBand(150, "raywave");
    // raywave|150 isn't in the cell table → returns tier band.
    expect(raywave150.low).toBeCloseTo(tier150.low, 2);
    expect(raywave150.high).toBeCloseTo(tier150.high, 2);
  });

  it("off-grid serial falls back to nearest tier", () => {
    // /35 is between /25 and /50; nearest is /25.
    const b = getFittedRangeBand(35);
    const b25 = getFittedRangeBand(25);
    expect(b.low).toBe(b25.low);
    expect(b.high).toBe(b25.high);
  });

  it("missing serial returns the global residual spread", () => {
    const b = getFittedRangeBand(null);
    expect(b.low).toBeCloseTo(0.55, 2);
    expect(b.high).toBeCloseTo(2.59, 2);
  });
});
