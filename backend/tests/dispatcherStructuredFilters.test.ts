// CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28) — pins the contract by
// which the unifiedSearch dispatcher converts the parser's ParsedCardQuery
// into CardHedge's CardSearchFilters shape.
//
// PRIOR-CF GAP: dispatchFreetextMode stuffed the entire trimmed query into
// CardHedge's free-text `search` field. CH's tokenizer could not consistently
// surface specific-variant cards (e.g. Drake Baldwin 2025 Bowman Chrome
// Image Variation), because the parallel-name noise dominated the match.
// CardHedge's /cards/card-search natively supports dedicated `player`,
// `set`, and `rookie` filter fields — sending them lets CH constrain the
// candidate pool to the right player + set before tokenizing the residual
// `search` string for variant matching.
//
// THIS FILE PINS:
//   1. High-confidence parses (player + year + brand cleanly extracted)
//      build a populated filter object with all relevant fields.
//   2. Low-confidence parses (below PARSER_CONFIDENCE_FLOOR) return
//      `undefined` so the dispatcher falls back to pre-CF behavior.
//   3. The `set` field is composed as `${year} ${set} Baseball` to match
//      CardHedge's canonical set naming (per their docs example
//      `"2018 Topps Chrome Baseball"`).
//   4. The `rookie` field is emitted as the literal "Rookie" when
//      isRookie is true, and omitted otherwise.
//   5. Edge cases (player-only, set-only, all-empty parses) coerce to the
//      expected shape — no empty-string fields, no spurious fallback set
//      composition when year is missing.

import { describe, expect, it } from "vitest";
import { buildFiltersFromParsedQuery } from "../src/services/unifiedSearch/dispatcher.js";
import { parseCardQuery } from "../src/services/compiq/cardQueryParser.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. HIGH-CONFIDENCE — full structured parse
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — high-confidence parses emit structured fields", () => {
  it("Drake Baldwin 2025 Bowman Chrome Image Variation → player + set + Baseball suffix", () => {
    const parsed = parseCardQuery("Drake Baldwin 2025 Bowman Chrome Image Variation");
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Drake Baldwin");
    expect(filters!.set).toBe("2025 Bowman Chrome Baseball");
  });

  it("Mike Trout 2024 Topps Chrome Refractor → emits player + composed set", () => {
    const parsed = parseCardQuery("Mike Trout 2024 Topps Chrome Refractor");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Mike Trout");
    expect(filters!.set).toBe("2024 Topps Chrome Baseball");
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
// 3. SET COMPOSITION — year suffix logic
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-SET-FILTER-ONLY-WHEN-SPECIFIC (2026-06-28) — brand-only queries
// drop the set filter (CardHedge set names are granular; brand-only doesn't
// match any real set row)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — brand-only queries skip the set filter", () => {
  it("'2025 Bowman Josh Hammond' → set filter dropped (brand-only)", () => {
    const parsed = parseCardQuery("2025 Bowman Josh Hammond");
    expect(parsed.brand).toBe("Bowman");
    expect(parsed.set).toBe("Bowman"); // parser sets set=brand when no subset
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters).toBeDefined();
    expect(filters!.player).toBe("Josh Hammond");
    expect(filters!.set).toBeUndefined(); // ← the fix
  });

  it("'2025 Bowman Chrome Eric Hartman' → set filter SENT (specific subset)", () => {
    const parsed = parseCardQuery("2025 Bowman Chrome Eric Hartman");
    expect(parsed.brand).toBe("Bowman");
    expect(parsed.set).toBe("Bowman Chrome");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.set).toBe("2025 Bowman Chrome Baseball");
  });

  it("'2024 Topps Mike Trout' → set filter dropped (brand-only)", () => {
    const parsed = parseCardQuery("2024 Topps Mike Trout");
    expect(parsed.brand).toBe("Topps");
    expect(parsed.set).toBe("Topps");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.set).toBeUndefined();
  });

  it("'2024 Topps Chrome Mike Trout' → set filter SENT (specific subset)", () => {
    const parsed = parseCardQuery("2024 Topps Chrome Mike Trout");
    expect(parsed.brand).toBe("Topps");
    expect(parsed.set).toBe("Topps Chrome");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.set).toBe("2024 Topps Chrome Baseball");
  });
});

describe("buildFiltersFromParsedQuery — set field composition", () => {
  it("year + set present → '${year} ${set} Baseball'", () => {
    const parsed = parseCardQuery("Mike Trout 2024 Bowman Chrome");
    const filters = buildFiltersFromParsedQuery(parsed);
    expect(filters!.set).toBe("2024 Bowman Chrome Baseball");
  });

  it("set present without year → '${set} Baseball' fallback", () => {
    // Forge a parsed result with set but no year to exercise the fallback.
    // (Real parser typically extracts year too when set is present, but
    // the fallback branch is observable in synthetic input.)
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
      confidence: 0.6, // above the floor
      rawQuery: "synthetic",
    };
    const filters = buildFiltersFromParsedQuery(forged);
    expect(filters!.set).toBe("Bowman Chrome Baseball");
  });

  it("set absent → set field omitted entirely", () => {
    const forged = {
      playerName: "Mike Trout",
      year: 2024,
      brand: "Bowman",
      set: null,
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
// 4. EMPTY/NO-OP INVARIANT — when all filterable fields are absent, return undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("buildFiltersFromParsedQuery — empty-result invariant", () => {
  it("high confidence but ALL three filterable fields empty → undefined (no CH request shape change)", () => {
    // High confidence is possible without ANY of {player, set, rookie}, e.g.
    // a parse that hits brand + year + parallel + isAuto + grade. In that
    // case sending an empty filter object would be wasteful — we keep the
    // pre-CF call shape exactly.
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
