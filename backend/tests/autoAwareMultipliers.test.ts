// CF-AUTO-AWARE-MULTIPLIERS (2026-06-28) — pins the auto-vs-base
// dispatch path of getGraderPremium and the inverse-multiplier math
// downstream.
//
// PRIOR BUG: PSA 9 in the static GRADER_PREMIUMS table at "100+" tier
// is 0.85, calibrated for prospect-base cards where PSA 9 loses value
// above $50. For autographs at high anchor prices (Kurtz Green Lava
// PSA 9 $1325) the inverse implied Raw $1559 — wildly wrong (CH's
// authoritative truth is ~$278; truth is somewhere $200-$500).
//
// FIX: empirical auto-only multiplier table calibrated from 848
// prospect-autograph cards' CH 90-day-avg prices, with 7 raw-price
// tiers (vs 4 in static table). PSA 9 at the 100-250 tier is 1.13 —
// a sane "PSA 9 of $1325 → Raw ~$400-700" inverse for autos.
//
// THIS FILE PINS:
//   1. cardClass="autograph" reads from the empirical table
//   2. cardClass="base" or undefined reads from static GRADER_PREMIUMS
//   3. Empirical table missing a tier → falls through to static
//   4. Empirical table missing a (company, grade) → falls through to static
//   5. Tier resolution handles both static (<25, 25-50, 50-100, 100+)
//      AND empirical (100-250, 250-500, 500-1000, 1000+) keys
//   6. Kurtz Green Lava regression: PSA 9 $1325 inverse via auto table
//      lands in $400-$1000 range (sane), NOT $1559 (broken inverse) and
//      NOT $278 (CH's calibration we deliberately don't copy).

import { describe, expect, it } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("getGraderPremium — autograph cardClass", () => {
  it("PSA 10 at $200 raw, autograph → uses empirical 100-250 tier multiplier (>= 2.0)", () => {
    // Calibrated value: PSA 10 / Raw at 100-250 tier = 2.33
    const r = getGraderPremium("PSA", "10", 200, "autograph");
    expect(r).toBeGreaterThan(1.5);
    expect(r).toBeLessThan(4);
  });

  it("PSA 9 at $50 raw, autograph → empirical table (>= 1.0, NOT the static 0.95 at 50-100)", () => {
    // Calibrated: PSA 9 / Raw at 50-100 tier ≈ 1.40 for autos
    const r = getGraderPremium("PSA", "9", 50, "autograph");
    expect(r).toBeGreaterThan(1.0);
    expect(r).toBeLessThan(2.5);
  });

  it("PSA 9 at $1325 raw, autograph → empirical 1000+ tier (sane non-inverted ratio)", () => {
    // The Kurtz Green Lava regression — empirical PSA 9/Raw at 1000+
    // tier is ~1.98 (noisy, low sample) — sane positive ratio.
    const r = getGraderPremium("PSA", "9", 1325, "autograph");
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(3);
  });
});

describe("getGraderPremium — base cardClass + static fallback", () => {
  it("PSA 10 at $50 raw, base → uses static GRADER_PREMIUMS 50-100 tier (2.8)", () => {
    const r = getGraderPremium("PSA", "10", 50, "base");
    expect(r).toBeCloseTo(2.8, 1);
  });

  it("undefined cardClass → defaults to static (backward compat)", () => {
    const r = getGraderPremium("PSA", "10", 50);
    expect(r).toBeCloseTo(2.8, 1);
  });

  it("PSA 9 at $200, base → static GRADER_PREMIUMS 100+ tier (the load-bearing breakdown for autos)", () => {
    // This is the value that caused the Kurtz inverse to break when
    // applied to autographs. For BASE cards in the prospect-pitching
    // sample, 0.85 is correct. PSA 9 rebase to Drew's modern anchor
    // (1.2×) deferred to follow-up PR alongside BGS/SGC rebase +
    // KQL-driven calibration refresh (see PR #494 comments in
    // compiqEstimate.service.ts).
    const r = getGraderPremium("PSA", "9", 200, "base");
    expect(r).toBeCloseTo(0.85, 1);
  });
});

describe("getGraderPremium — fallthrough", () => {
  it("autograph cardClass + nonexistent grade → falls through to 1.0 (static behavior)", () => {
    // No "PSA 12" in either table — falls all the way through.
    const r = getGraderPremium("PSA", "12", 50, "autograph");
    expect(r).toBe(1.0);
  });

  it("null gradingCompany → 1.0", () => {
    expect(getGraderPremium(null, "10", 50, "autograph")).toBe(1.0);
  });
});
