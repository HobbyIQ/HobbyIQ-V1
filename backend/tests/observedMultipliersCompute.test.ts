// CF-OBSERVED-MULTIPLIERS (Drew, 2026-07-17). Pinning tests.

import { describe, it, expect } from "vitest";
import {
  computeObservedMultipliers,
  slugFamily,
  median,
  _DEFAULTS,
} from "../src/services/portfolioiq/observedMultipliersCompute.service.js";
import type { FamilySale } from "../src/types/observedMultipliers.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function mk(cardSetType: string, price: number, grader: string, grade: string, daysAgo = 30): FamilySale {
  return {
    cardSetType,
    price,
    grader,
    grade,
    saleDate: new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString(),
  };
}

describe("slugFamily", () => {
  it("normalizes to lowercase underscore-separated", () => {
    expect(slugFamily("Bowman Chrome Baseball")).toBe("bowman_chrome_baseball");
    expect(slugFamily("Panini Prizm Baseball")).toBe("panini_prizm_baseball");
    expect(slugFamily("Topps Chrome")).toBe("topps_chrome");
    expect(slugFamily("")).toBe("");
    expect(slugFamily("  ")).toBe("");
  });
});

describe("median", () => {
  it("odd length middle", () => expect(median([1, 3, 5])).toBe(3));
  it("even length average", () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it("empty returns 0", () => expect(median([])).toBe(0));
});

describe("computeObservedMultipliers", () => {
  it("emits multiplier per (family, tier) when thresholds met", () => {
    const sales: FamilySale[] = [];
    // 25 Bowman Chrome raw sales @ $100 median
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw"));
    // 8 Bowman Chrome PSA 10 sales @ $500 median → 5x
    for (let i = 0; i < 8; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10"));

    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].familyKey).toBe("bowman_chrome_baseball");
    expect(r.rows[0].graderTier).toBe("PSA 10");
    expect(r.rows[0].multiplier).toBeCloseTo(5, 3);
    expect(r.rows[0].nRaw).toBe(25);
    expect(r.rows[0].nGraded).toBe(8);
    expect(r.rows[0].medianRawPrice).toBe(100);
    expect(r.rows[0].medianGradedPrice).toBe(500);
    expect(r.familiesConsidered).toBe(1);
    expect(r.familiesPublished).toBe(1);
  });

  it("skips family when raw n below minRawSamples", () => {
    const sales: FamilySale[] = [];
    for (let i = 0; i < 10; i++) sales.push(mk("Small Set Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 8; i++) sales.push(mk("Small Set Baseball", 500, "PSA", "PSA 10"));
    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows).toHaveLength(0);
    expect(r.familiesPublished).toBe(0);
  });

  it("skips tier when graded n below minGradedSamples", () => {
    const sales: FamilySale[] = [];
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 3; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10")); // < 5
    for (let i = 0; i < 6; i++) sales.push(mk("Bowman Chrome Baseball", 250, "PSA", "PSA 9"));  // ≥ 5
    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].graderTier).toBe("PSA 9");
  });

  it("excludes sales outside the window", () => {
    const sales: FamilySale[] = [];
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw", 200)); // outside 90d
    for (let i = 0; i < 8; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10", 200)); // outside
    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows).toHaveLength(0);
  });

  it("filters non-positive prices + invalid dates", () => {
    const sales: FamilySale[] = [];
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 8; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10"));
    // Bad rows
    sales.push({ cardSetType: "Bowman Chrome Baseball", price: 0, grader: "Raw", grade: "Raw", saleDate: NOW.toISOString() });
    sales.push({ cardSetType: "Bowman Chrome Baseball", price: 10, grader: "Raw", grade: "Raw", saleDate: "invalid" });
    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows[0].nRaw).toBe(25);
  });

  it("confidence classification: high vs medium vs low", () => {
    const sales: FamilySale[] = [];
    // High: nRaw >= 100, nGraded >= 30
    for (let i = 0; i < 120; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 35; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10"));
    // Medium (different family): nRaw >= 50, nGraded >= 10
    for (let i = 0; i < 60; i++) sales.push(mk("Topps Chrome Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 15; i++) sales.push(mk("Topps Chrome Baseball", 500, "PSA", "PSA 10"));
    // Low (different family): meets minimums only
    for (let i = 0; i < 25; i++) sales.push(mk("Small Set Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 6; i++) sales.push(mk("Small Set Baseball", 500, "PSA", "PSA 10"));
    const r = computeObservedMultipliers(sales, {}, NOW);
    const conf = Object.fromEntries(r.rows.map((row) => [row.familyKey, row.confidence]));
    expect(conf["bowman_chrome_baseball"]).toBe("high");
    expect(conf["topps_chrome_baseball"]).toBe("medium");
    expect(conf["small_set_baseball"]).toBe("low");
  });

  it("multi-tier + multi-family: correct rows, sorted by multiplier DESC", () => {
    const sales: FamilySale[] = [];
    // Bowman: PSA 10 = 5x, PSA 9 = 2x
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", 100, "Raw", "Raw"));
    for (let i = 0; i < 8; i++) sales.push(mk("Bowman Chrome Baseball", 500, "PSA", "PSA 10"));
    for (let i = 0; i < 6; i++) sales.push(mk("Bowman Chrome Baseball", 200, "PSA", "PSA 9"));
    // Topps: PSA 10 = 3x
    for (let i = 0; i < 25; i++) sales.push(mk("Topps Chrome Baseball", 50, "Raw", "Raw"));
    for (let i = 0; i < 8; i++) sales.push(mk("Topps Chrome Baseball", 150, "PSA", "PSA 10"));
    const r = computeObservedMultipliers(sales, {}, NOW);
    expect(r.rows).toHaveLength(3);
    // Sorted by multiplier DESC: 5x, 3x, 2x
    expect(r.rows.map((row) => row.multiplier)).toEqual([5, 3, 2]);
  });

  it("pins default thresholds", () => {
    expect(_DEFAULTS.windowDays).toBe(90);
    expect(_DEFAULTS.minRawSamples).toBe(20);
    expect(_DEFAULTS.minGradedSamples).toBe(5);
    expect(_DEFAULTS.targetTiers).toContain("PSA 10");
    expect(_DEFAULTS.targetTiers).toContain("BGS 9.5");
  });
});
