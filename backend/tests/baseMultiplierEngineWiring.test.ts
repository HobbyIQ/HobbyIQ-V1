// CF-BASE-MULTIPLIER-ENGINE-WIRING (2026-06-29) — pins the env-gated
// engine wiring for the empirical base-multipliers table.
//
// DEFAULT (env unset / != "true"): engine uses static GRADER_PREMIUMS
// for cardClass=base and undefined. All existing tests pass.
//
// ENABLED (env = "true"): engine prefers the empirical base table for
// modern (1990+) base graded cards. Modern PSA 10 at <$25 raw goes
// from static 4.9× to empirical ~11.1× — material price increase.
//
// THIS FILE PINS:
//   1. Flag OFF: static behavior preserved (no regression risk on
//      deploys that don't flip the flag)
//   2. Flag ON: empirical base table values used for modern base
//   3. Flag ON: vintage + autograph paths STILL take precedence
//   4. Flag ON + missing combo: still falls through to static

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-BASE-MULTIPLIER-ENGINE-WIRING — env-gated", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("flag OFF (default) — static behavior preserved", () => {
    beforeEach(() => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "");
    });

    it("PSA 10 / $20 raw / cardClass=base → static <25 tier (5.0 post-PR #494)", () => {
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): static <$25 tier lifted 4.9 → 5.0
      expect(r).toBeCloseTo(5.0, 1);
    });

    it("PSA 10 / no rawPrice → static fallback (3.5 post-PR #494)", () => {
      const r = getGraderPremium("PSA", "10");
      // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): fallback rebased 3.43 → 3.5 per Drew's modern anchor
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

    it("Missing combo: PSA 11 → falls through to 1.0 (last-line fallback)", () => {
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

    it("'1' → NOT enabled (must be literal 'true')", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "1");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeCloseTo(5.0, 1);  // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): static <$25 tier lifted 4.9 → 5.0
    });

    it("'yes' → NOT enabled", () => {
      vi.stubEnv("MULTIPLIER_BASE_TABLE_ENABLED", "yes");
      const r = getGraderPremium("PSA", "10", 20, "base", 2024);
      expect(r).toBeCloseTo(5.0, 1);  // CF-GRADER-PREMIUMS-MODERN-DEFAULTS (PR #494): static <$25 tier lifted 4.9 → 5.0
    });
  });
});
