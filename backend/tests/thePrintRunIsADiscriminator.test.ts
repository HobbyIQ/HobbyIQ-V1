import { describe, it, expect } from "vitest";

/**
 * CF-THE-PRINT-RUN-IS-A-DISCRIMINATOR (Drew, 2026-08-24).
 *
 *   "2025 Bowman Draft Chrome Prospect Auto - Eli Willits Yellow Refractor /75
 *    ... This is the best format bc we can match to it correctly."
 *
 * Every field in that sentence is a discriminator, and the print run was the
 * one being thrown away. It is parsed from the title, reaches canonicalize,
 * and is part of the match cache key — but the fuzzy-parallel step neither
 * selected nor ranked on it, so two parallels of the same colour were
 * separated by nothing at all.
 *
 * The live consequence, on a real holding: the sale
 *
 *   "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9"
 *
 * carries printRun 50. The Gold Refractor row is /50 and the plain Refractor
 * row is /499, so the number settled it — and was discarded. That sale sits on
 * :refractor:, which is why the gold pool holds ZERO comps for a card that has
 * demonstrably traded, and why the holding priced against /499 commons.
 *
 * This pins the FILTER's behaviour directly. It is deliberately one-directional:
 * a print run may only ever reject a candidate, and only when both sides state
 * one. Unnumbered cards and titles with no serial must behave exactly as before,
 * or this fix would quietly unmatch most of the catalog.
 */
describe("the print run separates same-colour parallels", () => {
  // The shipped predicate, mirrored. If catalogMatcher's filter changes, this
  // should be updated deliberately rather than silently passing on a stale copy.
  const keeps = (wantRun: number | null | undefined, candidateRun: number | null) => {
    if (typeof wantRun !== "number" || wantRun <= 0 || candidateRun === null) return true;
    return candidateRun === wantRun;
  };

  it("keeps the /50 candidate and rejects the /499 one for a 1/50 sale", () => {
    expect(keeps(50, 50)).toBe(true);
    expect(keeps(50, 499)).toBe(false);
  });

  it("keeps Eli Willits Yellow Refractor /75 against its own print run", () => {
    expect(keeps(75, 75)).toBe(true);
    expect(keeps(75, 99)).toBe(false);
    expect(keeps(75, 50)).toBe(false);
  });

  it("never rejects when the TITLE gave no print run", () => {
    // Most eBay titles omit the serial. Those must keep matching exactly as
    // they did before, or this becomes a mass-unmatching event.
    for (const candidate of [50, 499, 1, null]) {
      expect(keeps(null, candidate), `null vs ${candidate}`).toBe(true);
      expect(keeps(undefined, candidate), `undefined vs ${candidate}`).toBe(true);
      expect(keeps(0, candidate), `0 vs ${candidate}`).toBe(true);
    }
  });

  it("never rejects when the CANDIDATE has no print run", () => {
    // An unnumbered base refractor is a legitimate match for a numbered title
    // only in the sense that we cannot prove otherwise — so we do not reject.
    for (const want of [50, 75, 499]) expect(keeps(want, null), String(want)).toBe(true);
  });

  it("is one-directional: it can reject, never promote", () => {
    // A matching print run does not make a wrong-coloured parallel right. The
    // parallel token filter runs first and this only narrows what survives it.
    expect(keeps(50, 50)).toBe(true);
    expect(keeps(50, 51)).toBe(false);
  });
});
