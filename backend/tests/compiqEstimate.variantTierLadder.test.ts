// CF-VARIANT-FILTER-LOOSENING — unit coverage for the tier ladder helper +
// per-tier constants exposed from compiqEstimate.service. Covers tier
// transitions (T0→T1→T2→T3→fallback), the Q1/Q2/Q4 invariants, and the
// rejection-reason classification per tier.
//
// Design lock reference: docs/phase0/variant_filter_loosening_design.md
//
// Scope: this file isolates the ladder logic (no Cardsight mocks, no HTTP
// pipeline). End-to-end behavior (verdict text override + confidence cap
// composition on the /estimate response) is covered by
// compiqEstimate.variantTierLadder.integration.test.ts.

import { describe, it, expect } from "vitest";

import {
  runVariantTierLadder,
  VARIANT_TIERS,
  VARIANT_TIER_CAP,
  VARIANT_TIER_VERDICT,
  VARIANT_TIER_MIN_COMPS,
  type VariantStrictness,
} from "../src/services/compiq/compiqEstimate.service.js";

import { parseCardQuery, type ParsedCardQuery } from "../src/services/compiq/cardQueryParser.js";

function p(over: Partial<ParsedCardQuery>): ParsedCardQuery {
  return {
    playerName: null,
    year: null,
    brand: null,
    set: null,
    parallel: null,
    isAuto: false,
    isPatch: false,
    isRookie: false,
    printRun: null,
    cardNumber: null,
    grade: null,
    gradingCompany: null,
    confidence: 1,
    rawQuery: "",
    ...over,
  };
}

function c(title: string): { title: string } {
  return { title };
}

