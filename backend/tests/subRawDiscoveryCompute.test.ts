import { describe, it, expect } from "vitest";
import {
  computeSubRawDiscovery,
  _DEFAULTS,
  type SkuRawAggregate,
  type FamilyMultipliersByKey,
} from "../src/services/portfolioiq/subRawDiscoveryCompute.service.js";

const slugFamily = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function buildFamilyMap(entries: Array<[string, { multiplier: number; confidence: "high"|"medium"|"low"; nGraded: number }]>): FamilyMultipliersByKey {
  const m = new Map(entries);
  return { get: (k: string) => m.get(k) };
}

const bowmanChromeHigh = { multiplier: 8, confidence: "high" as const, nGraded: 50 };
const bowmanChromeMedium = { multiplier: 8, confidence: "medium" as const, nGraded: 12 };
const bowmanChromeLow = { multiplier: 8, confidence: "low" as const, nGraded: 5 };

function mkAgg(overrides: Partial<SkuRawAggregate>): SkuRawAggregate {
  return {
    cardId: "c1",
    player: "P",
    year: 2026,
    cardSet: "2026 Bowman Chrome Baseball",
    cardSetType: "Bowman Chrome Baseball",
    variant: "Base",
    number: "BCP-1",
    medianRawPrice: 20,
    rawComps: 5,
    imageUrl: null,
    ...overrides,
  };
}

describe("computeSubRawDiscovery — thresholds", () => {
  const family = buildFamilyMap([
    ["bowman_chrome_baseball", bowmanChromeHigh],
  ]);

  it("passes when raw price low, multiplier high, gain > $200 + multiple > 5", () => {
    // 20 × 8 = 160 expected PSA10 — wait, this fails: gain = 160-20-80 = 60. Too low.
    // Try 30 × 8 = 240, gain = 240-30-80 = 130. Still too low.
    // Need higher multiplier or lower cost.
    // 20 × 20 = 400, gain = 400-20-80 = 300 ✓, multiple = 300/20 = 15 ✓
    const family20x = buildFamilyMap([
      ["bowman_chrome_baseball", { multiplier: 20, confidence: "high", nGraded: 50 }],
    ]);
    const r = computeSubRawDiscovery(
      [mkAgg({ cardId: "c1", medianRawPrice: 20 })],
      family20x,
      slugFamily,
    );
    expect(r).toHaveLength(1);
    expect(r[0].expectedGain).toBeCloseTo(300, 1);
    expect(r[0].expectedGainMultiple).toBeCloseTo(15, 1);
  });

  it("skips when raw price above maxRawPrice cap", () => {
    const family20x = buildFamilyMap([
      ["bowman_chrome_baseball", { multiplier: 20, confidence: "high", nGraded: 50 }],
    ]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 50 })],
      family20x,
      slugFamily,
      { maxRawPrice: 30 },
    );
    expect(r).toHaveLength(0);
  });

  it("skips when expectedGain below minExpectedGain", () => {
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 20 })],
      family,   // 8x multiplier
      slugFamily,
    );
    // 20 * 8 - 20 - 80 = 60 gain. Below default $200 minimum → filtered.
    expect(r).toHaveLength(0);
  });

  it("skips when expectedGainMultiple below minExpectedGainMultiple", () => {
    // multiplier 5x on $50 → expectedPSA10 250, gain 250-50-80 = 120 (above $200 default? no)
    // Let's set gain min low: min gain $50, multiple default 5.0
    // 250-50-80 = 120 → multiple = 120/50 = 2.4 → below 5.0 → filtered
    const family5x = buildFamilyMap([
      ["bowman_chrome_baseball", { multiplier: 5, confidence: "high", nGraded: 50 }],
    ]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 50 })],
      family5x,
      slugFamily,
      { minExpectedGain: 100 },
    );
    expect(r).toHaveLength(0);
  });

  it("respects confidence gate — 'high' filter blocks medium-confidence family", () => {
    const family = buildFamilyMap([["bowman_chrome_baseball", { multiplier: 20, confidence: "medium", nGraded: 15 }]]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 20 })],
      family,
      slugFamily,
      { minFamilyConfidence: "high" },
    );
    expect(r).toHaveLength(0);
  });

  it("'medium' default filter allows both high and medium", () => {
    const familyMed = buildFamilyMap([["bowman_chrome_baseball", { multiplier: 20, confidence: "medium", nGraded: 15 }]]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 20 })],
      familyMed,
      slugFamily,
    );
    expect(r).toHaveLength(1);
  });

  it("'medium' default filter blocks low-confidence", () => {
    const familyLow = buildFamilyMap([["bowman_chrome_baseball", bowmanChromeLow]]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 20 })],
      familyLow,
      slugFamily,
    );
    expect(r).toHaveLength(0);
  });

  it("skips SKUs with no family multiplier row", () => {
    const emptyFamily = buildFamilyMap([]);
    const r = computeSubRawDiscovery(
      [mkAgg({ medianRawPrice: 20 })],
      emptyFamily,
      slugFamily,
    );
    expect(r).toHaveLength(0);
  });
});

describe("computeSubRawDiscovery — sort + cap", () => {
  it("sorts by expectedGain DESC, respects topN", () => {
    const family20x = buildFamilyMap([
      ["bowman_chrome_baseball", { multiplier: 20, confidence: "high", nGraded: 50 }],
    ]);
    const aggs = [
      mkAgg({ cardId: "a", medianRawPrice: 10 }),   // 10*20 - 10 - 80 = 110 gain (below $200)
      mkAgg({ cardId: "b", medianRawPrice: 20 }),   // 300 gain
      mkAgg({ cardId: "c", medianRawPrice: 25 }),   // 25*20 - 25 - 80 = 395 gain
      mkAgg({ cardId: "d", medianRawPrice: 30 }),   // 30*20 - 30 - 80 = 490 gain
    ];
    const r = computeSubRawDiscovery(aggs, family20x, slugFamily);
    // "a" filtered out (below $200 gain default)
    expect(r).toHaveLength(3);
    expect(r.map((c) => c.cardId)).toEqual(["d", "c", "b"]);
  });

  it("caps at topN", () => {
    const family20x = buildFamilyMap([
      ["bowman_chrome_baseball", { multiplier: 20, confidence: "high", nGraded: 50 }],
    ]);
    const aggs = [];
    for (let i = 0; i < 40; i++) aggs.push(mkAgg({ cardId: `c${i}`, medianRawPrice: 20 + i * 0.1 }));
    const r = computeSubRawDiscovery(aggs, family20x, slugFamily, { topN: 10 });
    expect(r).toHaveLength(10);
  });
});

describe("computeSubRawDiscovery — pins", () => {
  it("pins defaults", () => {
    expect(_DEFAULTS.maxRawPrice).toBe(30);
    expect(_DEFAULTS.minExpectedGain).toBe(200);
    expect(_DEFAULTS.minExpectedGainMultiple).toBe(5);
    expect(_DEFAULTS.gradingCostAssumed).toBe(80);
    expect(_DEFAULTS.minFamilyConfidence).toBe("medium");
    expect(_DEFAULTS.topN).toBe(25);
  });
});
