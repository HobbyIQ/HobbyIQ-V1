// CF-CH-SANITIZE-PLAYER-FILTER (2026-06-28) — pins the parallel-token
// stripping behavior that runs against parser-extracted playerName before
// it's used as the CardHedge `player` filter.
//
// PRIOR-CF GAP: the parser's playerName extraction strips known noise
// (auto, refractor, base, etc.) but leaves parallel-specific tokens
// like "X-Fractor", "Fractor", "Shimmer", "Geometric" intact. They leak
// into playerName ("X-fractor Eric Hartman" from "blue x-fractor eric
// hartman"). CardHedge's `player` filter is exact-match, so the
// polluted name returns 0 results.
//
// Live curl confirmation (post the prior CF-CH-SEARCH-MINIMAL-WHEN-FILTERED
// deploy dc27b2f7): "2026 bowman blue x-fractor eric hartman auto" still
// returned 0 because parser extracted player as "X-fractor Eric Hartman"
// and CH had no such player.
//
// THIS FILE PINS:
//   1. Parallel tokens (X-Fractor, Fractor, Shimmer, etc.) are stripped
//   2. Clean player names pass through unchanged
//   3. Tokens that could legitimately be surnames (Black, White, Gold)
//      are NOT stripped — solo color words pass through
//   4. Edge cases (empty, whitespace-only, fully-stripped) coerce safely

import { describe, expect, it } from "vitest";
import { sanitizePlayerForCH } from "../src/services/unifiedSearch/dispatcher.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. PARALLEL TOKENS THAT LEAK INTO PLAYERNAME — strip them
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePlayerForCH — strips leaked parallel tokens", () => {
  const CASES: ReadonlyArray<[string, string, string]> = [
    ["X-fractor Eric Hartman", "Eric Hartman", "X-Fractor variant (the canonical case)"],
    ["X-Fractor Eric Hartman", "Eric Hartman", "X-Fractor case-sensitive variant"],
    ["XFractor Eric Hartman", "Eric Hartman", "XFractor without hyphen"],
    ["Fractor Eric Hartman", "Eric Hartman", "bare Fractor token"],
    ["Refractor Eric Hartman", "Eric Hartman", "Refractor"],
    ["Superfractor Eric Hartman", "Eric Hartman", "Superfractor"],
    ["Shimmer Eric Hartman", "Eric Hartman", "Shimmer"],
    ["Speckle Eric Hartman", "Eric Hartman", "Speckle"],
    ["Geometric Eric Hartman", "Eric Hartman", "Geometric"],
    ["Wave Eric Hartman", "Eric Hartman", "Wave"],
    ["RayWave Eric Hartman", "Eric Hartman", "RayWave"],
    ["Lava Eric Hartman", "Eric Hartman", "Lava"],
    ["Grass Eric Hartman", "Eric Hartman", "Grass"],
    ["Reptilian Eric Hartman", "Eric Hartman", "Reptilian"],
    ["LogoFractor Eric Hartman", "Eric Hartman", "LogoFractor"],
    ["Pearl Eric Hartman", "Eric Hartman", "Pearl"],
    ["Neon Eric Hartman", "Eric Hartman", "Neon"],
    ["Steel Metal Eric Hartman", "Eric Hartman", "Steel Metal"],
    ["Mini-Diamond Eric Hartman", "Eric Hartman", "Mini-Diamond (hyphenated)"],
    ["Diamond Eric Hartman", "Eric Hartman", "Diamond"],
    ["Atomic Eric Hartman", "Eric Hartman", "Atomic"],
    ["Pattern Eric Hartman", "Eric Hartman", "Pattern"],
    // Multi-token noise cases
    ["X-Fractor Shimmer Eric Hartman", "Eric Hartman", "two parallel tokens"],
    ["X-Fractor Eric Hartman Shimmer", "Eric Hartman", "tokens both sides of name"],
  ];

  for (const [input, expected, label] of CASES) {
    it(`"${input}" → "${expected}" (${label})`, () => {
      expect(sanitizePlayerForCH(input)).toBe(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLEAN NAMES PASS THROUGH UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePlayerForCH — clean names pass through", () => {
  const CLEAN: ReadonlyArray<string> = [
    "Eric Hartman",
    "Mike Trout",
    "Shohei Ohtani",
    "Drake Baldwin",
    "Aaron Judge",
    "Bobby Witt Jr",
    "Mookie Betts",
    "Hyun-Jin Ryu", // hyphenated name — must survive
    "O'Neill",      // apostrophe
    "JT Realmuto",
  ];

  for (const name of CLEAN) {
    it(`"${name}" → unchanged`, () => {
      expect(sanitizePlayerForCH(name)).toBe(name);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. COLOR WORDS / POTENTIAL SURNAMES — NOT stripped (false-positive guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePlayerForCH — color words that could be surnames stay", () => {
  // Solo color words could be real surnames (Joe Black, Brett Black, etc.)
  // and shouldn't be stripped from playerName. The sanitizer's vocabulary
  // is restricted to parallel-specific terms (Fractor, Shimmer, etc.) that
  // are NOT plausible surnames.
  const COLOR_CASES: ReadonlyArray<string> = [
    "Joe Black",   // real MLB player
    "Brett Black",
    "Robin White", // hypothetical
    "Jim Gold",
    "Steve Silver",
    "Tom Orange",
  ];

  for (const name of COLOR_CASES) {
    it(`"${name}" → unchanged (surname preserved)`, () => {
      expect(sanitizePlayerForCH(name)).toBe(name);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EDGE CASES — empty / whitespace / fully-stripped
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePlayerForCH — edge cases", () => {
  it("empty string → empty string", () => {
    expect(sanitizePlayerForCH("")).toBe("");
  });

  it("whitespace-only → empty string", () => {
    expect(sanitizePlayerForCH("    ")).toBe("");
  });

  it("only parallel tokens → empty string (caller must guard this)", () => {
    expect(sanitizePlayerForCH("X-Fractor")).toBe("");
    expect(sanitizePlayerForCH("Shimmer Refractor")).toBe("");
    expect(sanitizePlayerForCH("Geometric")).toBe("");
  });

  it("name with extra internal spaces → collapsed to single", () => {
    expect(sanitizePlayerForCH("Eric    Hartman")).toBe("Eric Hartman");
  });

  it("name with parallel token between names → stripped, spaces collapsed", () => {
    expect(sanitizePlayerForCH("Eric X-Fractor Hartman")).toBe("Eric Hartman");
  });

  it("partial-token false match: 'Patterns' should NOT match 'Pattern' (word boundary)", () => {
    // Just sanity — \b prevents substring match
    expect(sanitizePlayerForCH("Patterns Hartman")).toBe("Patterns Hartman");
  });
});
