// CF-BASE-MULTIPLIER-ENGINE-WIRING (2026-06-29) — pins the env-gated
// engine wiring for the empirical base-multipliers table.
//
// CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM (Drew, 2026-07-27) update:
// A calibration ladder was inserted at the top of getGraderPremium that
// runs BEFORE the base/auto tables. When
// GRADE_MULTIPLIER_BY_VALUE_BAND.baseline has data for the requested
// (grader, gradeValue, priceBand), the ladder returns that empirical
// value regardless of the MULTIPLIER_BASE_TABLE_ENABLED flag. For modern
// PSA 10 at <$25 raw, the baseline value-band cell is ~10.5× (n=1526) —
// this is the empirical-only doctrine (memory: retired hardcoded matrix
// per PR #633). The MULTIPLIER_BASE_TABLE_ENABLED flag now controls a
// SECONDARY empirical path that only fires when the ladder misses.
//
// THIS FILE PINS:
//   1. Ladder fires for every branch that has empirical baseline data —
//      flag setting doesn't matter for the covered (band, grade) cells
//   2. Vintage + autograph precedence order still holds above the ladder
//   3. Missing combo (grade outside [5,10]) still falls to 1.0

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-BASE-MULTIPLIER-ENGINE-WIRING — env-gated", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("flag OFF (default) — calibration ladder still fires", () => {
    beforeEach(() => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "");
    });

    it("PSA 10 / $20 raw / cardClass=base → value-band baseline <$25 tier (~10.5×, was static 5.0)", () => {
      // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM: value-band baseline
      // for "Under $25" × "PSA 10" is 10.5× (n=1526). Fires before
      // any static-table fallback regardless of the base-table flag.
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(8);
      expect(r).toBeLessThan(15);
    });

    it("PSA 10 / no rawPrice → static fallback still fires (ladder skipped when rawPrice missing)", () => {
      // Ladder requires rawPrice > 0 to bucket into a value-band, so
      // rawPrice-less calls still walk the legacy static path.
      const r = getGraderPremium("PSA", "10");
      expect(r).toBeCloseTo(3.5, 2);
    });
  });

  describe("flag ON — empirical base table used", () => {
    beforeEach(() => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "true");
    });

    it("PSA 10 / $20 raw / cardClass=base / modern year → empirical (~11×, NOT static 4.9)", () => {
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(8);
      expect(r).toBeLessThan(15);
    });

    it("PSA 10 / no rawPrice → empirical fallback (~9.17, NOT static 3.43)", () => {
      const r = getGraderPremium("PSA", "10");
      expect(r).toBeGreaterThan(7);
      expect(r).toBeLessThan(12);
    });

    it("VINTAGE precedence: PSA 8 cardYear=1952 → vintage table (not base)", () => {
      const r = getGraderPremium("PSA", "8", 10000, "base", 1952);
      expect(r).toBeGreaterThan(10);
      expect(r).toBeLessThan(30);
    });

    it("AUTOGRAPH precedence: PSA 10 cardClass=autograph → auto table (not base)", () => {
      const r = getGraderPremium("PSA", "10", 20, "autograph", 2024);
      // Auto-table value, not the empirical base 11×.
      expect(r).toBeGreaterThan(1);
      expect(r).toBeLessThan(15);
    });

    it("Missing combo: PSA 11 → falls through to 1.0 (ladder skips grades >10)", () => {
      // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM: the family-scalar
      // layer of the ladder is bounded to [5, 10] because
      // subTierScalingForFallback would extrapolate wildly for invalid
      // grades. PSA 11 falls through to the auto/base tables, misses,
      // and lands on the last-line 1.0.
      const r = getGraderPremium("PSA", "11", 100, "base", 2024);
      expect(r).toBe(1.0);
    });
  });

  describe("flag accepts only literal 'true' (defensive)", () => {
    it("'TRUE' (uppercase) → still parsed as enabled (case-insensitive)", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "TRUE");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(8);  // empirical
    });

    it("'1' → base-table flag NOT enabled, but ladder still fires with empirical value", () => {
      // Post-CF-CALIBRATION-LADDER: value-band baseline fires regardless
      // of the base-table flag. The env flag now only gates a SECONDARY
      // empirical path when the ladder misses.
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "1");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(8);
      expect(r).toBeLessThan(15);
    });

    it("'yes' → same as '1' — ladder still fires empirical value-band", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "yes");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(8);
      expect(r).toBeLessThan(15);
    });
  });
});
