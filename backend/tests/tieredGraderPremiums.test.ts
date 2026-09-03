// CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28) — pins the price-tiered grading
// multiplier table against the Prospects Live MiLB pitcher-prospect dataset.
//
// PRIOR-CF GAP: GRADER_PREMIUMS was flat per (company, grade) — same number
// regardless of raw price. Worked roughly at mid-tiers but systematically
// over-claimed at high raws (PSA 10 at $100+ raw: real 2.2× vs prior 4.0×)
// and under-claimed at low raws (PSA 9 at <$25: real 2.56× vs prior 1.7×).
// The flat table also missed the documented PSA 9 LOSS pattern above $50.
//
// THIS FILE PINS:
//   1. Tier boundaries map raw price → bucket correctly ($25 / $50 / $100).
//   2. Each tier's multiplier matches the article's reported figures.
//   3. Backward-compat: legacy callers without rawPrice get the fallback
//      (overall pitcher-prospect average), not a crash or 1.0.
//   4. Unknown company / grade gracefully returns 1.0.
//   5. Cross-grader scaling (BGS/SGC/CGC vs PSA) preserves the directional
//      hobby convention (BGS 10 > PSA 10 > SGC 10 > CGC 10 at same raw tier).
//
// Sources: Prospects Live — "Pitchers, Hitters, and PSA Grades: The PSA
// Grading Multiplier for MiLB Prospect Cards" (overall PSA 10 = 3.43×,
// PSA 9 = 1.70×, tiered breakdowns 4.9/3.6/2.8/2.2 and 2.56/1.5/<1/<1).

import { describe, expect, it } from "vitest";
import {
  getGraderPremium,
  rawPriceToGradeTier,
  logGraderRatioObserved,
} from "../src/services/compiq/compiqEstimate.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. TIER BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

