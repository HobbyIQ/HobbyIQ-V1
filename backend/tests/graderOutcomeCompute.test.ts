// CF-GRADER-OUTCOMES (Drew, 2026-07-17). Pinning tests.

import { describe, it, expect } from "vitest";
import {
  computeGraderOutcomes,
  slugFamily,
  probabilityWeightedExpectedPrice,
  _DEFAULTS,
} from "../src/services/portfolioiq/graderOutcomeCompute.service.js";
import type { OutcomeSale } from "../src/types/graderOutcome.types.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function mk(cardSetType: string, grader: string, grade: string, daysAgo = 30, price = 100): OutcomeSale {
  return {
    cardSetType,
    price,
    grader,
    grade,
    saleDate: new Date(NOW.getTime() - daysAgo * MS_PER_DAY).toISOString(),
  };
}

describe("computeGraderOutcomes — bucketing + shares", () => {
  it("emits one row per (family, grader) with tierShares summing to 1", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 15; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 9"));
    for (let i = 0; i < 10; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 8"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.familyKey).toBe("bowman_chrome_baseball");
    expect(row.grader).toBe("PSA");
    expect(row.totalGradedSamples).toBe(50);
    expect(row.tierCounts).toEqual({ "PSA 10": 15, "PSA 9": 25, "PSA 8": 10 });
    expect(row.tierShares["PSA 10"]).toBeCloseTo(0.3, 3);
    expect(row.tierShares["PSA 9"]).toBeCloseTo(0.5, 3);
    expect(row.tierShares["PSA 8"]).toBeCloseTo(0.2, 3);
    // Sum ~= 1
    const sum = Object.values(row.tierShares).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  it("excludes Raw sales", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 15; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 10; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 9"));
    for (let i = 0; i < 200; i++) sales.push(mk("Bowman Chrome Baseball", "Raw", "Raw"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    expect(r.rows[0].totalGradedSamples).toBe(25);
  });

  it("excludes sales outside window", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 10", 200));
    const r = computeGraderOutcomes(sales, { windowDays: 90 }, NOW);
    expect(r.rows).toHaveLength(0);
  });

  it("skips (family, grader) below minGradedSamples", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 5; i++) sales.push(mk("Small Set Baseball", "BGS", "BGS 9.5"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    expect(r.rows).toHaveLength(0);
  });

  it("separates multiple graders in the same family", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 25; i++) sales.push(mk("Bowman Chrome Baseball", "BGS", "BGS 9.5"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    expect(r.rows).toHaveLength(2);
    const graders = r.rows.map((row) => row.grader).sort();
    expect(graders).toEqual(["BGS", "PSA"]);
  });

  it("sorts rows by totalGradedSamples DESC", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 100; i++) sales.push(mk("Big Set Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 30; i++) sales.push(mk("Medium Set Baseball", "PSA", "PSA 10"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    expect(r.rows.map((row) => row.familyKey)).toEqual([
      "big_set_baseball", "medium_set_baseball",
    ]);
  });

  it("confidence: high @ ≥100, medium @ ≥30, low @ ≥minGradedSamples", () => {
    const sales: OutcomeSale[] = [];
    for (let i = 0; i < 120; i++) sales.push(mk("High Conf Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 40; i++) sales.push(mk("Med Conf Baseball", "PSA", "PSA 10"));
    for (let i = 0; i < 22; i++) sales.push(mk("Low Conf Baseball", "PSA", "PSA 10"));
    const r = computeGraderOutcomes(sales, {}, NOW);
    const conf = Object.fromEntries(r.rows.map((row) => [row.familyKey, row.confidence]));
    expect(conf["high_conf_baseball"]).toBe("high");
    expect(conf["med_conf_baseball"]).toBe("medium");
    expect(conf["low_conf_baseball"]).toBe("low");
  });
});

describe("probabilityWeightedExpectedPrice", () => {
  it("computes weighted average using shares × per-tier prices", () => {
    const row = {
      tierShares: {
        "PSA 10": 0.3,
        "PSA 9": 0.5,
        "PSA 8": 0.2,
      },
    };
    const prices = {
      "PSA 10": 1000,
      "PSA 9": 200,
      "PSA 8": 50,
    };
    // Weighted: 0.3*1000 + 0.5*200 + 0.2*50 = 300 + 100 + 10 = 410
    // Coverage = 1.0 → 410/1.0 = 410
    const { expected, coverageShare } = probabilityWeightedExpectedPrice(row, prices);
    expect(expected).toBeCloseTo(410, 0);
    expect(coverageShare).toBeCloseTo(1, 2);
  });

  it("renormalizes when only partial coverage of tiers", () => {
    const row = {
      tierShares: {
        "PSA 10": 0.3,
        "PSA 9": 0.5,
        "PSA 8": 0.2,
      },
    };
    // Only PSA 10 and PSA 9 prices given
    const prices = { "PSA 10": 1000, "PSA 9": 200 };
    // Numerator = 0.3*1000 + 0.5*200 = 400
    // Coverage share = 0.8
    // Renormalized = 400 / 0.8 = 500
    const { expected, coverageShare } = probabilityWeightedExpectedPrice(row, prices);
    expect(expected).toBeCloseTo(500, 0);
    expect(coverageShare).toBeCloseTo(0.8, 2);
  });

  it("returns 0 when no tier prices match", () => {
    const row = { tierShares: { "PSA 10": 1.0 } };
    const { expected, coverageShare } = probabilityWeightedExpectedPrice(row, {});
    expect(expected).toBe(0);
    expect(coverageShare).toBe(0);
  });
});

describe("slugFamily + defaults", () => {
  it("slugs correctly", () => {
    expect(slugFamily("Bowman Chrome Baseball")).toBe("bowman_chrome_baseball");
    expect(slugFamily("")).toBe("");
  });
  it("pins defaults", () => {
    expect(_DEFAULTS.windowDays).toBe(90);
    expect(_DEFAULTS.minGradedSamples).toBe(20);
  });
});
