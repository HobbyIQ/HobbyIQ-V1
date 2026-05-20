import { describe, it, expect } from "vitest";
import {
  TIER_MULTIPLIERS,
  MAX_DEFINED_TIER,
  tierMultiplier,
} from "../src/services/compiq/tierMultipliers";

// Issue #25 Phase 3 — tier multiplier lookup unit tests.
// Pure function; no I/O, no fixtures required.

describe("TIER_MULTIPLIERS table", () => {
  it("matches the owner-locked values from the Phase 3 prompt", () => {
    expect(TIER_MULTIPLIERS[1]).toBe(1.0);
    expect(TIER_MULTIPLIERS[2]).toBe(1.5);
    expect(TIER_MULTIPLIERS[3]).toBe(2.5);
    expect(TIER_MULTIPLIERS[4]).toBe(4.0);
    expect(TIER_MULTIPLIERS[5]).toBe(7.0);
    expect(TIER_MULTIPLIERS[6]).toBe(12.0);
    expect(TIER_MULTIPLIERS[7]).toBe(25.0);
    expect(TIER_MULTIPLIERS[8]).toBe(80.0);
  });

  it("is monotonically non-decreasing — higher tier never costs less", () => {
    let prev = -Infinity;
    for (const k of Object.keys(TIER_MULTIPLIERS).map(Number).sort((a, b) => a - b)) {
      const v = TIER_MULTIPLIERS[k];
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("anchors tier 1 at exactly 1.0", () => {
    expect(TIER_MULTIPLIERS[1]).toBe(1.0);
  });

  it("is frozen — runtime mutation must throw or no-op", () => {
    expect(Object.isFrozen(TIER_MULTIPLIERS)).toBe(true);
  });

  it("exposes MAX_DEFINED_TIER consistent with the table", () => {
    expect(MAX_DEFINED_TIER).toBe(8);
    expect(TIER_MULTIPLIERS[MAX_DEFINED_TIER]).toBeDefined();
  });
});

describe("tierMultiplier()", () => {
  it("returns the correct multiplier for every defined tier", () => {
    expect(tierMultiplier(1)).toBe(1.0);
    expect(tierMultiplier(2)).toBe(1.5);
    expect(tierMultiplier(3)).toBe(2.5);
    expect(tierMultiplier(4)).toBe(4.0);
    expect(tierMultiplier(5)).toBe(7.0);
    expect(tierMultiplier(6)).toBe(12.0);
    expect(tierMultiplier(7)).toBe(25.0);
    expect(tierMultiplier(8)).toBe(80.0);
  });

  it("returns null for null / undefined", () => {
    expect(tierMultiplier(null)).toBeNull();
    expect(tierMultiplier(undefined)).toBeNull();
  });

  it("returns null for zero and negative integers", () => {
    expect(tierMultiplier(0)).toBeNull();
    expect(tierMultiplier(-1)).toBeNull();
    expect(tierMultiplier(-100)).toBeNull();
  });

  it("returns null for tiers above the curated ceiling", () => {
    expect(tierMultiplier(9)).toBeNull();
    expect(tierMultiplier(100)).toBeNull();
    expect(tierMultiplier(MAX_DEFINED_TIER + 1)).toBeNull();
  });

  it("returns null for non-integer numeric inputs", () => {
    expect(tierMultiplier(2.5)).toBeNull();
    expect(tierMultiplier(1.0001)).toBeNull();
    expect(tierMultiplier(7.9999)).toBeNull();
  });

  it("returns null for NaN and Infinity", () => {
    expect(tierMultiplier(Number.NaN)).toBeNull();
    expect(tierMultiplier(Number.POSITIVE_INFINITY)).toBeNull();
    expect(tierMultiplier(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it("never throws on hostile input shapes (defence-in-depth)", () => {
    // tierMultiplier accepts `number | null | undefined`, but defensive
    // coding mandates the function not blow up if a caller forces a bad cast.
    expect(() => tierMultiplier("4" as unknown as number)).not.toThrow();
    expect(() => tierMultiplier({} as unknown as number)).not.toThrow();
    expect(() => tierMultiplier([] as unknown as number)).not.toThrow();
    expect(tierMultiplier("4" as unknown as number)).toBeNull();
  });
});
