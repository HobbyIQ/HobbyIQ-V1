// CF-LADDER-APPLY-USER-GRADE (Drew, 2026-07-27).
//
// Pin the multiplier-conversion step in applyGradeLadderFallback. Before
// this fix, a PSA 10 holding with only Raw comps in the ladder persisted
// at ladder.derivedFmv = ladder.anchorPrice (Raw as-is), because the
// helper always requested "Raw" and never applied a grade multiplier.
// The comment ON that requestedGrade:"Raw" line claimed the auto-aware
// multiplier table would do the conversion — but no code actually did.
//
// The fix routes ladder.anchorPrice through getGraderPremium (family +
// sport + price-band aware post PR #837) so PSA 10 / BGS 9.5 / etc.
// holdings get their real premium.
//
// CF-CALIBRATION-FROM-OUR-POOL-ONLY (#1676, 2026-09-03): the value-band
// table was regenerated from `sold_comps` grouped by hobbyiqCardId — our
// canonical identity — replacing one derived from ch_daily_sales and keyed
// by the vendor's card_id. The cells this file reads moved accordingly:
// bySportFamily["baseball|bowman-chrome"]["$1,000-2,499"]["PSA 10"] is
// 1.40× at n=68, and the family-blind baseline for that band is 1.61× at
// n=574. The DEFECT this file guards is unchanged — a Raw anchor written
// through unmultiplied, i.e. exactly 1.0 — so the pin now states that
// boundary directly instead of a threshold borrowed from the retired
// vendor-keyed table.
//
// Note the shape of the real data: the graded premium COMPRESSES as the
// raw anchor rises (baseball|bowman-chrome PSA 10 runs 4.34× under $25,
// 2.09× at $50-99, 1.84× at $100-249, 1.40× at $1,000-2,499). A $1,531
// anchor is already a premium card, so a multiplier near 1.4 is the
// measurement, not a miss. Nothing here may assert a floor the pool does
// not support (CF-EMPIRICAL-ONLY, and no medians — the cell is the pool's
// own measured ratio).
//
// This test drives applyGradeLadderFallback indirectly by verifying
// getGraderPremium itself for the specific case that reaches Drew's
// Hartman Orange Shimmer holding: baseball, Bowman Chrome, isAuto=true,
// PSA 10, $1531 Raw anchor. The engine assembles applyGradeLadderFallback
// from those pieces; testing the engine's contribution is the pin. A
// full integration test through autoPriceHolding would require Cosmos,
// which isn't available in the unit-test env.

import { describe, expect, it } from "vitest";
import { getGraderPremium } from "../src/services/compiq/compiqEstimate.service.js";

describe("CF-LADDER-APPLY-USER-GRADE — Raw anchor × user grade multiplier", () => {
  it("PSA 10 / $1531 raw / auto / baseball bowman-chrome → multiplier > 1 (was exactly 1.0 pre-fix)", () => {
    // Resolves bySportFamily["baseball|bowman-chrome"]["$1,000-2,499"]
    // ["PSA 10"] = 1.40× (n=68) on the #1676 our-pool table. The pin is
    // the defect boundary: the Raw anchor must be MULTIPLIED, so anything
    // at or below 1.0 is the bug returning.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome", null, "baseball");
    expect(m).toBeGreaterThan(1.2);
    expect(m).toBeLessThan(6);
  });

  it("Raw → PSA 10 multiplier is materially different from 1.0 (would-be no-op detection)", () => {
    // The bug was: ladder.derivedFmv (=1.0×raw when anchor is Raw) got
    // written as-is. Guard that our multiplier isn't spuriously ≈ 1.0.
    //
    // The margin states what the pool supports at THIS band and no more:
    // 1.40× is a 40% premium, so a 0.5 absolute margin (the pre-#1676
    // number, chosen against a table that read ~3.3× here) would now be
    // asserting a premium the measured cell does not contain. 0.2 still
    // catches the no-op — a passed-through anchor is exactly 1.0 — without
    // demanding a floor from the data.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome", null, "baseball");
    expect(Math.abs(m - 1)).toBeGreaterThan(0.2);
  });

  it("Same identity, no sport hint → still returns a > 1 multiplier via baseline value-band", () => {
    // Belt-and-suspenders — even if inferSportFromContext returns null
    // for a weird holding, the baseline value-band still delivers a
    // family-blind but band-aware multiplier > 1.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome");
    expect(m).toBeGreaterThan(1.2);
  });

  it("Raw holding (no grade) → multiplier = 1.0 (fix must not overreach)", () => {
    // applyGradeLadderFallback skips the multiplier conversion when the
    // holding has no grade — Raw stays Raw. This case is the guard that
    // the fix doesn't accidentally lift Raw holdings above their comp
    // pool median.
    //
    // getGraderPremium with empty grade returns 1.0 by contract.
    const m = getGraderPremium("", "", 1531, "autograph", 2026, "Bowman Chrome", null, "baseball");
    expect(m).toBe(1.0);
  });
});
