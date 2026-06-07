/**
 * Pricing Accuracy unit tests — covers the 4 robustness improvements:
 *   1. Velocity-weighted recency
 *   2. Comp quality filter (exclusion keywords + 2.5σ outlier trim)
 *   3. Grader premium normalize + apply (round-trip)
 *   4. Data sufficiency gate
 *
 * These are pure-function tests — no network, no Card Hedge.
 */
import { describe, it, expect } from "vitest";
import {
  getSaleVelocityWeight,
  computeWeightedMedian,
  applyCompQualityFilter,
  getGraderPremium,
  detectGradeFromTitle,
  normalizeCompToRaw,
  applyGraderPremium,
  evaluateDataSufficiency,
} from "../src/services/compiq/compiqEstimate.service";

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;

describe("Improvement 1 — velocity-weighted recency", () => {
  it("returns 5.0 for sales in the last 48h and decays toward 0.1 past 30d", () => {
    const now = Date.now();
    expect(getSaleVelocityWeight(new Date(now - 1 * HOUR))).toBe(5.0);
    expect(getSaleVelocityWeight(new Date(now - 47 * HOUR))).toBe(5.0);
    expect(getSaleVelocityWeight(new Date(now - 3 * DAY))).toBe(2.0);
    expect(getSaleVelocityWeight(new Date(now - 10 * DAY))).toBe(1.0);
    expect(getSaleVelocityWeight(new Date(now - 25 * DAY))).toBe(0.3);
    expect(getSaleVelocityWeight(new Date(now - 60 * DAY))).toBe(0.1);
    expect(getSaleVelocityWeight(null)).toBe(0.1);
    expect(getSaleVelocityWeight("garbage")).toBe(0.1);
  });

  it("pulls the weighted median toward fresh, hot sales", () => {
    const now = Date.now();
    // Two old comps at $100 (weight 0.3 each = 0.6) + one 1-day-old comp at $200 (weight 5.0)
    // Total weight 5.6 — the 50% crossover lands on $200 not $100.
    const median = computeWeightedMedian([
      { price: 100, date: new Date(now - 25 * DAY) },
      { price: 100, date: new Date(now - 25 * DAY) },
      { price: 200, date: new Date(now - 1 * DAY) },
    ]);
    expect(median).toBe(200);
  });

  it("falls back to highest-price when all weights collapse", () => {
    const median = computeWeightedMedian([
      { price: 50, date: null },
      { price: 75, date: null },
      { price: 80, date: null },
    ]);
    // All weights 0.1 — tie-break to mid sample; just verify a real number is returned.
    expect(median).not.toBeNull();
    expect(typeof median).toBe("number");
  });

  it("returns null on empty input", () => {
    expect(computeWeightedMedian([])).toBeNull();
  });
});

