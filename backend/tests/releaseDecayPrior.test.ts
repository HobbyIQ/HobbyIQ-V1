// CF-RELEASE-DECAY-PRIOR (2026-07-05) — pins the piecewise decay
// schedule + release-date lookup. Calibration test: as we tune the
// schedule constants against real corpus data, these tests document
// the current curve so drift is deliberate.

import { describe, it, expect } from "vitest";
import {
  getReleaseDecayForCard,
  __testing__,
} from "../src/services/compiq/releaseDecayPrior.service.js";

describe("CF-RELEASE-DECAY-PRIOR — getReleaseDecayForCard", () => {
  it("returns null for unknown sets", () => {
    const result = getReleaseDecayForCard(2026, "Some Random Custom Set");
    expect(result).toBeNull();
  });

  it("returns null when year is missing", () => {
    const result = getReleaseDecayForCard(null, "Bowman Chrome");
    expect(result).toBeNull();
  });

  it("returns null when set is missing", () => {
    const result = getReleaseDecayForCard(2026, null);
    expect(result).toBeNull();
  });

  it("returns null for a card whose release is in the future", () => {
    // Now = 2026-04-01 → 2026 Bowman Chrome releases 2026-06-11 (future)
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(result).toBeNull();
  });

  it("returns week-0 aggressive decay for a launch-day card", () => {
    // Now = 2026-06-12 (day after release) → weeksSinceRelease ~0.14
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-06-12T00:00:00Z"),
    );
    expect(result).not.toBeNull();
    expect(result!.decayRatePerWeek).toBe(-0.12);
    expect(result!.blend).toBe(1.00);
    expect(result!.weeksSinceRelease).toBeCloseTo(0.1, 1);
  });

  it("returns week-3 bucket for a card 3 weeks post-release", () => {
    // Now = 2026-07-02 (21 days after release)
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-07-02T00:00:00Z"),
    );
    expect(result).not.toBeNull();
    expect(result!.decayRatePerWeek).toBe(-0.08);
    expect(result!.blend).toBe(0.75);
  });

  it("returns week-5 bucket for a card 5 weeks post-release", () => {
    // Now = 2026-07-16 (35 days after release)
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-07-16T00:00:00Z"),
    );
    expect(result).not.toBeNull();
    expect(result!.decayRatePerWeek).toBe(-0.05);
    expect(result!.blend).toBe(0.50);
  });

  it("returns week-7 bucket for a card 7 weeks post-release", () => {
    // Now = 2026-07-30 (49 days after release)
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-07-30T00:00:00Z"),
    );
    expect(result).not.toBeNull();
    expect(result!.decayRatePerWeek).toBe(-0.02);
    expect(result!.blend).toBe(0.25);
  });

  it("returns null for a card 8+ weeks post-release (mature — pure trend)", () => {
    // Now = 2026-08-08 (58 days after release, >8 weeks)
    const result = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-08-08T00:00:00Z"),
    );
    expect(result).toBeNull();
  });

  it("is case-insensitive on set name", () => {
    const r1 = getReleaseDecayForCard(
      2026,
      "BOWMAN CHROME",
      new Date("2026-07-02T00:00:00Z"),
    );
    const r2 = getReleaseDecayForCard(
      2026,
      "bowman chrome",
      new Date("2026-07-02T00:00:00Z"),
    );
    const r3 = getReleaseDecayForCard(
      2026,
      "Bowman Chrome",
      new Date("2026-07-02T00:00:00Z"),
    );
    expect(r1).not.toBeNull();
    expect(r1?.decayRatePerWeek).toBe(r2?.decayRatePerWeek);
    expect(r2?.decayRatePerWeek).toBe(r3?.decayRatePerWeek);
  });

  it("piecewise schedule monotonically decreases decay magnitude and blend weight", () => {
    // Documents the curve shape — as weeks progress, decay weakens
    // (rate moves toward zero) and blend transfers to matched-cohort.
    const buckets = __testing__.DECAY_SCHEDULE;
    for (let i = 1; i < buckets.length; i++) {
      // Rate becomes LESS negative as weeks progress
      expect(buckets[i].decayRatePerWeek).toBeGreaterThan(
        buckets[i - 1].decayRatePerWeek,
      );
      // Blend weight on decay decreases
      expect(buckets[i].blend).toBeLessThan(buckets[i - 1].blend);
    }
  });
});
