import { describe, it, expect } from "vitest";
import { titleMatchesParallel } from "../src/services/compiq/titleParallelMatch.js";

// CF-TITLE-PARALLEL-MATCH-TESTS (Drew, 2026-07-19). Pinning tests for
// the shared title-verification helper that gates two sold_comps emit
// paths (listingRange endpoint + canonicalFmv ebay-browse-ended warm).
// Failure of this function corrupts the pool with wrong-parallel or
// wrong-player rows.

describe("titleMatchesParallel — cardNumber gate", () => {
  it("passes when cardNumber appears in title", () => {
    expect(titleMatchesParallel(
      "2020 Bowman Chrome Bobby Witt Jr. CPA-BWJ Auto",
      "Base",
      "CPA-BWJ",
    )).toBe(true);
  });

  it("rejects when cardNumber is absent from title", () => {
    expect(titleMatchesParallel(
      "2020 Bowman Chrome Bobby Witt Jr. Auto",
      "Base",
      "CPA-BWJ",
    )).toBe(false);
  });

  it("matches cardNumber with optional # prefix", () => {
    expect(titleMatchesParallel(
      "2020 Bowman Chrome Bobby Witt Jr. #CPA-BWJ Auto",
      "Base",
      "CPA-BWJ",
    )).toBe(true);
  });

  it("cardNumber gate is case-insensitive", () => {
    expect(titleMatchesParallel(
      "2020 Bowman Chrome cpa-bwj Auto",
      "Base",
      "CPA-BWJ",
    )).toBe(true);
  });
});

describe("titleMatchesParallel — parallel keyword gate", () => {
  it("Blue Refractor query matches title with Blue Refractor", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Eric Hartman #CPA-EHA Auto",
      "Blue Refractor",
      "CPA-EHA",
    )).toBe(true);
  });

  it("Blue Refractor query REJECTS Blue X-Fractor listing", () => {
    // The exact bug that motivated the four gates. Cross-parallel
    // pollution turns into permanent FMV corruption.
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue X-Fractor Eric Hartman #CPA-EHA Auto",
      "Blue Refractor",
      "CPA-EHA",
    )).toBe(false);
  });

  it("Blue X-Fractor query matches title with Blue X-Fractor", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue X-Fractor Eric Hartman #CPA-EHA Auto",
      "Blue X-Fractor",
      "CPA-EHA",
    )).toBe(true);
  });

  it("Green Shimmer query rejects Green Reptilian", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Green Reptilian Refractor Hartman #CPA-EHA",
      "Green Shimmer Refractor",
      "CPA-EHA",
    )).toBe(false);
  });

  it("Base parallel is permissive (no distinctive tokens required)", () => {
    expect(titleMatchesParallel(
      "2020 Bowman Chrome Prospect Auto Bobby Witt Jr. CPA-BWJ",
      "Base",
      "CPA-BWJ",
    )).toBe(true);
  });
});

describe("titleMatchesParallel — dominant color gate", () => {
  it("rejects when target color is missing from title", () => {
    // Blue Refractor query requires "blue" in the title
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Refractor Hartman #CPA-EHA Auto",
      "Blue Refractor",
      "CPA-EHA",
    )).toBe(false);
  });

  it("Gold parallel requires 'gold' in title", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Gold Refractor #CPA-EHA",
      "Gold Refractor",
      "CPA-EHA",
    )).toBe(true);
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Refractor #CPA-EHA",
      "Gold Refractor",
      "CPA-EHA",
    )).toBe(false);
  });
});

describe("titleMatchesParallel — player-surname gate (when cardNumber absent)", () => {
  it("without cardNumber, requires player surname in title", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto Eric Hartman",
      "Blue Refractor",
      null,
      "Eric Hartman",
    )).toBe(true);
  });

  it("without cardNumber, rejects wrong-player listing even when parallel matches", () => {
    // The specific bug the player gate closes — a Blue Refractor Auto
    // listing for the WRONG player would previously slip through.
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto Wyatt Langford",
      "Blue Refractor",
      null,
      "Eric Hartman",
    )).toBe(false);
  });

  it("case-insensitive surname match", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto ERIC HARTMAN",
      "Blue Refractor",
      null,
      "Eric Hartman",
    )).toBe(true);
  });

  it("very short surnames (<3 chars) skip the surname gate to avoid false rejects", () => {
    // e.g. "Eric Ho" — surname "Ho" is too short to be a reliable
    // token check. Fall through to parallel-only.
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto Someone Else",
      "Blue Refractor",
      null,
      "Eric Ho",
    )).toBe(true);
  });

  it("cardNumber presence overrides surname gate (cardNumber is stronger)", () => {
    // When cardNumber is provided, we don't check surname — cardNumber
    // already anchors identity.
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto Wyatt Langford #CPA-EHA",
      "Blue Refractor",
      "CPA-EHA",
      "Eric Hartman",
    )).toBe(true);
    // (This one probably shouldn't happen in practice — cardNumber
    // mismatched with wrong-player. But the cardNumber gate trusts
    // the number as authoritative.)
  });

  it("without cardNumber AND without playerName, falls back to parallel-only (legacy behavior)", () => {
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Blue Refractor Auto Anyone",
      "Blue Refractor",
      null,
      null,
    )).toBe(true);
  });
});

describe("titleMatchesParallel — regression tests for known real cases", () => {
  it("Hartman Blue X-Fractor sale is NOT written under Blue Refractor query", () => {
    // Real 2026-07-19 data: n=5 Hartman Blue X-Fractor sales in the pool
    // were being polluting the Blue Refractor cardId's parallel space.
    expect(titleMatchesParallel(
      "2026 Bowman Chrome Prospects #CPA-EHA Blue X-Fractor Auto /150 - Raw",
      "Blue Refractor",
      "CPA-EHA",
    )).toBe(false);
  });

  it("Hartman Blue Refractor sale IS written under Blue Refractor query", () => {
    expect(titleMatchesParallel(
      "Eric Hartman 2026 Bowman Chrome Blue Refractor #CPA-EHA Auto",
      "Blue Refractor",
      "CPA-EHA",
    )).toBe(true);
  });
});
