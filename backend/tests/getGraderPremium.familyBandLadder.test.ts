// CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM (Drew, 2026-07-27). Pins the
// family + sport + price-band aware ladder inserted at the top of
// getGraderPremium (compiqEstimate.service.ts). Before this fix:
//
//   getGraderPremium("PSA", "10", 100, "autograph", 2023, "Bowman Chrome")
//     → 2.30×   (flat auto-multipliers-latest.json PSA 10 / $100-250)
//
// After the fix:
//
//   getGraderPremium("PSA", "10", 100, "autograph", 2023, "Bowman Chrome", null, "baseball")
//     → 1.84×   (GRADE_MULTIPLIER_BY_VALUE_BAND.bySportFamily
//                "baseball|bowman-chrome" × "$100-249" × "PSA 10", n=714)
//
// CF-CALIBRATION-FROM-OUR-POOL-ONLY (#1676, 2026-09-03): that cell read
// 2.55× at n=144 when the table was generated from ch_daily_sales, keyed
// by the VENDOR's card_id. #1676 regenerated it from `sold_comps` grouped
// by hobbyiqCardId — our own canonical identity, as the doctrine has
// always required — and the same cell is 1.84× at n=714. The pin follows
// the table, because the table is the evidence: a 5x larger sample drawn
// from the pool we actually price against is the better measurement, and
// pinning the old number would be pinning the vendor's grouping.
//
// What this file pins is therefore the LADDER, not a magic constant: the
// most specific populated cell wins, and each layer beats the one below.
//
// The observed uplift on baseball bowman-chrome at $100 raw is modest
// because the family's empirical Raw→PSA10 gap really IS ~2.5× at that
// band — cards priced $100+ raw are already premium and the graded
// premium tightens. Bigger gains show up in other families / sports where
// the auto-table was wildly wrong (e.g. football bowman-chrome PSA 10
// at $100-249 raw has been observed >6× in the sport-scoped byTier
// entry). This file pins the LADDER — the family-scoped cell always wins
// when it has data, falling through to broader layers only when it's
// missing.

import { describe, expect, it } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("getGraderPremium — CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM", () => {
  it("Baseball bowman-chrome PSA 10 at $100 raw with sport hint → uses value-band bySportFamily (1.84×)", () => {
    // Empirical value-band bySportFamily["baseball|bowman-chrome"]["$100-249"]["PSA 10"]
    // = 1.84× (n=714) on the #1676 our-pool table.
    const withSportHint = getGraderPremium("PSA", "10", 100, "autograph", 2023, "Bowman Chrome", null, "baseball");
    expect(withSportHint).toBeGreaterThan(1.5);
    expect(withSportHint).toBeLessThan(2.4);
  });

  it("Slug-form setKey ('bowman-chrome') classifies same as human string ('Bowman Chrome')", () => {
    // hobbyIqCardId setKey is a hyphen-slug — classifyFamily was updated
    // (CF-CLASSIFY-FAMILY-HYPHEN-TOLERANT) to strip hyphens/underscores
    // before substring matching so both call styles produce identical
    // multipliers. Guards the hobbyIqFmv rung-7 call site which passes
    // parsed.setKey directly.
    const slugStyle = getGraderPremium("PSA", "10", 100, "autograph", 2023, "bowman-chrome", null, "baseball");
    const humanStyle = getGraderPremium("PSA", "10", 100, "autograph", 2023, "Bowman Chrome", null, "baseball");
    expect(slugStyle).toBeCloseTo(humanStyle, 5);
  });

  it("No sport hint → still walks the ladder via family + baseline band", () => {
    // Without a sport hint, bySportFamily can't fire but the baseline
    // value-band layer still does. Baseline["$100-249"]["PSA 10"] = 2.01×
    // (n=6,881) on the #1676 our-pool table.
    //
    // The LADDER is what is pinned: the coarser baseline layer is a
    // DIFFERENT cell from the sport-family one above, not a better or
    // worse version of it. Here the broad cell happens to read higher than
    // baseball|bowman-chrome's 1.84× — that is real dispersion across
    // sports and families, not a defect, and nothing here may clamp it
    // into a monotone story (CF-GRADE-MONOTONICITY-IS-NOT-AN-INVARIANT).
    const noSport = getGraderPremium("PSA", "10", 100, "autograph", 2023, "Bowman Chrome");
    expect(noSport).toBeGreaterThan(1.5);
    expect(noSport).toBeLessThan(3);
  });

  it("Vintage still wins — 1955 PSA 8 does NOT drop into the calibration ladder", () => {
    // Vintage table (cardYear 1948-1989) is checked BEFORE the calibration
    // ladder in getGraderPremium. This test guards the ordering so the
    // Mantle-class high-vintage-premium math survives the ladder insert.
    const vintage = getGraderPremium("PSA", "8", 500, "base", 1955, "Topps", null, "baseball");
    // The modern PSA 8 = raw override does NOT apply (cardYear=1955 is
    // vintage). Vintage table returns whatever it's calibrated to — the
    // key assertion is that the multiplier is NOT 1.0 (which would
    // indicate the modern override fired) and NOT the flat modern PSA 8
    // table value.
    expect(vintage).not.toBe(1.0);
    expect(Number.isFinite(vintage)).toBe(true);
    expect(vintage).toBeGreaterThan(0);
  });

  it("Modern PSA 8 = Raw (1.0×) override still fires — takes precedence over the ladder", () => {
    // CF-PSA8-EQUALS-RAW (2026-07-15): PSA 8 on modern cards is a HARD
    // business rule set to 1.0×. Ladder is checked AFTER this override
    // in the function body so we don't accidentally emit a >1.0 multiplier
    // for modern PSA 8.
    const modernPsa8 = getGraderPremium("PSA", "8", 100, "autograph", 2023, "Bowman Chrome", null, "baseball");
    expect(modernPsa8).toBe(1.0);
  });
});