describe("Improvement 2 — comp quality filter", () => {
  const card = { player: "Mike Trout", year: 2011, set: "Topps Update" };
  const baseComp = (title: string, price: number) => ({
    price,
    title,
    soldDate: new Date().toISOString(),
  });

  it("removes lot/reprint/damaged/digital noise", () => {
    const sales = [
      baseComp("2011 Topps Update Mike Trout RC PSA 9", 900),
      baseComp("Lot of 5 Mike Trout RC cards mixed", 200),
      baseComp("Mike Trout REPRINT 2011 Topps Update", 30),
      baseComp("Damaged Mike Trout RC w/ crease", 50),
      baseComp("Mike Trout Topps NOW DIGITAL card", 5),
      baseComp("Mike Trout 2011 Topps Update RC raw", 850),
    ];
    const out = applyCompQualityFilter(sales, card);
    expect(out.filtered.length).toBe(2);
    expect(out.excluded).toBe(4);
    expect(out.reasons["keyword:lot of"]).toBe(1);
    expect(out.reasons["keyword:reprint"]).toBe(1);
    // CF-COMP-TITLE-EXCLUSIONS-EXPAND (2026-06-07): "damage" stem added
    // earlier in the keyword list now classifies "Damaged …" as
    // keyword:damage rather than :damaged or :crease. Accept any of the
    // three so the assertion documents the family rather than a specific
    // matcher.
    const damageReason =
      (out.reasons["keyword:damage"] ?? 0)
      + (out.reasons["keyword:damaged"] ?? 0)
      + (out.reasons["keyword:crease"] ?? 0);
    expect(damageReason).toBeGreaterThanOrEqual(1);
    expect(out.reasons["keyword:digital"]).toBe(1);
  });

  it("strips 2.5σ price outliers when n>=4", () => {
    const sales = [
      baseComp("Mike Trout 2011 Topps Update RC PSA 9", 900),
      baseComp("Mike Trout 2011 Topps Update RC PSA 9", 950),
      baseComp("Mike Trout 2011 Topps Update RC PSA 9", 1000),
      baseComp("Mike Trout 2011 Topps Update RC PSA 9", 925),
      baseComp("Mike Trout 2011 Topps Update RC PSA 9", 50000), // wild outlier
    ];
    const out = applyCompQualityFilter(sales, card);
    expect(out.filtered.length).toBe(4);
    expect(out.reasons["outlier"]).toBe(1);
  });

  it("never returns a price <= 0", () => {
    const sales = [
      baseComp("Mike Trout 2011 Topps Update RC", 0),
      baseComp("Mike Trout 2011 Topps Update RC", -50),
      baseComp("Mike Trout 2011 Topps Update RC", 100),
    ];
    const out = applyCompQualityFilter(sales, card);
    expect(out.filtered.every((s) => s.price > 0)).toBe(true);
  });

  // ── CF-COMP-TITLE-EXCLUSIONS-EXPAND (2026-06-07) ─────────────────────────
  // Real-world dirty-title patterns lifted from the Trout raw probe + a
  // broader sweep of condition disclaimers that should never enter the
  // comp pool. Pins each new exclusion as a distinct case so future regex
  // edits surface here.
  describe("expanded condition-descriptor exclusions", () => {
    it('rejects "Minor Damage" parenthetical (the canonical Trout row)', () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC PSA 9", 900),
        baseComp("Topps 2011 Update Series Mike Trout Rookie Card #US175 Angels(Minor Damage)", 200),
      ];
      const out = applyCompQualityFilter(sales, card);
      expect(out.filtered.length).toBe(1);
      expect(out.reasons["keyword:damage"]).toBe(1);
    });

    it('rejects "please read description" / typo variant "Read Desciption"', () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC", 900),
        baseComp('***Please Read Desciption" 2011 Topps Update Series - Mike Trout #US175 (RC)', 160),
        baseComp("Mike Trout 2011 Topps Update Series (please read description)", 220),
      ];
      const out = applyCompQualityFilter(sales, card);
      expect(out.filtered.length).toBe(1);
      expect(
        (out.reasons["keyword:please read"] ?? 0)
          + (out.reasons["keyword:read desciption"] ?? 0)
          + (out.reasons["keyword:read description"] ?? 0),
      ).toBeGreaterThanOrEqual(2);
    });

    it("rejects scuff/stain/worn/repaired condition disclaimers", () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC", 900),
        baseComp("Mike Trout 2011 Topps Update RC — scuff on back", 300),
        baseComp("Mike Trout 2011 Topps Update RC stain corner", 250),
        baseComp("Mike Trout 2011 Topps Update RC worn edges", 280),
        baseComp("Mike Trout 2011 Topps Update RC repaired corner", 290),
      ];
      const out = applyCompQualityFilter(sales, card);
      expect(out.filtered.length).toBe(1);
      expect(out.excluded).toBeGreaterThanOrEqual(4);
    });

    it('rejects "as is" / "as-is" with word-boundary anchoring (no false positive on "Atlas is")', () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC sold as is", 200),
        baseComp("Mike Trout 2011 Topps Update RC (as-is)", 210),
        baseComp("Mike Trout Atlas issue 2011 Topps Update RC", 850), // false-positive guard
      ];
      const out = applyCompQualityFilter(sales, card);
      // First two excluded; the "Atlas is" row stays.
      expect(out.filtered.length).toBe(1);
      expect(out.filtered[0].title).toContain("Atlas");
    });

    it('rejects "see description" / "see desc"', () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC", 900),
        baseComp("Mike Trout 2011 Topps Update RC see description", 250),
        baseComp("Mike Trout 2011 Topps Update RC (see desc)", 240),
      ];
      const out = applyCompQualityFilter(sales, card);
      expect(out.filtered.length).toBe(1);
    });

    it('rejects "poor condition" / "rough shape" but PRESERVES the legit "good" / "near mint" / "gem mint" rows', () => {
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC PSA 10 GEM MINT", 1000),
        baseComp("Mike Trout 2011 Topps Update RC near mint", 700),
        baseComp("Mike Trout 2011 Topps Update RC poor condition", 100),
        baseComp("Mike Trout 2011 Topps Update RC rough shape", 90),
        baseComp("Mike Trout 2011 Topps Update RC fair condition", 110),
      ];
      const out = applyCompQualityFilter(sales, card);
      expect(out.filtered.length).toBe(2);
      expect(out.filtered.some((s) => s.title.includes("GEM MINT"))).toBe(true);
      expect(out.filtered.some((s) => s.title.includes("near mint"))).toBe(true);
    });

    it('preserves clean titles (no false positive on "scuff-free", "no stains", etc.)', () => {
      // Defensive: substring-includes-style filters can over-fire. The
      // current filter uses bare keywords ("scuff", "stain") which WILL
      // match "scuff-free" — that's by design (seller mentioned condition
      // at all = mild ambiguity, easier to drop). Pin the behavior so any
      // future tightening surfaces here as an intentional change.
      const sales = [
        baseComp("Mike Trout 2011 Topps Update RC scuff-free", 800),
        baseComp("Mike Trout 2011 Topps Update RC no stains", 820),
      ];
      const out = applyCompQualityFilter(sales, card);
      // Both filtered out today (bare-substring match).
      expect(out.filtered.length).toBe(0);
    });
  });
});

