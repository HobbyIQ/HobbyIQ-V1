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
// CF-CALIBRATION-FROM-OUR-POOL-ONLY (#1676, 2026-09-03) update:
// the value-band table was regenerated from `sold_comps` grouped by
// hobbyiqCardId — our own canonical pool — replacing a table derived from
// ch_daily_sales and keyed by the vendor's card_id. Doctrine already
// required it (calibration comes from OUR pool, never vendor-keyed), and
// H-10 forced it. The numbers below therefore MOVED, and they moved on
// purpose: baseline "Under $25" x "PSA 10" is now 6.80x (n=61,218) where
// the vendor-keyed table said ~10.5x (n=1,526). A 40x larger sample from
// the pool we actually price against is the better number, so the pin
// tracks it rather than the value it replaced.
//
// CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (#1676, audit H-7, Drew's ruling)
// update: the hand-curated GRADER_PREMIUMS matrix that used to sit at the
// bottom of this ladder is DELETED. It was the terminal fallback, so the
// ladder could never refuse; every uncalibrated (company, grade, family,
// sport) cell silently published an invented constant indistinguishable
// from a measured ratio. getGraderPremium now returns `number | null` and
// the no-basis answer is null.
//
// THIS FILE PINS:
//   1. Ladder fires for every branch that has empirical baseline data —
//      flag setting doesn't matter for the covered (band, grade) cells
//   2. Vintage + autograph precedence order still holds above the ladder
//   3. A call the ladder has no empirical cell for REFUSES (returns null)
//      rather than falling through to a constant

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

    it("PSA 10 / $20 raw / cardClass=base → value-band baseline <$25 tier (6.80×, our-pool table)", () => {
      // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM: value-band baseline for
      // "Under $25" × "PSA 10" — 6.80× on the #1676 our-pool table
      // (n=61,218; the retired vendor-keyed table said ~10.5× at n=1,526).
      // Fires before any static-table fallback regardless of the flag.
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(9);
    });

    it("PSA 10 / no rawPrice → the ladder REFUSES (no band to bucket into, no matrix behind it)", () => {
      // Ladder requires rawPrice > 0 to bucket into a value-band.
      // CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (#1676, H-7): the "legacy
      // static path" this case was written for no longer exists. With no
      // rawPrice the ladder cannot bucket into a value band, no other rung
      // covers a bare (company, grade), and the terminal hand-curated
      // matrix that used to answer 3.5× is deleted. The honest answer is
      // that we have no basis for a multiplier — so it REFUSES.
      const r = getGraderPremium("PSA", "10");
      expect(r).toBeNull();
    });
  });

  describe("flag ON — empirical base table used", () => {
    beforeEach(() => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "true");
    });

    it("PSA 10 / $20 raw / cardClass=base / modern year → empirical 6.80×, NOT a static constant", () => {
      // Same our-pool baseline cell as the flag-OFF case: the ladder runs
      // above the base table, so the flag cannot change this answer.
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(9);
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

    it("Missing combo: PSA 11 → REFUSES (ladder skips grades >10, nothing invents a constant)", () => {
      // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM: the family-scalar
      // layer of the ladder is bounded to [5, 10] because
      // subTierScalingForFallback would extrapolate wildly for invalid
      // grades. PSA 11 falls through to the auto/base tables, misses,
      // and — since CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (#1676, H-7)
      // deleted the terminal matrix that used to answer 1.0 — falls off
      // the end of the ladder with no rung. A grade nothing is calibrated
      // for gets a refusal, not a neutral-looking 1.0 that a caller would
      // multiply a real anchor by.
      const r = getGraderPremium("PSA", "11", 100, "base", 2024);
      expect(r).toBeNull();
    });
  });

  describe("flag accepts only literal 'true' (defensive)", () => {
    it("'TRUE' (uppercase) → still parsed as enabled (case-insensitive)", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "TRUE");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(5);  // empirical: the 6.80x our-pool cell
    });

    it("'1' → base-table flag NOT enabled, but ladder still fires with empirical value", () => {
      // Post-CF-CALIBRATION-LADDER: value-band baseline fires regardless
      // of the base-table flag. The env flag now only gates a SECONDARY
      // empirical path when the ladder misses.
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "1");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(9);
    });

    it("'yes' → same as '1' — ladder still fires empirical value-band", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "yes");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(9);
    });
  });
});
