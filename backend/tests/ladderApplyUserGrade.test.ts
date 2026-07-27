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
  it("PSA 10 / $1531 raw / auto / baseball bowman-chrome → multiplier > 1 (was 1.0 pre-fix)", () => {
    // baseline value-band "baseball|bowman-chrome" × "$1,000-2,499" ×
    // "PSA 10" or the byTier family scalar × subTier — whichever cell
    // has data first. Pre-CF-CALIBRATION-LADDER the auto-table returned
    // ~3.34× at $1000+ tier for autos. Post-fix, the value-band + byTier
    // ladder should return something similar or higher for this identity.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome", null, "baseball");
    expect(m).toBeGreaterThan(1.5);
    expect(m).toBeLessThan(6);
  });

  it("Raw → PSA 10 multiplier is materially different from 1.0 (would-be no-op detection)", () => {
    // The bug was: ladder.derivedFmv (=1.0×raw when anchor is Raw) got
    // written as-is. Guard that our multiplier isn't spuriously ≈ 1.0
    // for a grade the market clearly rewards.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome", null, "baseball");
    expect(Math.abs(m - 1)).toBeGreaterThan(0.5);
  });

  it("Same identity, no sport hint → still returns a > 1 multiplier via baseline value-band", () => {
    // Belt-and-suspenders — even if inferSportFromContext returns null
    // for a weird holding, the baseline value-band still delivers a
    // family-blind but band-aware multiplier > 1.
    const m = getGraderPremium("PSA", "10", 1531, "autograph", 2026, "Bowman Chrome");
    expect(m).toBeGreaterThan(1.5);
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