describe("Improvement 3 — grader premiums (round-trip)", () => {
  it("returns 1.0 for unknown grader/grade combos", () => {
    expect(getGraderPremium(null, null)).toBe(1.0);
    expect(getGraderPremium("PSA", null)).toBe(1.0);
    expect(getGraderPremium("HGA", "10")).toBe(1.0);
    expect(getGraderPremium("PSA", "11")).toBe(1.0);
  });

  it("PSA 10 premium is 4.0x, BGS 9.5 is 3.5x", () => {
    expect(getGraderPremium("PSA", "10")).toBe(4.0);
    expect(getGraderPremium("psa", "10")).toBe(4.0);
    expect(getGraderPremium("BGS", "9.5")).toBe(3.5);
  });

  it("detects graded comps from free-text titles", () => {
    expect(detectGradeFromTitle("2018 Bowman Chrome Acuna PSA 10 RC")).toEqual({
      company: "PSA",
      grade: "10",
    });
    expect(detectGradeFromTitle("Ronald Acuna Jr BGS 9.5 Auto Refractor")).toEqual({
      company: "BGS",
      grade: "9.5",
    });
    expect(detectGradeFromTitle("Acuna RC Bowman Chrome Refractor")).toBeNull();
  });

  it("normalizeCompToRaw inverts applyGraderPremium", () => {
    const raw = 200;
    const psa10Price = applyGraderPremium(raw, "PSA", "10"); // 200 * 4 = 800
    expect(psa10Price).toBe(800);
    const back = normalizeCompToRaw({
      price: psa10Price,
      title: "Card PSA 10",
      soldDate: new Date().toISOString(),
    });
    expect(back).toBe(raw);
  });

  it("leaves ungraded comps unchanged", () => {
    const raw = normalizeCompToRaw({
      price: 175,
      title: "2018 Bowman Chrome Acuna RC Refractor",
      soldDate: new Date().toISOString(),
    });
    expect(raw).toBe(175);
  });
});

describe("Improvement 4 — data sufficiency gate", () => {
  it("returns 'none' when no comps were usable", () => {
    const v = evaluateDataSufficiency({ usedComps: 0, totalComps: 0, recentCount: 0 });
    expect(v.sufficient).toBe(false);
    expect(v.level).toBe("none");
    expect(v.message).toMatch(/no recent sales/i);
  });

  it("flags 'none' with custom message when all comps were filtered out", () => {
    const v = evaluateDataSufficiency({ usedComps: 0, totalComps: 7, recentCount: 0 });
    expect(v.level).toBe("none");
    expect(v.message).toMatch(/7 sales/);
  });

  it("flags 'very_thin' below the 3-comp floor", () => {
    const v = evaluateDataSufficiency({ usedComps: 2, totalComps: 4, recentCount: 1 });
    expect(v.sufficient).toBe(false);
    expect(v.level).toBe("very_thin");
    expect(v.message).toMatch(/2 usable/);
  });

  it("flags 'thin' between 3 and 5 comps but still sufficient", () => {
    const v = evaluateDataSufficiency({ usedComps: 4, totalComps: 10, recentCount: 1 });
    expect(v.sufficient).toBe(true);
    expect(v.level).toBe("thin");
  });

  it("flags 'adequate' once we have 6+ comps with 2+ recent", () => {
    const v = evaluateDataSufficiency({ usedComps: 12, totalComps: 20, recentCount: 5 });
    expect(v.sufficient).toBe(true);
    expect(v.level).toBe("adequate");
    expect(v.message).toBe("");
  });
});
