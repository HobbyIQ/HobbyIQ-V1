// CF-VALUE-BAND-V2 (Drew, 2026-07-26). Pins the fall-through ladder for
// lookupValueBandMultiplier: sport+family → sport → baseline → null.
//
// This is the primary safety net for the empirical-only doctrine — the
// ladder must degrade gracefully when finer cells are absent, and it
// must never return a stale finer cell when a coarser cell is more
// current. We test degradation, not staleness (data freshness is a
// calibration-loop concern, not a resolver concern).

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("lookupValueBandMultiplier — v2 fall-through ladder", () => {
  beforeEach(() => { vi.resetModules(); });

  async function loadWithData(overrides: {
    baseline?: Record<string, Record<string, { medianRatio: number; sampleSize: number }>>;
    bySport?: Record<string, Record<string, Record<string, { medianRatio: number; sampleSize: number }>>>;
    bySportFamily?: Record<string, Record<string, Record<string, { medianRatio: number; sampleSize: number }>>>;
  }) {
    // Fake the data module. Every entry needs a full ValueBandTierEntry shape
    // for the type; the resolver only reads medianRatio + sampleSize.
    const asEntry = (mr: number, n: number) => ({
      medianRatio: mr, p25: mr * 0.8, p75: mr * 1.2,
      sampleSize: n, rawMedian: 100, gradedMedian: 100 * mr,
    });
    const mapDepth3 = (src: Record<string, Record<string, { medianRatio: number; sampleSize: number }>>) => {
      const out: Record<string, Record<string, any>> = {};
      for (const [k1, v1] of Object.entries(src ?? {})) {
        out[k1] = {};
        for (const [k2, v2] of Object.entries(v1)) out[k1][k2] = asEntry(v2.medianRatio, v2.sampleSize);
      }
      return out;
    };
    const mapDepth4 = (src: Record<string, Record<string, Record<string, { medianRatio: number; sampleSize: number }>>>) => {
      const out: Record<string, Record<string, Record<string, any>>> = {};
      for (const [k1, v1] of Object.entries(src ?? {})) {
        out[k1] = mapDepth3(v1);
      }
      return out;
    };
    vi.doMock("../src/services/compiq/gradeCalibrationData.js", () => ({
      GRADE_CALIBRATION: {},
      GRADE_CALIBRATION_BY_SPORT: {},
      GRADE_MULTIPLIER_BY_VALUE_BAND: {
        baseline: mapDepth3(overrides.baseline ?? {}),
        bySport: mapDepth4(overrides.bySport ?? {}),
        bySportFamily: mapDepth4(overrides.bySportFamily ?? {}),
      },
    }));
    return await import("../src/services/compiq/gradeCalibrationConfig.js");
  }

  it("returns null when the price band cell doesn't exist anywhere", async () => {
    const mod = await loadWithData({});
    expect(mod.lookupValueBandMultiplier(500, "PSA", 10)).toBeNull();
    expect(mod.lookupValueBandMultiplierWithScope(500, "PSA", 10)).toBeNull();
  });

  it("resolves at baseline when nothing else is set", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
    });
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10)).toBe(3.0);
    const result = mod.lookupValueBandMultiplierWithScope(150, "PSA", 10, {});
    expect(result?.scope).toBe("baseline");
    expect(result?.sampleSize).toBe(50);
  });

  it("prefers bySport when sport ctx is provided AND cell exists", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
      bySport: { baseball: { "$100-249": { "PSA 10": { medianRatio: 4.5, sampleSize: 25 } } } },
    });
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10, { sport: "baseball" })).toBe(4.5);
    const result = mod.lookupValueBandMultiplierWithScope(150, "PSA", 10, { sport: "baseball" });
    expect(result?.scope).toBe("sport");
    expect(result?.sampleSize).toBe(25);
  });

  it("prefers bySportFamily when both sport AND family ctx provided AND cell exists", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
      bySport: { baseball: { "$100-249": { "PSA 10": { medianRatio: 4.5, sampleSize: 25 } } } },
      bySportFamily: { "baseball|bowman": { "$100-249": { "PSA 10": { medianRatio: 5.7, sampleSize: 12 } } } },
    });
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10, { sport: "baseball", family: "bowman" })).toBe(5.7);
    const result = mod.lookupValueBandMultiplierWithScope(150, "PSA", 10, { sport: "baseball", family: "bowman" });
    expect(result?.scope).toBe("sport-family");
    expect(result?.sampleSize).toBe(12);
  });

  it("degrades bySportFamily → bySport when the family cell is empty", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
      bySport: { baseball: { "$100-249": { "PSA 10": { medianRatio: 4.5, sampleSize: 25 } } } },
      // bySportFamily absent for baseball|panini-prizm at this bucket
    });
    const result = mod.lookupValueBandMultiplierWithScope(150, "PSA", 10, { sport: "baseball", family: "panini-prizm" });
    expect(result?.scope).toBe("sport");
    expect(result?.medianRatio).toBe(4.5);
  });

  it("degrades bySport → baseline when the sport cell is empty", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
      // bySport absent for football at this bucket
    });
    const result = mod.lookupValueBandMultiplierWithScope(150, "PSA", 10, { sport: "football", family: "panini-prizm" });
    expect(result?.scope).toBe("baseline");
    expect(result?.medianRatio).toBe(3.0);
  });

  it("degrades all the way to null when no cell in the ladder has data", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
    });
    // Different price band → miss at every level
    expect(mod.lookupValueBandMultiplier(5000, "PSA", 10, { sport: "baseball", family: "bowman" })).toBeNull();
  });

  it("treats sport case-insensitively (input Baseball → key baseball)", async () => {
    const mod = await loadWithData({
      bySport: { baseball: { "$100-249": { "PSA 10": { medianRatio: 4.5, sampleSize: 25 } } } },
    });
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10, { sport: "Baseball" })).toBe(4.5);
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10, { sport: "BASEBALL" })).toBe(4.5);
  });

  it("rejects cells with non-finite / zero / negative medianRatio (data-hygiene guard)", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 0, sampleSize: 10 } } },
    });
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10)).toBeNull();
  });

  it("v1 backwards-compat: called with only 3 args behaves like baseline-only", async () => {
    const mod = await loadWithData({
      baseline: { "$100-249": { "PSA 10": { medianRatio: 3.0, sampleSize: 50 } } },
      bySport: { baseball: { "$100-249": { "PSA 10": { medianRatio: 4.5, sampleSize: 25 } } } },
    });
    // Third-arg-only call (no ctx) — must NOT accidentally resolve bySport
    expect(mod.lookupValueBandMultiplier(150, "PSA", 10)).toBe(3.0);
  });
});
