// CF-CUSTOM-TIERS (Drew, 2026-08-17). Pins the rule semantics — the parts a
// plausible-looking change would quietly invert.

import { describe, it, expect } from "vitest";
import {
  assignTier, tierMatches, validateTiers, defaultTiers, UNASSIGNED_TIER_ID,
  type CustomTier, type TierFacts,
} from "../src/services/portfolioiq/portfolioCustomTiers.js";

function facts(over: Partial<TierFacts> = {}): TierFacts {
  return {
    printRun: null, year: 2024, graded: false, isAuto: false,
    product: "topps chrome base", name: "test player", value: 100, ...over,
  };
}

describe("rule evaluation", () => {
  it("ANDs every predicate in a rule", () => {
    const tier: CustomTier = {
      id: "t", name: "T", targetShare: 1,
      rules: [{ printRunMax: 25, graded: true }],
    };
    expect(tierMatches(tier, facts({ printRun: 10, graded: true }))).toBe(true);
    expect(tierMatches(tier, facts({ printRun: 10, graded: false }))).toBe(false);
    expect(tierMatches(tier, facts({ printRun: 50, graded: true }))).toBe(false);
  });

  it("treats an EMPTY rule set as match-everything, so a catch-all is trivial", () => {
    const tier: CustomTier = { id: "any", name: "Any", targetShare: 1, rules: [] };
    expect(tierMatches(tier, facts())).toBe(true);
    expect(tierMatches(tier, facts({ printRun: 1, year: 1955 }))).toBe(true);
  });

  /**
   * The load-bearing negative. Print run is parsed from card text and is
   * unknown far more often than people expect. If unknown satisfied a
   * printRunMax bound, every tersely described card would land in a scarcity
   * tier it may not belong in — the direction that flatters a portfolio.
   */
  it("never lets an UNKNOWN print run satisfy a print-run bound", () => {
    const scarce: CustomTier = {
      id: "s", name: "Scarce", targetShare: 1, rules: [{ printRunMax: 99 }],
    };
    expect(tierMatches(scarce, facts({ printRun: null }))).toBe(false);
    expect(tierMatches(scarce, facts({ printRun: 99 }))).toBe(true);
  });

  it("matches product and name case-insensitively", () => {
    const t: CustomTier = {
      id: "b", name: "Bowman", targetShare: 1, rules: [{ productContains: "BOWMAN" }],
    };
    expect(tierMatches(t, facts({ product: "2024 bowman chrome prospects" }))).toBe(true);
    expect(tierMatches(t, facts({ product: "topps chrome" }))).toBe(false);
  });
});

describe("assignment is first-match-wins, in order", () => {
  // Buckets always overlap in practice — a 1955 PSA 4 is both "vintage" and
  // "graded" — so the ordered list IS the user's priority statement.
  const tiers: CustomTier[] = [
    { id: "vintage", name: "Vintage", targetShare: 0.5, rules: [{ yearMax: 1979 }] },
    { id: "graded", name: "Graded", targetShare: 0.5, rules: [{ graded: true }] },
  ];

  it("takes the earlier tier when both match", () => {
    expect(assignTier(tiers, facts({ year: 1955, graded: true }))).toBe("vintage");
  });

  it("falls through to the later tier when the first does not match", () => {
    expect(assignTier(tiers, facts({ year: 2024, graded: true }))).toBe("graded");
  });

  it("returns UNASSIGNED rather than force-fitting an unmatched card", () => {
    // Visibly unassigned beats silently absorbed: the user needs to SEE what
    // their rules missed.
    expect(assignTier(tiers, facts({ year: 2024, graded: false }))).toBe(UNASSIGNED_TIER_ID);
  });
});

describe("validation rejects rather than repairs", () => {
  const ok = (targets: number[]) =>
    targets.map((t, i) => ({ id: `t${i}`, name: `T${i}`, targetShare: t, rules: [] }));

  it("accepts a well-formed set totalling 100%", () => {
    const r = validateTiers(ok([0.4, 0.3, 0.2, 0.1]));
    expect("tiers" in r).toBe(true);
  });

  it("rejects targets that do not total 100% instead of renormalising", () => {
    // Silently rescaling would hand the user a mix they never chose.
    const r = validateTiers(ok([0.5, 0.2]));
    expect("error" in r && r.error).toMatch(/100%/);
  });

  it("tolerates ordinary rounding from a percentage UI", () => {
    const r = validateTiers(ok([0.33, 0.33, 0.34]));
    expect("tiers" in r).toBe(true);
  });

  it("rejects duplicate ids, empty names, and the reserved id", () => {
    expect("error" in validateTiers([
      { id: "a", name: "A", targetShare: 0.5, rules: [] },
      { id: "a", name: "B", targetShare: 0.5, rules: [] },
    ])).toBe(true);
    expect("error" in validateTiers([{ id: "a", name: "", targetShare: 1, rules: [] }])).toBe(true);
    expect("error" in validateTiers([
      { id: UNASSIGNED_TIER_ID, name: "X", targetShare: 1, rules: [] },
    ])).toBe(true);
  });

  it("rejects an empty or non-array payload", () => {
    expect("error" in validateTiers([])).toBe(true);
    expect("error" in validateTiers({} as unknown)).toBe(true);
  });
});

describe("the shipped defaults", () => {
  it("are themselves valid under the same validator a user's set faces", () => {
    // No privileged built-in path: "reset to defaults" must land on something
    // the user could have written and can then edit.
    const r = validateTiers(defaultTiers());
    expect("tiers" in r).toBe(true);
  });

  it("end with a catch-all so nothing is unassigned by default", () => {
    const tiers = defaultTiers();
    expect(tiers[tiers.length - 1].rules).toEqual([]);
    expect(assignTier(tiers, facts({ printRun: null, year: 2024, graded: false })))
      .not.toBe(UNASSIGNED_TIER_ID);
  });
});
