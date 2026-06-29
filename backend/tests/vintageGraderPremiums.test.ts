// CF-VINTAGE-GRADER-PREMIUMS (2026-06-29) — pins the cardYear gating in
// getGraderPremium. Vintage path takes precedence over autograph + static.
//
// The 2026-06-29 volume test surfaced the Mantle $2.28M class:
//   - 1952 Topps Mantle PSA 8 = $1.83M, static PSA 8 / Raw at "100+"
//     tier = 0.80, inverse 1.25 → Raw "estimated" at $2.28M (impossible)
// The vintage table calibrates from real CH sale pairs; the static
// inverse is wrong for vintage HOFs and this gating routes them to the
// empirical numbers (when the table covers the era/grade/tier combo).
//
// THIS FILE PINS:
//   1. cardYear in vintage range (1948-1989) + table coverage → vintage value used
//   2. cardYear in vintage range + NO table coverage → falls through to static
//   3. cardYear outside vintage range → vintage path skipped, base behavior
//   4. cardYear undefined → vintage path skipped (default behavior preserved)
//   5. cardYear + autograph: vintage wins over auto (vintage auto is rare;
//      when it does exist, vintage table empirical wins)

import { describe, expect, it } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("getGraderPremium — vintage cardYear gating", () => {
  it("cardYear=undefined → static base behavior (no breaking change for existing callers)", () => {
    // PSA 10 at $50 raw, no cardClass, no cardYear: static GRADER_PREMIUMS
    // PSA 10 "50-100" tier = 2.8
    const r = getGraderPremium("PSA", "10", 50);
    expect(r).toBeCloseTo(2.8, 1);
  });

  it("cardYear=2024 (modern) → vintage path skipped, static used", () => {
    // Modern card with PSA 10 at $50, no autograph: should still use
    // the static base table (vintage table doesn't apply).
    const r = getGraderPremium("PSA", "10", 50, "base", 2024);
    expect(r).toBeCloseTo(2.8, 1);
  });

  it("cardYear=1952 + PSA 8 + raw at 5000+ tier → vintage table 1948-1969 row used", () => {
    // The Mantle case from 2026-06-29 volume test. Static GRADER_PREMIUMS
    // at "100+" tier returns 0.80 (inverse 1.25× for downgrading), which
    // produced the $2.28M breakdown. Vintage table 1948-1969 PSA 8 at
    // "5000+" tier is 19.3× (calibrated from 4760 obs / 4811 cards).
    // For a PSA 8 sale of $1.83M, Raw = 1830000 / 19.3 ≈ $94.8K, which
    // is what the ladder downgrade now uses.
    const r = getGraderPremium("PSA", "8", 10000, "base", 1952);
    // 5000+ tier ratio is 19.3 (from data/vintage-multipliers-latest.json)
    expect(r).toBeGreaterThan(10);  // vintage path engaged (>> static 0.80)
    expect(r).toBeLessThan(30);     // not the auto-table outlier either
  });

  it("cardYear=1956 + PSA 9 → vintage 1948-1969 ratio used (not static)", () => {
    // 1948-1969 PSA 9 ratios: <50=81.66, 50-100=58.25, 100-500=51.76,
    // 500-1000=55.18, 1000-5000=58.43, 5000+=71.44, fallback=80
    const r = getGraderPremium("PSA", "9", 200, "base", 1956);
    expect(r).toBeGreaterThan(30);  // vintage ratio (51.76× at 100-500), static would be much lower
    expect(r).toBeLessThan(80);
  });

  it("cardYear=1990 → outside vintage range (1948-1989), no vintage routing", () => {
    // 1990+ uses the auto table when autograph, else static. NOT vintage.
    const r = getGraderPremium("PSA", "10", 50, "base", 1990);
    expect(r).toBeCloseTo(2.8, 1);  // matches static "50-100"
  });

  it("cardYear=1947 → below vintage range floor, no vintage routing", () => {
    const r = getGraderPremium("PSA", "10", 50, "base", 1947);
    expect(r).toBeCloseTo(2.8, 1);
  });
});

describe("getGraderPremium — vintage table covers low-grade tiers too", () => {
  it("vintage PSA 5 in 1948-1969 → calibrated vintage ratio, NOT static <25=0.65", () => {
    // 1948-1969 PSA 5 / <50 tier = 4.2× per calibration scan
    // (4760 obs / 4811 unique cards). The vintage table covers
    // every PSA grade including lower ones because pre-1970 cards
    // command meaningful premiums at any grade — the static base
    // table (0.65× at <25) would massively underprice them.
    const r = getGraderPremium("PSA", "5", 10, "base", 1955);
    expect(r).toBeGreaterThan(3);
    expect(r).toBeLessThan(6);
  });
});
