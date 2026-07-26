// CF-GRADE-CALIBRATE-PER-TIER (Drew, 2026-07-22). Pins the fallback
// chain for the empirical calibration lookups so future refactors can't
// silently break the priority order: sport → baseline → other, and
// per-tier → company-level. Uses vi.doMock to swap in a deterministic
// calibration table without depending on the real data file (which is
// regenerated weekly by the "Grade Calibration Refresh" workflow).

import { describe, it, expect, beforeEach, vi } from "vitest";

async function loadWithFixture(data: unknown, bySport: unknown) {
  vi.resetModules();
  vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
    GRADE_CALIBRATION: data,
    GRADE_CALIBRATION_BY_SPORT: bySport,
  }));
  return await import("../src/services/compiq/gradeCalibrationConfig.js");
}

describe("lookupGradeRatio (company-level)", () => {
  beforeEach(() => vi.resetModules());

  it("returns the medianRatio for a covered (family, grader)", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      { "bowman-chrome": { PSA: { medianRatio: 3.5, p25: 2.0, p75: 5.0, sampleSize: 100 } } },
      {},
    );
    expect(lookupGradeRatio("bowman-chrome", "PSA")).toBe(3.5);
  });

  it("returns null when family is uncovered", async () => {
    const { lookupGradeRatio } = await loadWithFixture({}, {});
    expect(lookupGradeRatio("no-such-family", "PSA")).toBeNull();
  });

  it("prefers sport-specific entry when sport is provided", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      { "panini-prizm": { PSA: { medianRatio: 4.0, p25: 2, p75: 6, sampleSize: 50 } } },
      { football: { "panini-prizm": { PSA: { medianRatio: 6.5, p25: 3, p75: 9, sampleSize: 30 } } } },
    );
    expect(lookupGradeRatio("panini-prizm", "PSA", "football")).toBe(6.5);
  });

  it("falls back to baseline when sport-specific cell is absent", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      { "panini-prizm": { PSA: { medianRatio: 4.0, p25: 2, p75: 6, sampleSize: 50 } } },
      { basketball: {} },
    );
    expect(lookupGradeRatio("panini-prizm", "PSA", "basketball")).toBe(4.0);
  });
});

describe("lookupGradeRatioByTier (per-grade)", () => {
  beforeEach(() => vi.resetModules());

  it("returns the per-tier medianRatio when the specific tier is present", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      {
        "bowman-chrome": {
          PSA: {
            medianRatio: 3.5,
            p25: 2,
            p75: 5,
            sampleSize: 100,
            byTier: {
              "10": { medianRatio: 8.2, sampleSize: 60 },
              "9":  { medianRatio: 2.1, sampleSize: 30 },
            },
          },
        },
      },
      {},
    );
    expect(lookupGradeRatioByTier("bowman-chrome", "PSA", 10)).toBe(8.2);
    expect(lookupGradeRatioByTier("bowman-chrome", "PSA", 9)).toBe(2.1);
  });

  it("returns null when the specific tier is absent and no 'other' fallback exists", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      {
        "bowman-chrome": {
          PSA: {
            medianRatio: 3.5,
            p25: 2,
            p75: 5,
            sampleSize: 100,
            byTier: { "10": { medianRatio: 8.2, sampleSize: 60 } },
          },
        },
      },
      {},
    );
    expect(lookupGradeRatioByTier("bowman-chrome", "PSA", 9)).toBeNull();
  });

  it("falls back to 'other' byTier when the family lacks the specific tier", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      {
        "bowman-chrome": {
          PSA: { medianRatio: 3.5, p25: 2, p75: 5, sampleSize: 100 },
        },
        other: {
          PSA: {
            medianRatio: 4.0,
            p25: 2,
            p75: 6,
            sampleSize: 500,
            byTier: { "9": { medianRatio: 2.6, sampleSize: 200 } },
          },
        },
      },
      {},
    );
    expect(lookupGradeRatioByTier("bowman-chrome", "PSA", 9)).toBe(2.6);
  });

  it("prefers sport-specific per-tier over baseline byTier", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      {
        "panini-prizm": {
          PSA: {
            medianRatio: 4.0,
            p25: 2,
            p75: 6,
            sampleSize: 50,
            byTier: { "10": { medianRatio: 8.0, sampleSize: 25 } },
          },
        },
      },
      {
        football: {
          "panini-prizm": {
            PSA: {
              medianRatio: 6.5,
              p25: 3,
              p75: 9,
              sampleSize: 30,
              byTier: { "10": { medianRatio: 12.0, sampleSize: 20 } },
            },
          },
        },
      },
    );
    expect(lookupGradeRatioByTier("panini-prizm", "PSA", 10, "football")).toBe(12.0);
  });

  it("returns null when neither the family nor 'other' covers the tier", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      { other: { PSA: { medianRatio: 4.0, p25: 2, p75: 6, sampleSize: 500 } } },
      {},
    );
    expect(lookupGradeRatioByTier("no-such-family", "PSA", 10)).toBeNull();
  });
});

