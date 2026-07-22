// CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Pins the
// empirical value-band lookup: bucket selection, tier lookup, and
// null fall-through when the (bucket, tier) cell is absent.

import { describe, it, expect, beforeEach, vi } from "vitest";

function loadConfig(baseline: unknown) {
  vi.resetModules();
  vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
    GRADE_CALIBRATION: {},
    GRADE_CALIBRATION_BY_SPORT: {},
    GRADE_MULTIPLIER_BY_VALUE_BAND: { baseline },
  }));
  return import("../src/services/compiq/gradeCalibrationConfig.js");
}

// Realistic-shape fixture: bucket "$1,000-2,499" has PSA 10 = 2.4× and
// PSA 9 = 1.5× empirically; other buckets are absent so we can exercise
// fall-through.
const REAL_FIXTURE = {
  "$1,000-2,499": {
    "PSA 10": { medianRatio: 2.4, p25: 1.9, p75: 3.1, sampleSize: 187, rawMedian: 1450, gradedMedian: 3500 },
    "PSA 9":  { medianRatio: 1.5, p25: 1.2, p75: 1.9, sampleSize: 92,  rawMedian: 1400, gradedMedian: 2100 },
  },
  "Under $25": {
    "PSA 10": { medianRatio: 12.5, p25: 8, p75: 20, sampleSize: 5200, rawMedian: 6, gradedMedian: 75 },
    "PSA 9":  { medianRatio: 3.2,  p25: 2, p75: 5,  sampleSize: 1800, rawMedian: 8, gradedMedian: 26 },
  },
};

describe("valueBandBucketOf", () => {
  beforeEach(() => vi.resetModules());

  it("assigns Raw values to the right bucket", async () => {
    const { valueBandBucketOf } = await loadConfig({});
    expect(valueBandBucketOf(5)).toBe("Under $25");
    expect(valueBandBucketOf(24.99)).toBe("Under $25");
    expect(valueBandBucketOf(25)).toBe("$25-49");
    expect(valueBandBucketOf(49.99)).toBe("$25-49");
    expect(valueBandBucketOf(50)).toBe("$50-99");
    expect(valueBandBucketOf(99)).toBe("$50-99");
    expect(valueBandBucketOf(100)).toBe("$100-249");
    expect(valueBandBucketOf(249)).toBe("$100-249");
    expect(valueBandBucketOf(250)).toBe("$250-499");
    expect(valueBandBucketOf(499)).toBe("$250-499");
    expect(valueBandBucketOf(500)).toBe("$500-999");
    expect(valueBandBucketOf(999)).toBe("$500-999");
    expect(valueBandBucketOf(1000)).toBe("$1,000-2,499");
    expect(valueBandBucketOf(1531)).toBe("$1,000-2,499"); // Hartman anchor
    expect(valueBandBucketOf(2500)).toBe("$2,500-4,999");
    expect(valueBandBucketOf(5000)).toBe("$5,000-9,999");
    expect(valueBandBucketOf(10000)).toBe("$10,000+");
    expect(valueBandBucketOf(50000)).toBe("$10,000+");
  });

  it("returns null for invalid inputs", async () => {
    const { valueBandBucketOf } = await loadConfig({});
    expect(valueBandBucketOf(0)).toBeNull();
    expect(valueBandBucketOf(-100)).toBeNull();
    expect(valueBandBucketOf(NaN)).toBeNull();
    expect(valueBandBucketOf(Infinity)).toBeNull();
  });
});

describe("lookupValueBandMultiplier — happy path", () => {
  beforeEach(() => vi.resetModules());

  it("Hartman-shape ($1,531 Raw, PSA 10) → returns 2.4× from bucket $1,000-2,499", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    expect(lookupValueBandMultiplier(1531, "PSA", 10)).toBe(2.4);
  });

  it("cheap base card ($6 Raw, PSA 10) → returns 12.5× from bucket Under $25", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    expect(lookupValueBandMultiplier(6, "PSA", 10)).toBe(12.5);
  });

  it("PSA 9 (different tier) → returns the PSA 9 ratio, not PSA 10", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    expect(lookupValueBandMultiplier(1531, "PSA", 9)).toBe(1.5);
    expect(lookupValueBandMultiplier(6, "PSA", 9)).toBe(3.2);
  });

  it("grader is normalized case-insensitive", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    expect(lookupValueBandMultiplier(1531, "psa", 10)).toBe(2.4);
    expect(lookupValueBandMultiplier(1531, "Psa", 10)).toBe(2.4);
  });
});

describe("lookupValueBandMultiplier — null fall-through", () => {
  beforeEach(() => vi.resetModules());

  it("uncovered bucket → null (caller falls through to next-broader scope)", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    // Bucket $25-49 is absent in fixture
    expect(lookupValueBandMultiplier(35, "PSA", 10)).toBeNull();
  });

  it("uncovered tier within a covered bucket → null", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    // $1,000-2,499 has PSA 10 + PSA 9 but no BGS 10
    expect(lookupValueBandMultiplier(1531, "BGS", 10)).toBeNull();
    // Also no PSA 8
    expect(lookupValueBandMultiplier(1531, "PSA", 8)).toBeNull();
  });

  it("empty baseline (fresh install) → null for every lookup", async () => {
    const { lookupValueBandMultiplier } = await loadConfig({});
    expect(lookupValueBandMultiplier(1500, "PSA", 10)).toBeNull();
    expect(lookupValueBandMultiplier(5, "PSA", 10)).toBeNull();
    expect(lookupValueBandMultiplier(50000, "BGS", 10)).toBeNull();
  });

  it("invalid Raw anchor → null (bucketOf returns null)", async () => {
    const { lookupValueBandMultiplier } = await loadConfig(REAL_FIXTURE);
    expect(lookupValueBandMultiplier(0, "PSA", 10)).toBeNull();
    expect(lookupValueBandMultiplier(-100, "PSA", 10)).toBeNull();
    expect(lookupValueBandMultiplier(NaN, "PSA", 10)).toBeNull();
  });

  it("zero-ratio cell (defensive) → null so caller doesn't zero out FMV", async () => {
    const bad = {
      "$1,000-2,499": {
        "PSA 10": { medianRatio: 0, p25: 0, p75: 0, sampleSize: 100, rawMedian: 1500, gradedMedian: 0 },
      },
    };
    const { lookupValueBandMultiplier } = await loadConfig(bad);
    expect(lookupValueBandMultiplier(1500, "PSA", 10)).toBeNull();
  });
});
