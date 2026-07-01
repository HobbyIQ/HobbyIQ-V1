/**
 * CF-MERCY-BASE-AUTO-NO-PARALLEL (2026-07-01) — pin pickBaseAuto.
 *
 * Real prod evidence: "2026 Bowman Jared Jones Base Auto" query
 * returned catalog-miss because mercy fallback refused to fire
 * without an explicit parallel. CH catalog has the card:
 *   card_id: 1778541821568x179022789686269950
 *   subset: "Chrome Prospects Autographs"
 *   variant: "Base"
 *   number: "CPA-JJ"
 *
 * pickBaseAuto filters by subset contains "auto" AND variant === "base"
 * (case-insensitive). Returns the card when exactly one matches.
 */

import { describe, it, expect } from "vitest";
import { pickBaseAuto } from "../src/services/compiq/cardsight.router";
import type { CardHedgeCard } from "../src/services/compiq/cardhedge.client";

// Anchored on the actual CH result cohort for "Jared Jones" 2026-07-01.
const JARED_JONES_COHORT: CardHedgeCard[] = [
  { card_id: "target-cpa-jj", subset: "Chrome Prospects Autographs", variant: "Base", set: "2026 Bowman Baseball", number: "CPA-JJ" },
  { card_id: "cp-base", subset: "Chrome Prospects", variant: "Base", set: "2026 Bowman Baseball", number: "CP-100" },
  { card_id: "prospects-base", subset: "Prospects", variant: "Base", set: "2026 Bowman Baseball", number: "BP-100" },
  { card_id: "pristine-auto", subset: "Pristine Autographs", variant: "Base", set: "2025 Topps Pristine Baseball", number: "PA-JJO" },
  { card_id: "topps-star-auto", subset: "Baseball Stars Autographs", variant: "Base", set: "2026 Topps Baseball", number: "BSA2-JJ" },
];

describe("pickBaseAuto", () => {
  it("returns null when zero cards match (no auto subset)", () => {
    const cohort: CardHedgeCard[] = [
      { card_id: "a", subset: "Base Set", variant: "Base" },
      { card_id: "b", subset: "Prospects", variant: "Base" },
    ];
    expect(pickBaseAuto(cohort)).toBeNull();
  });

  it("returns null when multiple auto-base cards match (ambiguous — different sets)", () => {
    // Multiple sets/subsets can have 'Auto' + variant='Base' — refuse
    // to guess which one the user wants without a parallel or year gate.
    expect(pickBaseAuto(JARED_JONES_COHORT)).toBeNull();
  });

  it("returns the base auto when filter narrows to exactly one match", () => {
    // Same cohort filtered to Bowman-only would produce a unique match.
    const bowmanOnly = JARED_JONES_COHORT.filter((c) => (c.set ?? "").includes("Bowman Baseball"));
    // 2026 Bowman has 3 entries: CPA-JJ (auto), CP (base), Prospects (base)
    // Only CPA-JJ has "auto" in subset.
    expect(pickBaseAuto(bowmanOnly)?.card_id).toBe("target-cpa-jj");
  });

  it("is case-insensitive on subset (Auto/auto/AUTO all match)", () => {
    const cohort: CardHedgeCard[] = [
      { card_id: "upper", subset: "PROSPECTS AUTOGRAPHS", variant: "Base" },
    ];
    expect(pickBaseAuto(cohort)?.card_id).toBe("upper");
  });

  it("is case-insensitive on variant (Base/base/BASE all match)", () => {
    const cohort: CardHedgeCard[] = [
      { card_id: "lower", subset: "Prospects Autographs", variant: "base" },
    ];
    expect(pickBaseAuto(cohort)?.card_id).toBe("lower");
  });

  it("rejects when variant is not exactly 'base' — e.g., 'base auto' is not a base variant", () => {
    // Belt-and-suspenders: variant "Base Auto" as a compound token would
    // slip through a substring check but is not a Base variant.
    const cohort: CardHedgeCard[] = [
      { card_id: "compound", subset: "Prospects Autographs", variant: "Base Auto" },
    ];
    expect(pickBaseAuto(cohort)).toBeNull();
  });

  it("rejects auto cards with COLOR variants (Purple/Blue/etc)", () => {
    // The user specified NO color — auto variants with a color are
    // sibling parallels, not the base auto they asked for.
    const cohort: CardHedgeCard[] = [
      { card_id: "purple", subset: "Chrome Prospects Autographs", variant: "Purple Refractor" },
      { card_id: "blue-xf", subset: "Chrome Prospects Autographs", variant: "Blue X-Fractor" },
      { card_id: "target", subset: "Chrome Prospects Autographs", variant: "Base" },
    ];
    expect(pickBaseAuto(cohort)?.card_id).toBe("target");
  });

  it("handles missing subset/variant gracefully (both required to be present)", () => {
    const cohort: CardHedgeCard[] = [
      { card_id: "no-subset", variant: "Base" }, // no subset
      { card_id: "no-variant", subset: "Prospects Autographs" }, // no variant
    ];
    expect(pickBaseAuto(cohort)).toBeNull();
  });

  it("empty cohort → null", () => {
    expect(pickBaseAuto([])).toBeNull();
  });
});