describe("classifyFamily", () => {
  beforeEach(() => vi.resetModules());

  it("routes 'bowman chrome draft' before 'bowman chrome' before 'bowman'", async () => {
    const { classifyFamily } = await loadWithFixture({}, {});
    expect(classifyFamily("2025 Bowman Draft Chrome Prospect Autographs")).toBe("bowman-chrome-draft");
    expect(classifyFamily("2024 Bowman Chrome")).toBe("bowman-chrome");
    expect(classifyFamily("2024 Bowman")).toBe("bowman");
  });

  it("returns 'other' for unrecognized setName", async () => {
    const { classifyFamily } = await loadWithFixture({}, {});
    expect(classifyFamily("2025 Random Sportscard Corp Emblem")).toBe("other");
    expect(classifyFamily(null)).toBe("other");
    expect(classifyFamily(undefined)).toBe("other");
  });

  // CF-POKEMON-ENGINE-WIRING (Drew, 2026-07-26).
  describe("Pokemon expansion set routing", () => {
    it("routes specific expansion sets to their families", async () => {
      const { classifyFamily } = await loadWithFixture({}, {});
      expect(classifyFamily("2021 Pokemon Evolving Skies")).toBe("pokemon-evolving-skies");
      expect(classifyFamily("2021 Pokemon Fusion Strike")).toBe("pokemon-fusion-strike");
      expect(classifyFamily("2016 Pokemon XY BREAKpoint")).toBe("pokemon-xy");
      expect(classifyFamily("2018 Pokemon Sun & Moon Celestial Storm")).toBe("pokemon-sun-moon");
      expect(classifyFamily("2025 Pokemon Scarlet & Violet White Flare")).toBe("pokemon-scarlet-violet");
      expect(classifyFamily("2023 Pokemon 151")).toBe("pokemon-151");
      expect(classifyFamily("1999 Pokemon Base Set")).toBe("pokemon-base");
    });

    it("falls back to 'pokemon' catch-all for unrecognized expansion sets", async () => {
      const { classifyFamily } = await loadWithFixture({}, {});
      // Pokemon set that isn't in the specific-family list — still maps
      // to sport-scoped calibration, not "other" (which would use
      // baseball ratios).
      expect(classifyFamily("2004 Pokemon Some Obscure Set")).toBe("pokemon");
      expect(classifyFamily("Pokémon Random Japanese Promo")).toBe("pokemon-japanese");
    });
  });
});

// CF-POKEMON-ENGINE-WIRING (Drew, 2026-07-26). Pokemon-safe fallback:
// Pokemon lookups NEVER fall through to baseline (baseball-implicit)
// multipliers. Baseball PSA 10 vs 9 = 2-3×; Pokemon = 10-30×.
// Wrong-number is worse than null in a pricing-icon context.
describe("Pokemon-safe fallback (lookupGradeRatio + lookupGradeRatioByTier)", () => {
  beforeEach(() => vi.resetModules());

  it("uses pokemon sport-scoped entry when present", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      { "pokemon-xy": { PSA: { medianRatio: 2.0, p25: 1, p75: 3, sampleSize: 10 } } },  // baseline
      { pokemon: { "pokemon-xy": { PSA: { medianRatio: 15.0, p25: 8, p75: 25, sampleSize: 40 } } } },
    );
    expect(lookupGradeRatio("pokemon-xy", "PSA", "pokemon")).toBe(15.0);
  });

  it("falls back to pokemon 'pokemon' catch-all family when specific family is uncovered", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      {},
      { pokemon: { "pokemon": { PSA: { medianRatio: 12.0, p25: 6, p75: 20, sampleSize: 200 } } } },
    );
    // pokemon-obscure isn't populated; fallback ladder hits the sport-
    // scoped "pokemon" catch-all family.
    expect(lookupGradeRatio("pokemon-obscure", "PSA", "pokemon")).toBe(12.0);
  });

  it("returns null (NOT baseline baseball) when NO pokemon entry exists", async () => {
    const { lookupGradeRatio } = await loadWithFixture(
      // Baseline has bowman-chrome (would be 3.5x if fall-through fired)
      { "bowman-chrome": { PSA: { medianRatio: 3.5, p25: 2, p75: 5, sampleSize: 100 } } },
      { pokemon: {} },   // Pokemon calibration exists but empty
    );
    // Refuse to serve the baseball ratio for a Pokemon lookup.
    expect(lookupGradeRatio("bowman-chrome", "PSA", "pokemon")).toBeNull();
  });

  it("per-tier: uses pokemon sport-scoped byTier when present", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      {},
      {
        pokemon: {
          "pokemon-vivid-voltage": {
            PSA: {
              medianRatio: 15.0, p25: 8, p75: 25, sampleSize: 40,
              byTier: { "10": { medianRatio: 25.0, sampleSize: 20 }, "9": { medianRatio: 3.0, sampleSize: 15 } },
            },
          },
        },
      },
    );
    expect(lookupGradeRatioByTier("pokemon-vivid-voltage", "PSA", 10, "pokemon")).toBe(25.0);
    expect(lookupGradeRatioByTier("pokemon-vivid-voltage", "PSA", 9, "pokemon")).toBe(3.0);
  });

  it("per-tier: returns null when pokemon calibration lacks the tier (NEVER baseline)", async () => {
    const { lookupGradeRatioByTier } = await loadWithFixture(
      // Baseline HAS 'other' byTier with tier "10" at 4x — the "other"
      // fallback that would fire for non-pokemon sports MUST NOT
      // fire for pokemon.
      {
        other: { PSA: { medianRatio: 4.0, p25: 2, p75: 6, sampleSize: 500, byTier: { "10": { medianRatio: 4.0, sampleSize: 200 } } } },
      },
      { pokemon: {} },
    );
    expect(lookupGradeRatioByTier("pokemon-obscure", "PSA", 10, "pokemon")).toBeNull();
  });
});