describe("rawPriceToGradeTier — tier boundary mapping", () => {
  it("undefined / null / non-finite / non-positive → fallback", () => {
    expect(rawPriceToGradeTier(undefined)).toBe("fallback");
    expect(rawPriceToGradeTier(null)).toBe("fallback");
    expect(rawPriceToGradeTier(NaN)).toBe("fallback");
    expect(rawPriceToGradeTier(0)).toBe("fallback");
    expect(rawPriceToGradeTier(-5)).toBe("fallback");
  });

  it("price < $25 → '<25'", () => {
    expect(rawPriceToGradeTier(1)).toBe("<25");
    expect(rawPriceToGradeTier(15)).toBe("<25");
    expect(rawPriceToGradeTier(24.99)).toBe("<25");
  });

  it("price in [$25, $50) → '25-50'", () => {
    expect(rawPriceToGradeTier(25)).toBe("25-50");
    expect(rawPriceToGradeTier(35)).toBe("25-50");
    expect(rawPriceToGradeTier(49.99)).toBe("25-50");
  });

  it("price in [$50, $100) → '50-100'", () => {
    expect(rawPriceToGradeTier(50)).toBe("50-100");
    expect(rawPriceToGradeTier(75)).toBe("50-100");
    expect(rawPriceToGradeTier(99.99)).toBe("50-100");
  });

  it("price >= $100 → '100+'", () => {
    expect(rawPriceToGradeTier(100)).toBe("100+");
    expect(rawPriceToGradeTier(500)).toBe("100+");
    expect(rawPriceToGradeTier(10_000)).toBe("100+");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PSA TIERED VALUES (matches the Prospects Live article)
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — PSA tier values (post-CF-CALIBRATION-LADDER)", () => {
  // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM (Drew, 2026-07-27): the
  // pre-empirical Prospects Live article values (PSA 10 = 5.0 / 3.6 /
  // 2.8 / 2.2 / fallback 3.5) were pinned as the exact contract for
  // years. Ladder now returns the empirical GRADE_MULTIPLIER_BY_VALUE_BAND
  // baseline cells which disagree in the specific numbers but still
  // preserve the qualitative "premium shrinks as raw rises" pattern.
  // Empirical (baseline, n=large across most bands):
  //   PSA 10: <$25=10.5×, $25-49=4.18×, $50-99=3.25×, $500-999=2.44×
  //   PSA  9: <$25=3.78×, $25-49=1.5×, $50-99=1.32×, $500-999=1.16×
  // Ranges below tolerate calibration-refresh drift while pinning the
  // ladder is what actually fires.
  it("PSA 10 — value-band baseline cells fire (>= article values across the tier boundaries)", () => {
    // Thresholds lowered 2026-09-03: the C-4/H-10 regeneration re-derived
    // these cells from sold_comps (our own pool) instead of ch_daily_sales
    // (a vendor key), and the baseline PSA 10 band values came down across
    // the board — 10.5 -> 6.80 at $10, 3.25 -> 2.32 at $75. What the test
    // pins is that the empirical BAND cells fire and preserve the
    // compression curve, not the pre-regeneration magnitudes.
    expect(getGraderPremium("PSA", "10", 10)!).toBeGreaterThan(5.0);
    expect(getGraderPremium("PSA", "10", 35)!).toBeGreaterThan(2.5);
    expect(getGraderPremium("PSA", "10", 75)!).toBeGreaterThan(2.0);
    expect(getGraderPremium("PSA", "10", 500)!).toBeGreaterThan(1.5);
    // CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (2026-09-03, audit H-7 residual).
    // With no rawPrice the value-band ladder cannot fire, and the static
    // fallback that used to answer 3.5 here has been REMOVED. There is no
    // empirical cell keyed on (company, grade) alone, so the honest answer
    // is a refusal — not a hand-anchored constant.
    expect(getGraderPremium("PSA", "10")).toBeNull();
  });

  it("PSA 9 — value-band baseline cells fire (empirical values ≥ article static)", () => {
    // Same regeneration note as PSA 10 above (3.78 -> 2.73 at $10).
    expect(getGraderPremium("PSA", "9", 10)!).toBeGreaterThan(2.0);
    expect(getGraderPremium("PSA", "9", 35)!).toBeGreaterThan(1.1);
    expect(getGraderPremium("PSA", "9", 75)!).toBeGreaterThan(1.0);
    // Post-empirical: PSA 9 at $500-999 is ~1.16× (not sub-1.0 as the
    // article claimed). The article's "PSA 9 loses value above $50" is
    // superseded by the calibration data.
    expect(getGraderPremium("PSA", "9", 500)!).toBeGreaterThan(0.9);
    // See above — no rawPrice, no band, no constant: refuse.
    expect(getGraderPremium("PSA", "9")).toBeNull();
  });

  it("PSA 8 — modern PSA 8 = Raw hard override (PR #494 CF-PSA8-EQUALS-RAW)", () => {
    // CF-PSA8-EQUALS-RAW (Drew, 2026-07-15, PR #494): PSA 8 = Raw as a
    // hard business rule for modern (year >= 1990 OR unknown). The
    // article's "consistently loses value" observation is overridden by
    // Drew's product decision. Vintage still routes through vintage
    // table where PSA 8 correctly returns 10-30× raw.
    expect(getGraderPremium("PSA", "8", 10)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 35)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 75)).toBe(1.0);
    expect(getGraderPremium("PSA", "8", 500)).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. BACKWARD-COMPAT — callers without rawPrice get fallback (overall avg)
// ─────────────────────────────────────────────────────────────────────────────

// CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (2026-09-03, audit H-7 residual).
// This block used to pin the "backward-compat fallback path": with no raw
// price, getGraderPremium answered from a hand-curated per-company matrix
// (PSA 10 -> 3.5, PSA 9 -> 1.2, BGS 9.5 -> 2.8). Those constants are the
// finding. Every empirical rung is keyed on a raw anchor (value band) or
// on a family/sport cell; none can answer from (company, grade) alone.
//
// So the contract inverts: no anchor, no basis, no number. Pinned here so
// a future "convenience default" cannot quietly reintroduce the matrix.
describe("getGraderPremium — no raw anchor means no basis (was: static fallback)", () => {
  it("PSA 10 with no rawPrice refuses instead of returning 3.5", () => {
    expect(getGraderPremium("PSA", "10")).toBeNull();
    expect(getGraderPremium("PSA", "10", null)).toBeNull();
    expect(getGraderPremium("PSA", "10", undefined)).toBeNull();
  });

  it("PSA 9 with no rawPrice refuses instead of returning 1.2", () => {
    expect(getGraderPremium("PSA", "9")).toBeNull();
  });

  it("BGS 9.5 with no rawPrice refuses instead of returning 2.8", () => {
    expect(getGraderPremium("BGS", "9.5")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNKNOWN INPUTS — defensive defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — unknown inputs", () => {
  // CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX: an unknown grader or grade has no
  // cell in any empirical layer. It used to fall to the matrix, miss, and
  // return a bare 1.0 — which reads downstream as "graded is worth exactly
  // raw", a pricing claim, rather than as "we do not know". Refuse.
  it("unknown company → refuses (was 1.0)", () => {
    expect(getGraderPremium("UNKNOWN", "10", 50)).toBeNull();
  });

  it("unknown grade → refuses (was 1.0)", () => {
    expect(getGraderPremium("PSA", "999", 50)).toBeNull();
  });

  // A null company/grade is a different statement from an unknown one: the
  // caller is saying the card is RAW, and raw is 1.0 by definition.
  it("null company → 1.0 (raw by definition, not a fallback)", () => {
    expect(getGraderPremium(null, "10", 50)).toBe(1.0);
  });

  it("null grade → 1.0", () => {
    expect(getGraderPremium("PSA", null, 50)).toBe(1.0);
  });

  it("case-insensitive on company name", () => {
    expect(getGraderPremium("psa", "10", 50)).toBe(getGraderPremium("PSA", "10", 50));
    expect(getGraderPremium("Psa", "10", 500)).toBe(getGraderPremium("PSA", "10", 500));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CROSS-GRADER ORDERING — preserves hobby convention
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — cross-grader directional ordering at same tier", () => {
  it("BGS 10 Black Label > PSA 10 (only grade that consistently beats PSA 10)", () => {
    // CF-BGS-BLACK-LABEL-SPLIT (PR #495): Black Label is a separate grade
    // key from regular BGS 10. Drew: "the only grade that consistently
    // beats PSA 10, 2-4× PSA 10 prices, use ~9-10× raw."
    // Post-CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX the Black Label premium is
    // no longer a 12.0/9.0/7.0/5.5 constant row; it resolves only where
    // the empirical layers actually cover BGS "10 Black Label". Where they
    // do not, the honest answer is null and there is no ordering to assert.
    const psa10 = getGraderPremium("PSA", "10", 50);
    const bgs10bl = getGraderPremium("BGS", "10 Black Label", 50);
    expect(psa10).not.toBeNull();
    if (bgs10bl === null) return;   // uncovered by the table: nothing to order
    expect(bgs10bl).toBeGreaterThan(psa10!);
  });

  // CF-GRADE-MONOTONICITY-IS-NOT-AN-INVARIANT (Drew): observe the
  // inversion, never clamp it.
  //
  // This test used to assert regular BGS 10 sits within ~30% of PSA 10.
  // On the regenerated table (C-4/H-10, our own pool) BGS 10 is
  // CONSISTENTLY ABOVE PSA 10 at every band — 7.17 vs 6.80 at $10, 3.48
  // vs 2.32 at $50, 2.56 vs 1.73 at $500. That is not drift around a
  // convention, it is a stable ordering in the data, and the BGS 10
  // population is genuinely different (a BGS 10 with all-10 subgrades is
  // a Black Label; the rest still grade tighter than the PSA 10 pool).
  //
  // So the pin becomes: both resolve empirically, and we RECORD the
  // relationship rather than enforcing a hobby convention over the pool.
  it("BGS 10 and PSA 10 both resolve empirically (ordering is observed, not enforced)", () => {
    const psa10 = getGraderPremium("PSA", "10", 50);
    const bgs10 = getGraderPremium("BGS", "10", 50);
    expect(psa10).not.toBeNull();
    expect(bgs10).not.toBeNull();
    expect(psa10!).toBeGreaterThan(0);
    expect(bgs10!).toBeGreaterThan(0);
  });

  it("PSA 10 > SGC 10 (SGC discount vs PSA)", () => {
    const psa10 = getGraderPremium("PSA", "10", 50)!;
    const sgc10 = getGraderPremium("SGC", "10", 50)!;
    expect(psa10).toBeGreaterThan(sgc10);
  });

  // Same ruling as above. The convention says SGC 10 > CGC 10; the
  // regenerated pool says the opposite at every band (1.48 vs 1.75 at $50,
  // 0.98 vs 1.78 at $500). We do not clamp the pool to the convention —
  // we pin that both resolve, and leave the ordering to the data.
  it("SGC 10 and CGC 10 both resolve empirically (ordering is observed, not enforced)", () => {
    const sgc10 = getGraderPremium("SGC", "10", 50);
    const cgc10 = getGraderPremium("CGC", "10", 50);
    expect(sgc10).not.toBeNull();
    expect(cgc10).not.toBeNull();
    expect(sgc10!).toBeGreaterThan(0);
    expect(cgc10!).toBeGreaterThan(0);
  });

  // The surviving cross-grader invariant, and the only one the data
  // actually supports at every band: PSA 10 outranks SGC 10.
  //
  // The old version of this test also asserted BL > PSA and SGC > CGC.
  // BGS "10 Black Label" has NO empirical cell at all now that the matrix
  // is gone (it returns null at every band — its 12.0/9.0/7.0/5.5 row WAS
  // the matrix), and SGC > CGC is contradicted by the pool. Asserting
  // either would be re-importing a hand-curated ordering through the
  // test suite, which is the thing this PR removes.
  it("PSA 10 > SGC 10 at every band (the ordering the pool does support)", () => {
    for (const raw of [10, 35, 75, 500]) {
      const psa10 = getGraderPremium("PSA", "10", raw);
      const sgc10 = getGraderPremium("SGC", "10", raw);
      expect(psa10, `raw=${raw}`).not.toBeNull();
      expect(sgc10, `raw=${raw}`).not.toBeNull();
      expect(psa10!, `raw=${raw}`).toBeGreaterThan(sgc10!);
    }
  });

  // BGS Black Label is now UNCOVERED, and that is the correct state: its
  // only source was the deleted matrix. It must refuse rather than invent.
  //
  // MUTATION: restore a Black Label constant anywhere and this goes red.
  it("BGS 10 Black Label refuses — its only source was the removed matrix", () => {
    for (const raw of [10, 35, 75, 500]) {
      expect(getGraderPremium("BGS", "10 Black Label", raw), `raw=${raw}`).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. MONOTONICITY — multiplier DECREASES as raw price increases (PSA 10 & 9)
// ─────────────────────────────────────────────────────────────────────────────

describe("getGraderPremium — monotonic decrease in multiplier as raw rises", () => {
  // Article's central finding: as raw price rises, PSA 10 premium SHRINKS
  // (4.9 → 3.6 → 2.8 → 2.2). PSA 9 even more aggressively (2.56 → 1.5 → 0.95 → 0.85).
  it("PSA 10 multiplier strictly decreases across the four tier breakpoints", () => {
    const m10_low = getGraderPremium("PSA", "10", 10)!;
    const m10_mid = getGraderPremium("PSA", "10", 35)!;
    const m10_upper = getGraderPremium("PSA", "10", 75)!;
    const m10_top = getGraderPremium("PSA", "10", 500)!;
    expect(m10_low).toBeGreaterThan(m10_mid);
    expect(m10_mid).toBeGreaterThan(m10_upper);
    expect(m10_upper).toBeGreaterThan(m10_top);
  });

  it("PSA 9 multiplier strictly decreases at tested breakpoints (empirical calibration)", () => {
    // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM: post-ladder empirical
    // PSA 9 at (10, 35, 75, 500) → (~3.78, ~1.5, ~1.32, ~1.16). Still
    // monotonically decreasing across those points. The "sub-1.0
    // eventually" invariant from the article does NOT hold in the
    // empirical data — PSA 9 at $500-999 raw is 1.16× (n=large), a
    // slight premium not a discount.
    const m9_low = getGraderPremium("PSA", "9", 10)!;
    const m9_mid = getGraderPremium("PSA", "9", 35)!;
    const m9_upper = getGraderPremium("PSA", "9", 75)!;
    const m9_top = getGraderPremium("PSA", "9", 500)!;
    expect(m9_low).toBeGreaterThan(m9_mid);
    expect(m9_mid).toBeGreaterThan(m9_upper);
    expect(m9_upper).toBeGreaterThan(m9_top);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. TELEMETRY — logGraderRatioObserved emits the right event shape
// ─────────────────────────────────────────────────────────────────────────────

describe("logGraderRatioObserved — telemetry for per-player calibration", () => {
  let capturedLogs: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    capturedLogs = [];
    console.log = (...args: any[]) => {
      capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("emits a graded_ratio_observed event with computed ratio + tier", () => {
    logGraderRatioObserved({
      source: "test",
      player: "Eric Hartman",
      cardId: "test-card-id",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 50,
      gradedValue: 150,
    });
    expect(capturedLogs).toHaveLength(1);
    const event = JSON.parse(capturedLogs[0]!);
    expect(event.event).toBe("graded_ratio_observed");
    expect(event.player).toBe("Eric Hartman");
    expect(event.gradingCompany).toBe("PSA");
    expect(event.grade).toBe("10");
    expect(event.ratio).toBe(3); // 150 / 50
    expect(event.tier).toBe("50-100");
  });

  it("skips when rawAnchor or gradedValue is zero/negative (no spurious ratios)", () => {
    logGraderRatioObserved({
      source: "test",
      player: "Test",
      cardId: "test",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 0,
      gradedValue: 100,
    });
    logGraderRatioObserved({
      source: "test",
      player: "Test",
      cardId: "test",
      gradingCompany: "PSA",
      grade: "10",
      rawAnchor: 50,
      gradedValue: -10,
    });
    expect(capturedLogs).toHaveLength(0);
  });
});

// Import the lifecycle hooks vitest needs.
import { beforeEach, afterEach } from "vitest";
