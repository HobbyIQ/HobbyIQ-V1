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
});
