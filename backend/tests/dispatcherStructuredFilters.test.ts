// CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28) / CF-CARDSEARCH-FIRSTPASS
// (2026-07-01) — pins the contract by which the unifiedSearch dispatcher
// converts the parser's ParsedCardQuery into CardHedge's CardSearchFilters
// shape.
//
// 2026-07-01 update — the set filter is no longer emitted. See dispatcher.ts
// CF-CARDSEARCH-FIRSTPASS comment for the empirical justification: CH's set
// names vary per-product in ways our synthesizer can't predict, and the
// exact-match filter zeroed out ~79% of a 92-card stress test. The downstream
// rerank (scoreCandidateForIntent, year-delta + parallel-token + auto-intent)
// handles variant selection from a wider player-filtered pool.
//
// THIS FILE PINS:
//   1. High-confidence parses (player + year + brand cleanly extracted)
//      emit `player` (and `rookie` when the isRookie flag fires). The
//      `set` field is NEVER emitted, regardless of subset specificity.
//   2. Low-confidence parses (below PARSER_CONFIDENCE_FLOOR) return
//      `undefined` so the dispatcher falls back to pre-CF behavior.
//   3. The `rookie` field is emitted as the literal "Rookie" when
//      isRookie is true, and omitted otherwise.
//   4. Edge cases (player-only, all-empty parses) coerce to the expected
//      shape — no empty-string fields.

import { describe, expect, it } from "vitest";
import { buildFiltersFromParsedQuery } from "../src/services/unifiedSearch/dispatcher.js";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. HIGH-CONFIDENCE — full structured parse
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — high-confidence parses emit player + rookie only", () => {
  it("Drake Baldwin 2025 Bowman Chrome Image Variation → player set, no set filter", () => {
    const parsed = parseCardQuery("Drake Baldwin 2025 Bowman Chrome Image Variation");
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Drake Baldwin");
    expect(filters!.set).toBeUndefined();
  });

  it("Mike Trout 2024 Topps Chrome Refractor → player set, no set filter", () => {
    const parsed = parseCardQuery("Mike Trout 2024 Topps Chrome Refractor");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Mike Trout");
    expect(filters!.set).toBeUndefined();
  });

  it("rookie keyword → emits rookie: 'Rookie' filter", () => {
    const parsed = parseCardQuery("Drake Baldwin 2025 Bowman Chrome rookie");
    expect(parsed.isRookie).toBe(true);
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.rookie).toBe("Rookie");
  });

  it("no rookie keyword → rookie field omitted", () => {
    const parsed = parseCardQuery("Mike Trout 2024 Topps Chrome");
    expect(parsed.isRookie).toBe(false);
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.rookie).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOW-CONFIDENCE — fall back to free-text only
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — low-confidence parses return undefined (free-text fallback)", () => {
  it("single-word player + nothing else → undefined (parser scores below floor)", () => {
    const parsed = parseCardQuery("trout");
    expect(parsed.confidence).toBeLessThan(0.5);
    expect(buildFiltersFromParsedQuery(parsed)).toBeUndefined();
  });

  it("empty input → undefined", () => {
    const parsed = parseCardQuery("");
    expect(buildFiltersFromParsedQuery(parsed)).toBeUndefined();
  });

  it("ambiguous noise tokens only → undefined", () => {
    const parsed = parseCardQuery("auto raw");
    expect(parsed.playerName).toBeNull();
    expect(buildFiltersFromParsedQuery(parsed)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SET FILTER — pin the "never emit set" invariant across shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — set filter is never emitted", () => {
  it("'2025 Bowman Josh Hammond' (brand-only) → player only", () => {
    const parsed = parseCardQuery("2025 Bowman Josh Hammond");
    expect(parsed.brand).toBe("Bowman");
    expect(parsed.set).toBe("Bowman");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Josh Hammond");
    expect(filters!.set).toBeUndefined();
  });

  it("'2025 Bowman Chrome Eric Hartman' (specific subset) → still no set filter", () => {
    const parsed = parseCardQuery("2025 Bowman Chrome Eric Hartman");
    expect(parsed.brand).toBe("Bowman");
    expect(parsed.set).toBe("Bowman Chrome");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.player).toBe("Eric Hartman");
    expect(filters!.set).toBeUndefined();
  });

  it("'Mike Trout 2024 Bowman Chrome' → still no set filter", () => {
    const parsed = parseCardQuery("Mike Trout 2024 Bowman Chrome");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.set).toBeUndefined();
  });

  it("synthetic parse with set but no year → still no set filter", () => {
    const forged = {
      playerName: "Mike Trout",
      year: null,
      brand: "Bowman",
      set: "Bowman Chrome",
      parallel: null,
      isAuto: false,
      isPatch: false,
      isRookie: false,
      printRun: null,
      cardNumber: null,
      grade: null,
      gradingCompany: null,
      confidence: 0.6,
      rawQuery: "synthetic",
    };
    const filters = buildFiltersFromParsedQuery(forged);
    expect(filters!.set).toBeUndefined();
    expect(filters!.player).toBe("Mike Trout");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. YEAR SLOP — the stress-test regression case
//    CF-CARDSEARCH-FIRSTPASS (2026-07-01): a query with a wrong year for
//    the player (Paul Skenes's real rookie is 2024; user types 2023) must
//    NOT zero out due to set-filter exact-match mismatch. With set filter
//    dropped, `filters.player` alone remains — CH returns 50 candidates
//    regardless of the year slop, and the rerank layer sorts by year-delta.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — wrong-year queries do not over-narrow", () => {
  it("'Paul Skenes 2023 Bowman Chrome Base' (real year is 2024) → player-only filter, no set", () => {
    const parsed = parseCardQuery("Paul Skenes 2023 Bowman Chrome Base");
    expect(parsed.year).toBe(2023);
    expect(parsed.playerName).toBe("Paul Skenes");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Paul Skenes");
    expect(filters!.set).toBeUndefined();
    expect(filters!.rookie).toBeUndefined();
  });

  it("'2016 Bowman Chrome Vladimir Guerrero Jr' → player-only (CH's real set is 'Prospects Baseball')", () => {
    const parsed = parseCardQuery("2016 Bowman Chrome Vladimir Guerrero Jr");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.player).toContain("Vladimir Guerrero");
    expect(filters!.set).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EMPTY/NO-OP INVARIANT — when all emittable fields are absent, return undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — empty-result invariant", () => {
  it("high confidence but NO player and NO rookie → undefined (no CH request shape change)", () => {
    // High confidence is possible without either emittable field, e.g. a
    // parse that hits brand + year + parallel + isAuto + grade. In that
    // case sending an empty filter object would be wasteful — we keep
    // the pre-CF call shape exactly.
    const forged = {
      playerName: null,
      year: 2024,
      brand: "Bowman",
      set: null,
      parallel: "Blue",
      isAuto: true,
      isPatch: false,
      isRookie: false,
      printRun: 150,
      cardNumber: null,
      grade: null,
      gradingCompany: null,
      confidence: 0.7,
      rawQuery: "synthetic",
    };
    const filters = buildFiltersFromParsedQuery(forged);
    expect(filters).toBeUndefined();
  });
});
