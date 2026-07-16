// CF-NO-NULL-PRICING (2026-07-11, Drew — Tier 7 setDocTypeBaseline tests).
// Locks the era classifier + set-type normalizer + baseline lookup +
// grade-adjusted floor. This is the deepest fallback in the pricing
// chain; the module's contract MUST be stable across grade projections
// and iOS display expectations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  eraForYear,
  normalizeSetType,
  lookupSetDocBaseline,
  applyGradeToSetDocBaseline,
} from "../src/services/compiq/setDocTypeBaseline";

describe("eraForYear", () => {
  it("buckets by hobby milestone", () => {
    expect(eraForYear(1988)).toBe("1988-1994");
    expect(eraForYear(1994)).toBe("1988-1994");
    expect(eraForYear(1995)).toBe("1995-2005");
    expect(eraForYear(2005)).toBe("1995-2005");
    expect(eraForYear(2006)).toBe("2006-2015");
    expect(eraForYear(2015)).toBe("2006-2015");
    expect(eraForYear(2016)).toBe("2016-2026");
    expect(eraForYear(2026)).toBe("2016-2026");
  });

  it("returns null outside supported range", () => {
    expect(eraForYear(1887)).toBeNull(); // vintage era — use SetDoc directly
    expect(eraForYear(1987)).toBeNull();
    expect(eraForYear(2031)).toBeNull();
    expect(eraForYear(NaN)).toBeNull();
  });
});

describe("normalizeSetType", () => {
  it("maps common setType strings to table keys", () => {
    expect(normalizeSetType("Base")).toBe("base");
    expect(normalizeSetType("Premium")).toBe("premium");
    expect(normalizeSetType("Ultra Premium")).toBe("ultra-premium");
    expect(normalizeSetType("Chromium")).toBe("chromium");
    expect(normalizeSetType("Premium Chromium")).toBe("premium-chromium");
    expect(normalizeSetType("Retro")).toBe("retro");
    expect(normalizeSetType("Throwback")).toBe("retro");
    expect(normalizeSetType("Autograph")).toBe("autograph");
    expect(normalizeSetType("Metallic")).toBe("metallic");
    expect(normalizeSetType("Draft")).toBe("draft");
    expect(normalizeSetType("Prospects")).toBe("draft");
    expect(normalizeSetType("Draft Premium")).toBe("draft");
    expect(normalizeSetType("Chromium Update")).toBe("chromium");
    expect(normalizeSetType("Sapphire Chromium")).toBe("sapphire-chromium");
  });

  it("prefers most-specific match", () => {
    // "premium chromium" contains both "premium" and "chromium" —
    // the premium-chromium bucket should win.
    expect(normalizeSetType("Premium Chromium")).toBe("premium-chromium");
    // "ultra premium" contains "premium" — ultra-premium wins.
    expect(normalizeSetType("Ultra Premium")).toBe("ultra-premium");
  });

  it("defaults to base for unknown / empty", () => {
    expect(normalizeSetType(null)).toBe("base");
    expect(normalizeSetType(undefined)).toBe("base");
    expect(normalizeSetType("")).toBe("base");
    expect(normalizeSetType("garbage-set-type")).toBe("base");
  });
});

describe("lookupSetDocBaseline", () => {
  beforeEach(() => {
    delete process.env.COMPIQ_SETDOC_BASELINE_ENABLED;
  });

  it("returns null when env flag is off (default)", () => {
    expect(lookupSetDocBaseline("Base", 1990)).toBeNull();
    expect(lookupSetDocBaseline("Premium Chromium", 2020)).toBeNull();
  });

  it("returns baseline for junk-wax Base", () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    const r = lookupSetDocBaseline("Base", 1990);
    expect(r).not.toBeNull();
    expect(r!.baseline).toBe(2);
    expect(r!.era).toBe("1988-1994");
    expect(r!.setTypeKey).toBe("base");
    expect(r!.range.low).toBe(0.6);
    expect(r!.range.high).toBe(6);
  });

  it("returns baseline for modern Premium Chromium", () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    const r = lookupSetDocBaseline("Premium Chromium", 2020);
    expect(r!.baseline).toBe(75);
    expect(r!.era).toBe("2016-2026");
    expect(r!.setTypeKey).toBe("premium-chromium");
  });

  it("returns baseline for modern Ultra Premium (highest tier)", () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    const r = lookupSetDocBaseline("Ultra Premium", 2024);
    expect(r!.baseline).toBe(250);
    expect(r!.era).toBe("2016-2026");
    expect(r!.setTypeKey).toBe("ultra-premium");
  });

  it("returns null for pre-1988 vintage year", () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    // Vintage era uses SetDoc directly, not the era baseline table.
    expect(lookupSetDocBaseline("Base", 1970)).toBeNull();
  });

  it("defaults to base baseline for unknown setType", () => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
    const r = lookupSetDocBaseline("Some Weird Set Type", 2020);
    expect(r!.setTypeKey).toBe("base");
    expect(r!.baseline).toBe(8); // 2016-2026 base
  });
});

describe("applyGradeToSetDocBaseline", () => {
  beforeEach(() => {
    process.env.COMPIQ_SETDOC_BASELINE_ENABLED = "true";
  });

  it("multiplies baseline by grade multiplier", () => {
    // 2020 Chromium base = 45, PSA 10 mult (say 6x) → 270
    const r = applyGradeToSetDocBaseline("Chromium", 2020, 6);
    expect(r).not.toBeNull();
    expect(r!.baseline).toBe(45);
    expect(r!.floor).toBe(270);
    expect(r!.floorRange.low).toBe(13.5 * 6);
    expect(r!.floorRange.high).toBe(135 * 6);
  });

  it("defaults grade multiplier to 1 for null/invalid", () => {
    const rNull = applyGradeToSetDocBaseline("Base", 2020, null);
    expect(rNull!.floor).toBe(8);
    const rNaN = applyGradeToSetDocBaseline("Base", 2020, NaN);
    expect(rNaN!.floor).toBe(8);
    const rNeg = applyGradeToSetDocBaseline("Base", 2020, -1);
    expect(rNeg!.floor).toBe(8);
  });

  it("returns null when the baseline lookup returns null", () => {
    // Pre-1988 → null baseline → null result
    expect(applyGradeToSetDocBaseline("Base", 1970, 5)).toBeNull();
  });
});
