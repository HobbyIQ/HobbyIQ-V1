// CF-CH-AUTO-FROM-CARDNUMBER (2026-06-28) — pins the card-number prefix
// table that drives the isAuto flag for CardHedge search candidates.
//
// PRIOR-CF GAP: routedCardToIdentity in dispatcher.ts hardcoded
// `isAuto: false` on every CH search hit because the CardHedgeCard
// interface has no isAuto field (verified — CH's /cards/card-search
// docs example shows `rookie: true` but no isAuto). Every autograph
// candidate in the iOS picker therefore decoded as non-auto →
// AddHoldingRequest persisted isAuto=false → engine priced the holding
// as the non-auto variant. Observable on Eric Hartman CPA-EHA Orange
// Shimmer Refractor returning `isAuto: false` even though CPA is the
// canonical Chrome Prospect Autographs prefix.
//
// THIS FILE PINS:
//   1. All known autograph subset prefixes match (returns true).
//   2. Common non-auto prefixes (BCP, BD, BP) don't false-positive.
//   3. Edge cases (null, empty, whitespace, mid-string match) coerce
//      to the safe `false` default — no spurious auto promotions.
//
// Adding a new auto prefix to AUTO_CARDNUMBER_PREFIXES MUST come with a
// matching test row below so the contract stays explicit.

import { describe, expect, it } from "vitest";
import { detectIsAutoFromCardNumber } from "../src/services/unifiedSearch/dispatcher.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. KNOWN AUTOGRAPH PREFIXES — every entry in the curated table
// ─────────────────────────────────────────────────────────────────────────────

describe("detectIsAutoFromCardNumber — known autograph prefixes", () => {
  const AUTO_CASES: ReadonlyArray<[string, string]> = [
    ["CPA-EHA", "Chrome Prospect Autographs (Bowman Chrome) — Eric Hartman"],
    ["CPA-MT", "Chrome Prospect Autographs — Mike Trout (hypothetical short)"],
    ["CDA-DB", "Chrome Draft Autographs"],
    ["BCPA-100", "Bowman Chrome Prospect Autographs (variant naming)"],
    ["BCDA-50", "Bowman Chrome Draft Autographs"],
    ["BDPA-23", "Bowman Draft Prospect Autographs"],
    ["BDA-99", "Bowman Draft Autographs (paper)"],
    ["BPA-12", "Bowman Prospect Autographs (paper)"],
    ["BCRA-7", "Bowman Chrome Rookie Autographs"],
    ["TCRA-DB", "Topps Chrome Rookie Autographs"],
    ["TRA-1", "Topps Rookie Autographs"],
    ["FCA-EH", "Finest Card Autographs"],
    ["USA-EH", "USA Baseball Autograph subset"],
    ["AU-EH", "Generic Autograph prefix"],
  ];

  for (const [cardNumber, label] of AUTO_CASES) {
    it(`"${cardNumber}" (${label}) → true`, () => {
      expect(detectIsAutoFromCardNumber(cardNumber)).toBe(true);
    });
  }

  it("case-insensitive: 'cpa-eha' matches the same as 'CPA-EHA'", () => {
    expect(detectIsAutoFromCardNumber("cpa-eha")).toBe(true);
    expect(detectIsAutoFromCardNumber("Cpa-Eha")).toBe(true);
  });

  it("prefix at end-of-string (no suffix) also matches", () => {
    expect(detectIsAutoFromCardNumber("CPA")).toBe(true);
    expect(detectIsAutoFromCardNumber("BCRA")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. NON-AUTO PREFIXES — must NOT false-positive
// ─────────────────────────────────────────────────────────────────────────────

describe("detectIsAutoFromCardNumber — common non-auto prefixes (false-positive guard)", () => {
  const NON_AUTO_CASES: ReadonlyArray<[string, string]> = [
    ["BCP-102", "Bowman Chrome Prospects (base, NOT auto) — Eric Hartman"],
    ["BCP-67", "Bowman Chrome Prospects — generic"],
    ["BD-31", "Bowman Draft (variant card, not auto by default)"],
    ["BP-102", "Bowman Prospects (paper base, not auto)"],
    ["TC-50", "Topps Chrome base"],
    ["T-100", "Topps base"],
    ["1", "raw card number"],
    ["150", "raw card number"],
    ["#75", "card number with hash"],
    ["MM-19", "Multi-letter prefix that ISN'T an auto subset"],
    ["BWS-12", "Bowman What's Sport (or similar non-auto insert)"],
  ];

  for (const [cardNumber, label] of NON_AUTO_CASES) {
    it(`"${cardNumber}" (${label}) → false`, () => {
      expect(detectIsAutoFromCardNumber(cardNumber)).toBe(false);
    });
  }

  it("prefix appearing MID-STRING does not match (BCP-102 must not match CPA buried inside)", () => {
    // Sanity: CPA is a substring of "BCP-A" but the regex anchors with ^
    // so it only fires at start-of-string.
    expect(detectIsAutoFromCardNumber("BCP-A")).toBe(false);
    expect(detectIsAutoFromCardNumber("XCPA-100")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. EDGE CASES — null / empty / whitespace / non-string input
// ─────────────────────────────────────────────────────────────────────────────

describe("detectIsAutoFromCardNumber — edge cases (safe default to false)", () => {
  it("null → false", () => {
    expect(detectIsAutoFromCardNumber(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(detectIsAutoFromCardNumber(undefined)).toBe(false);
  });

  it("empty string → false", () => {
    expect(detectIsAutoFromCardNumber("")).toBe(false);
  });

  it("whitespace-only → false", () => {
    expect(detectIsAutoFromCardNumber("   ")).toBe(false);
  });

  it("leading whitespace is trimmed before match", () => {
    expect(detectIsAutoFromCardNumber("  CPA-EHA  ")).toBe(true);
  });

  it("non-string input coerces to false (TypeScript prevents this; defensive guard)", () => {
    // @ts-expect-error — intentionally passing wrong type
    expect(detectIsAutoFromCardNumber(123)).toBe(false);
    // @ts-expect-error — intentionally passing wrong type
    expect(detectIsAutoFromCardNumber({ prefix: "CPA" })).toBe(false);
  });
});
