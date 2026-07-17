// CF-GUESTIMATE-PRICING (Drew, 2026-07-17). Pinning tests for the
// no-comp compound-multiplier pricing engine.

import { describe, it, expect } from "vitest";
import { computeGuestimate } from "../src/services/compiq/guestimatePricing.js";

describe("computeGuestimate", () => {
  const familyLabel = "2026 Bowman Chrome Baseball";

  it("Hartman-like: unknown prospect, Orange Shimmer /25 auto, Raw", () => {
    // Family Raw base median $15 → prospect (1.4×) → Orange Shimmer
    // (parallel key "shimmer" = 8.5×) → auto (prospect = 3.5×) → /25
    // (3.2×). 15 × 1.4 × 8.5 × 3.5 × 3.2 ≈ $1999.
    const g = computeGuestimate({
      familyBaseRawPrice: 15,
      familyLabel,
      playerTier: "prospect",
      parallel: "Orange Shimmer Refractor",
      gradeTier: "Raw",
      printRun: 25,
      isAuto: true,
      ageYears: 0.5,
    });
    expect(g).not.toBeNull();
    // 15 × 1.4 × 8.5 × 3.5 × 3.2 = 1999.20 (Raw grade is 1.0, no era decay <0.5 → 1.2× applied)
    expect(g!.price).toBeGreaterThan(2000);
    expect(g!.price).toBeLessThan(2600);
    expect(g!.confidence).toBe("ballpark");
    expect(g!.attribution.length).toBeGreaterThanOrEqual(5);
    expect(g!.attribution[0]).toContain("Bowman Chrome Baseball");
  });

  it("common player, Base Refractor Raw → close to family baseline", () => {
    const g = computeGuestimate({
      familyBaseRawPrice: 15,
      familyLabel,
      playerTier: "common",
      parallel: "Refractor",
      gradeTier: "Raw",
      printRun: null,
      isAuto: false,
      ageYears: 1.0,
    });
    expect(g).not.toBeNull();
    // 15 × 0.6 (common) × 1.0 (Refractor collapses to base) = $9
    expect(g!.price).toBeCloseTo(9, 1);
    expect(g!.confidence).toBe("estimate");
  });

  it("superstar Base Auto PSA 10 no parallel", () => {
    const g = computeGuestimate({
      familyBaseRawPrice: 20,
      familyLabel,
      playerTier: "superstar",
      parallel: null,
      gradeTier: "PSA 10",
      printRun: null,
      isAuto: true,
      ageYears: 0.5,
    });
    expect(g).not.toBeNull();
    // 20 × 8.0 × 8.0 (auto superstar) × 3.57 (PSA 10 vs Raw) × 1.2 (hot) ≈ 5486
    expect(g!.price).toBeGreaterThan(4500);
    expect(g!.price).toBeLessThan(6500);
  });

  it("returns null when family baseline is zero or negative", () => {
    expect(computeGuestimate({
      familyBaseRawPrice: 0,
      familyLabel, playerTier: "common", parallel: null,
      gradeTier: "Raw", printRun: null, isAuto: false, ageYears: 1,
    })).toBeNull();
    expect(computeGuestimate({
      familyBaseRawPrice: -5,
      familyLabel, playerTier: "common", parallel: null,
      gradeTier: "Raw", printRun: null, isAuto: false, ageYears: 1,
    })).toBeNull();
  });

  it("hop count drives confidence and band width", () => {
    // Minimum hops: just the family baseline with common tier that
    // rounds to same-ish → 1-2 hops
    const gLow = computeGuestimate({
      familyBaseRawPrice: 100,
      familyLabel,
      playerTier: "common",     // 0.6× hop
      parallel: null,
      gradeTier: "Raw",
      printRun: null,
      isAuto: false,
      ageYears: 1.0,            // no decay
    });
    expect(gLow!.hops).toBeLessThanOrEqual(2);
    expect(gLow!.confidence).toBe("estimate");
    expect(gLow!.rangeHigh - gLow!.price).toBeCloseTo(gLow!.price * 0.20, 1);

    // Max hops: prospect + auto + parallel + printRun + grade + era decay
    const gHigh = computeGuestimate({
      familyBaseRawPrice: 100,
      familyLabel,
      playerTier: "prospect",
      parallel: "Orange Shimmer Refractor",
      gradeTier: "PSA 10",
      printRun: 25,
      isAuto: true,
      ageYears: 5,
    });
    expect(gHigh!.hops).toBeGreaterThan(gLow!.hops);
    expect(gHigh!.confidence).toBe("ballpark");
  });

  it("attribution chain includes every applied multiplier", () => {
    const g = computeGuestimate({
      familyBaseRawPrice: 15,
      familyLabel,
      playerTier: "prospect",
      parallel: "Orange Shimmer",
      gradeTier: "PSA 10",
      printRun: 25,
      isAuto: true,
      ageYears: 0.5,
    });
    const chainText = g!.attribution.join(" ");
    expect(chainText).toContain("Bowman Chrome Baseball");
    expect(chainText).toContain("player tier");
    expect(chainText).toContain("parallel");
    expect(chainText).toContain("autograph");
    expect(chainText).toContain("print run");
    expect(chainText).toContain("grade");
    expect(chainText).toContain("era");
  });

  it("Refractor alone treated as base (1.0×)", () => {
    // Vanilla "Refractor" isn't a colored parallel — it's the baseline.
    // Sellers who list without a color modifier are pricing at base.
    const g = computeGuestimate({
      familyBaseRawPrice: 20,
      familyLabel,
      playerTier: "prospect",
      parallel: "Refractor",
      gradeTier: "Raw",
      printRun: null,
      isAuto: false,
      ageYears: 1,
    });
    // 20 × 1.4 × 1.0 = $28
    expect(g!.price).toBeCloseTo(28, 1);
  });

  it("Print run <5 (super rare) applies 6× multiplier", () => {
    const g = computeGuestimate({
      familyBaseRawPrice: 20,
      familyLabel,
      playerTier: "prospect",
      parallel: null,
      gradeTier: "Raw",
      printRun: 3,
      isAuto: false,
      ageYears: 1,
    });
    // 20 × 1.4 × 6.0 = $168
    expect(g!.price).toBeCloseTo(168, 0);
  });

  it("Old era (5+ years) applies decay to reduce guestimate", () => {
    const gFresh = computeGuestimate({
      familyBaseRawPrice: 100, familyLabel,
      playerTier: "prospect", parallel: null, gradeTier: "Raw",
      printRun: null, isAuto: false, ageYears: 0.5,
    });
    const gAged = computeGuestimate({
      familyBaseRawPrice: 100, familyLabel,
      playerTier: "prospect", parallel: null, gradeTier: "Raw",
      printRun: null, isAuto: false, ageYears: 6,
    });
    expect(gAged!.price).toBeLessThan(gFresh!.price);
    // fresh: 100 × 1.4 × 1.2 = 168; aged: 100 × 1.4 × 0.7 = 98
    expect(gFresh!.price).toBeCloseTo(168, 0);
    expect(gAged!.price).toBeCloseTo(98, 0);
  });

  it("range is symmetric around the guestimate", () => {
    const g = computeGuestimate({
      familyBaseRawPrice: 100, familyLabel,
      playerTier: "prospect", parallel: null, gradeTier: "Raw",
      printRun: null, isAuto: false, ageYears: 1,
    });
    const centerFromRange = (g!.rangeLow + g!.rangeHigh) / 2;
    expect(centerFromRange).toBeCloseTo(g!.price, 1);
  });
});
