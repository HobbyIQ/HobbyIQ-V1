// CF-YEAR-MISMATCH-TELEMETRY (2026-06-29) — pins the predicate the
// dispatcher uses to decide whether a winning candidate's year diverges
// far enough from the user-stated year to warrant a telemetry event.
//
// PURPOSE: seed the future CF-SET-ALIAS-DICTIONARY with verified
// (user_vocabulary → CH_catalog) mappings derived from production
// traffic, instead of building the dictionary blind from the 5
// volume-test cases. Bug class C from the 2026-06-29 volume test:
//   "2000 Bowman Chrome Miguel Cabrera" → 2003 Bowman Draft Picks
//   "2001 Bowman Chrome Joe Mauer"      → 2003 Bowman Draft Picks
//   "2015 Bowman Chrome Vlad Jr."       → 2026 Bowman Mega Box
//
// THIS FILE PINS:
//   1. yearDelta > 1 → fires (the >1 threshold absorbs CH's
//      occasional ±1 mistakes that aren't true vocabulary mismatches)
//   2. yearDelta ≤ 1 → does NOT fire
//   3. user year null → does NOT fire (no signal to compare)
//   4. resolved year null AND set has no year → does NOT fire
//      (no signal to compare against)
//   5. resolved year null BUT set text contains year → fires using
//      the extracted year (extractYearFromSetText fallback)
//
// Local mirror per the established pattern (queryHyphenNormalize.test.ts,
// autoIntentSearchFilter.test.ts) — the dispatcher's app-import chain is
// heavy and not needed for a pure-predicate test.

import { describe, expect, it } from "vitest";

function extractYearFromSetText(setStr: string | undefined | null): number | null {
  if (!setStr) return null;
  const m = String(setStr).match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function shouldEmitYearMismatch(opts: {
  userYear: number | null;
  topCardYear: number | null | undefined;
  topCardSet: string | undefined | null;
}): { fires: boolean; effectiveResolvedYear: number | null } {
  if (opts.userYear == null) return { fires: false, effectiveResolvedYear: null };
  const resolvedYear =
    opts.topCardYear != null && Number.isFinite(Number(opts.topCardYear))
      ? Number(opts.topCardYear)
      : extractYearFromSetText(opts.topCardSet);
  if (resolvedYear == null) return { fires: false, effectiveResolvedYear: null };
  return {
    fires: Math.abs(resolvedYear - opts.userYear) > 1,
    effectiveResolvedYear: resolvedYear,
  };
}

describe("CF-YEAR-MISMATCH-TELEMETRY — emit predicate", () => {
  it("Class C from volume test: 2000 user, 2003 resolved → fires", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2000,
      topCardYear: 2003,
      topCardSet: "2003 Bowman Draft Picks & Prospects Baseball",
    });
    expect(r.fires).toBe(true);
    expect(r.effectiveResolvedYear).toBe(2003);
  });

  it("Class C: 2001 user, 2003 resolved → fires (delta 2)", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2001,
      topCardYear: 2003,
      topCardSet: null,
    });
    expect(r.fires).toBe(true);
  });

  it("Class C: 2015 user, 2026 resolved → fires (delta 11, severe)", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2015,
      topCardYear: 2026,
      topCardSet: "2026 Bowman Mega Box Baseball",
    });
    expect(r.fires).toBe(true);
  });

  it("delta of exactly 1 → does NOT fire (CH's occasional year-cusp confusion is not a vocabulary mismatch)", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2024,
      topCardYear: 2025,
      topCardSet: null,
    });
    expect(r.fires).toBe(false);
  });

  it("delta of 0 → does NOT fire (perfect match)", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2024,
      topCardYear: 2024,
      topCardSet: null,
    });
    expect(r.fires).toBe(false);
  });

  it("user year missing → does NOT fire (no signal)", () => {
    const r = shouldEmitYearMismatch({
      userYear: null,
      topCardYear: 2003,
      topCardSet: "2003 Bowman Draft Picks & Prospects",
    });
    expect(r.fires).toBe(false);
  });

  it("resolved year missing entirely → does NOT fire", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2024,
      topCardYear: null,
      topCardSet: null,
    });
    expect(r.fires).toBe(false);
  });

  it("topCardYear missing but set text contains year → uses extracted year", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2000,
      topCardYear: null,
      topCardSet: "2003 Bowman Draft Picks & Prospects Baseball",
    });
    expect(r.fires).toBe(true);
    expect(r.effectiveResolvedYear).toBe(2003);
  });

  it("topCardYear is string (CH sometimes returns string years) → coerced to number", () => {
    const r = shouldEmitYearMismatch({
      userYear: 2015,
      topCardYear: "2026" as unknown as number,
      topCardSet: null,
    });
    expect(r.fires).toBe(true);
    expect(r.effectiveResolvedYear).toBe(2026);
  });
});

describe("CF-YEAR-MISMATCH-TELEMETRY — extractYearFromSetText", () => {
  it("standard CH set name → year extracted", () => {
    expect(extractYearFromSetText("2025 Bowman Chrome Baseball")).toBe(2025);
  });

  it("legacy century → year extracted", () => {
    expect(extractYearFromSetText("1989 Upper Deck Baseball")).toBe(1989);
  });

  it("set text with no year → null", () => {
    expect(extractYearFromSetText("Bowman Draft Picks & Prospects")).toBe(null);
  });

  it("null/undefined input → null (defensive)", () => {
    expect(extractYearFromSetText(null)).toBe(null);
    expect(extractYearFromSetText(undefined)).toBe(null);
  });

  it("set text with multiple years → first one wins (the set-year prefix)", () => {
    // CH always prefixes the set with the card-year, so the first match
    // is the correct year even if "2024 Topps Update Series" mentions
    // "2024 World Series" later in some sub-text.
    expect(extractYearFromSetText("2024 Topps Update Series Baseball")).toBe(2024);
  });
});