describe("CF-VARIANT-FILTER-LOOSENING — tier constants (Q1/Q2 locks)", () => {
  it("tier ladder order is T0 → T1 → T2 → T3 (loosening monotonic)", () => {
    expect(VARIANT_TIERS).toEqual(["T0", "T1", "T2", "T3"]);
  });

  it("confidence caps match Q1 lock: T0=95, T1=80, T2=65, T3=55", () => {
    expect(VARIANT_TIER_CAP.T0).toBe(95);
    expect(VARIANT_TIER_CAP.T1).toBe(80);
    expect(VARIANT_TIER_CAP.T2).toBe(65);
    expect(VARIANT_TIER_CAP.T3).toBe(55);
  });

  it("confidence caps are strictly decreasing T0 > T1 > T2 > T3", () => {
    expect(VARIANT_TIER_CAP.T0).toBeGreaterThan(VARIANT_TIER_CAP.T1);
    expect(VARIANT_TIER_CAP.T1).toBeGreaterThan(VARIANT_TIER_CAP.T2);
    expect(VARIANT_TIER_CAP.T2).toBeGreaterThan(VARIANT_TIER_CAP.T3);
  });

  it("verdict text matches Q2 lock — T0 null, T1/T2/T3 fixed strings", () => {
    expect(VARIANT_TIER_VERDICT.T0).toBeNull();
    expect(VARIANT_TIER_VERDICT.T1).toBe("Variant approximation — parallel unverified");
    expect(VARIANT_TIER_VERDICT.T2).toBe("Estimate from broader pool — variant unverified");
    expect(VARIANT_TIER_VERDICT.T3).toBe("Pool estimate — verify variant before listing");
  });

  it("min-comp threshold is 3 (matches existing soft-filter pattern)", () => {
    expect(VARIANT_TIER_MIN_COMPS).toBe(3);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — runVariantTierLadder T0 happy path", () => {
  it("picks T0 when strict filter yields ≥3 matched comps", () => {
    // Strict-T0 should accept 3 plain "Blue Auto" comps for an auto+Blue request.
    const parsed = p({ parallel: "blue", isAuto: true, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Blue Auto"),
      c("2024 Bowman Chrome Bonemer Blue Auto /150"),
      c("2024 Bowman Chrome Bonemer Blue Autograph"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T0");
    expect(result.variantFiltered.length).toBe(3);
    expect(result.everythingFilteredOut).toBe(false);
    expect(result.variantExcludedCount).toBe(0);
  });

  it("tierLadderTrace shows T0 count even when T0 wins", () => {
    const parsed = p({ parallel: "blue", isAuto: true, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Blue Auto"),
      c("2024 Bowman Chrome Bonemer Blue Auto /150"),
      c("2024 Bowman Chrome Bonemer Blue Autograph"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.tierLadderTrace.T0).toBe(3);
    // Loop breaks at T0, so T1/T2/T3 untouched (zeroes from init).
    expect(result.tierLadderTrace.T1).toBe(0);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — T0 → T1 transition (drop parallel)", () => {
  it("picks T1 when strict parallel filter rejects everything but auto+player match", () => {
    // Request: Blue Auto. Pool: Red/Green/Gold auto (no Blue but all auto).
    // T0 rejects everything as parallel_mismatch.
    // T1 accepts (drops parallel) → all 3 surviving.
    const parsed = p({ parallel: "blue", isAuto: true, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Red Auto"),
      c("2024 Bowman Chrome Bonemer Green Auto"),
      c("2024 Bowman Chrome Bonemer Gold Auto"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T1");
    expect(result.variantFiltered.length).toBe(3);
    expect(result.tierLadderTrace.T0).toBe(0);
    expect(result.tierLadderTrace.T1).toBe(3);
  });

  it("T1 surfaces parallel_mismatch in exclusion reasons (no longer fatal but tracked)", () => {
    // Sky Blue qualifier-mismatch is also a parallel_* rejection — T1 accepts it.
    const parsed = p({ parallel: "blue", isAuto: false, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Sky Blue"),
      c("2024 Bowman Chrome Bonemer Sky Blue /99"),
      c("2024 Bowman Chrome Bonemer Sky Blue /50"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T1");
    expect(result.variantFiltered.length).toBe(3);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — T1 → T2 transition (drop comp_missing_auto)", () => {
  it("picks T2 when parallel relaxation isn't enough but dropping the auto requirement is", () => {
    // Request: Gold Auto. Pool: only non-auto comps for the same prospect.
    // T0: parallel_mismatch (no Gold) AND comp_missing_auto → 0.
    // T1: drops parallel_mismatch → still comp_missing_auto → 0.
    // T2: drops both → 3 surviving.
    const parsed = p({ parallel: "gold", isAuto: true, playerName: "Wood" });
    const comps = [
      c("2024 Bowman Draft Wood Refractor"),
      c("2024 Bowman Draft Wood Blue"),
      c("2024 Bowman Draft Wood Base"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T2");
    expect(result.variantFiltered.length).toBe(3);
    expect(result.tierLadderTrace.T1).toBe(0);
    expect(result.tierLadderTrace.T2).toBe(3);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — T2 → T3 transition (drop print_run_mismatch)", () => {
  it("picks T3 when only print-run mismatch remains", () => {
    // Request: /150 numbered, isAuto true. Pool: matching-player auto comps
    // but at different print runs (/99, /50, /25).
    // T0/T1/T2 keep print_run_mismatch as hard reject → all rejected.
    // T3 drops it → 3 surviving.
    // (isAuto=true required — otherwise the auto-bearing comp titles would
    // hit comp_has_unwanted_auto, which is the Q4 hard-reject invariant.)
    const parsed = p({ printRun: 150, isAuto: true, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Auto /99"),
      c("2024 Bowman Chrome Bonemer Auto /50"),
      c("2024 Bowman Chrome Bonemer Auto /25"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T3");
    expect(result.variantFiltered.length).toBe(3);
    expect(result.tierLadderTrace.T2).toBe(0);
    expect(result.tierLadderTrace.T3).toBe(3);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — T3 → fallback (everythingFilteredOut)", () => {
  it("flags everythingFilteredOut when even T3 yields <3 surviving comps", () => {
    // Wrong player entirely — every comp fails player_name_missing_from_comp,
    // which is HARD REJECT at every tier (invariant).
    const parsed = p({ playerName: "Bonemer", isAuto: true });
    const comps = [
      c("2024 Bowman Chrome Trout Auto"),
      c("2024 Bowman Chrome Trout Auto"),
      c("2024 Bowman Chrome Trout Auto"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T3");
    expect(result.variantFiltered.length).toBe(0);
    expect(result.everythingFilteredOut).toBe(true);
  });

  it("does NOT flag everythingFilteredOut when input pool was empty", () => {
    // Distinguish "no comps fetched" from "comps rejected" — the empty-input
    // case is handled by the thin-data branch downstream, not the variant guard.
    const parsed = p({ parallel: "blue", isAuto: true });
    const result = runVariantTierLadder([], parsed);
    expect(result.variantFiltered.length).toBe(0);
    expect(result.everythingFilteredOut).toBe(false);
  });

  it("does NOT flag everythingFilteredOut when no variant attributes were requested", () => {
    // No isAuto, no parallel — there's nothing to relax. Even with player
    // rejections the variant guard shouldn't fire.
    const parsed = p({ playerName: "Bonemer" });
    const comps = [
      c("Trout 2024 Base"),
      c("Trout 2024 Base"),
      c("Trout 2024 Base"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.variantFiltered.length).toBe(0);
    expect(result.everythingFilteredOut).toBe(false);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — Q4 invariant: comp_has_unwanted_auto stays hard reject", () => {
  it("rejects auto-titled comps at EVERY tier when request isAuto=false", () => {
    // Base-card (isAuto=false) request, pool is 100% autograph comps that
    // match the auto regex (auto / autograph / autographed / autographs /
    // autos / rpa). "Signed" intentionally excluded — it's not in the
    // canonical auto regex (separate concern; see also Option A in design
    // doc for regex expansion).
    // EVERY tier must reject these — auto premium would poison the FMV.
    const parsed = p({ playerName: "Bonemer", isAuto: false, parallel: "blue" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Blue Autograph"),
      c("2024 Bowman Chrome Bonemer Auto Red"),
      c("2024 Bowman Chrome Bonemer Autos Gold"),
      c("2024 Bowman Chrome Bonemer Autographed Refractor"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    // Tier ladder exhausts at T3 with 0 surviving comps — auto rejections
    // never get relaxed.
    expect(result.chosenTier).toBe("T3");
    expect(result.variantFiltered.length).toBe(0);
    expect(result.everythingFilteredOut).toBe(true);
    expect(result.variantExclusionReasons["comp_has_unwanted_auto"]).toBeGreaterThanOrEqual(1);
  });

  it("player_name_missing_from_comp also stays hard reject across tiers", () => {
    // Different player — should reject at every tier, regardless of variant
    // attributes. (Pricing wrong-player comps is worse than failing to price.)
    const parsed = p({ playerName: "Bonemer", parallel: "blue" });
    const comps = [
      c("Trout Blue"),
      c("Trout Blue"),
      c("Trout Blue"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T3");
    expect(result.variantFiltered.length).toBe(0);
    expect(result.everythingFilteredOut).toBe(true);
    expect(result.variantExclusionReasons["player_name_missing_from_comp"]).toBeGreaterThanOrEqual(1);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — monotonicity invariant (T_n ⊆ T_{n+1})", () => {
  it("each tier's surviving pool is a superset of the prior tier's", () => {
    // Mixed pool: each comp fails for a different reason — verify the trace
    // shows pool growing as tiers loosen.
    const parsed = p({ parallel: "blue", isAuto: true, printRun: 150, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Blue Auto /150"),    // T0 match
      c("2024 Bowman Chrome Bonemer Red Auto /150"),     // T1+ (parallel)
      c("2024 Bowman Chrome Bonemer Refractor /150"),    // T2+ (parallel + auto)
      c("2024 Bowman Chrome Bonemer Refractor /99"),     // T3+ (parallel + auto + print_run)
    ];
    const result = runVariantTierLadder(comps, parsed);
    // T0 has 1 — below threshold, so loop continues
    expect(result.tierLadderTrace.T0).toBe(1);
    // T1 has 2 (drops parallel)
    expect(result.tierLadderTrace.T1).toBe(2);
    // T2 has 3 (drops parallel + auto) — meets threshold, ladder breaks here
    expect(result.tierLadderTrace.T2).toBe(3);
    expect(result.chosenTier).toBe("T2");
    // T3 not visited (loop broke at T2)
    expect(result.tierLadderTrace.T3).toBe(0);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — exclusion reasons reflect chosen tier", () => {
  it("at T1, comps relaxed for parallel_mismatch don't appear in exclusionReasons", () => {
    const parsed = p({ parallel: "blue", isAuto: true, playerName: "Bonemer" });
    const comps = [
      c("2024 Bowman Chrome Bonemer Red Auto"),
      c("2024 Bowman Chrome Bonemer Green Auto"),
      c("2024 Bowman Chrome Bonemer Gold Auto"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T1");
    // parallel_mismatch is "accepted" at T1 so it's NOT in the exclusion bucket.
    expect(result.variantExclusionReasons["parallel_mismatch"]).toBeUndefined();
    expect(result.variantExcludedCount).toBe(0);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — VariantStrictness type surface", () => {
  it("type permits only the four locked tier values", () => {
    const tiers: VariantStrictness[] = ["T0", "T1", "T2", "T3"];
    expect(tiers).toHaveLength(4);
  });
});

describe("CF-VARIANT-FILTER-LOOSENING — interop with real parseCardQuery output", () => {
  it("real ParsedCardQuery for Bonemer Blue Auto flows through the ladder", () => {
    const parsed = parseCardQuery("2024 Bowman Chrome Caleb Bonemer Blue Auto");
    parsed.isAuto = true;
    parsed.parallel = "blue";
    const comps = [
      c("2024 Bowman Chrome Caleb Bonemer Blue Auto /150"),
      c("2024 Bowman Chrome Caleb Bonemer Blue Auto /99"),
      c("2024 Bowman Chrome Caleb Bonemer Blue Auto BD-101"),
    ];
    const result = runVariantTierLadder(comps, parsed);
    expect(result.chosenTier).toBe("T0");
    expect(result.variantFiltered.length).toBe(3);
  });
});
