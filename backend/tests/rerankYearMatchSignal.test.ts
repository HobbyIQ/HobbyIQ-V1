// CF-CH-RERANK-YEAR-MATCH (2026-06-29) — pins the year-match signal
// in scoreCandidateForIntent.
//
// Volume Test #2 (2026-06-29) surfaced the canonical case:
//   query: "1953 Topps Duke Snider #210"
//   CH search returned (in this order):
//     1. 1991 Topps Archives 1953 Baseball #327 (high-volume reissue)
//     2. 1953 Topps Baseball #210 (the ACTUAL card)
//   Pre-CF rerank: no year signal → ties → CH's order preserved → user
//   got the 1991 Archives instead of the real 1953 Snider.
//
// Post-CF: user-stated year 1953 + candidate years (1991, 1953) →
// the actual 1953 card gets +4 score, the 1991 reissue gets -5 → real
// card surfaces at position 1.
//
// THIS FILE PINS:
//   1. intentYear present + candidateYear exact match → +4 score
//   2. intentYear present + delta 1 → 0 (boundary years like Jan releases)
//   3. intentYear present + delta 2-3 → -2 (small drift penalty)
//   4. intentYear present + delta > 3 → -5 (reissue / wrong-decade penalty)
//   5. intentYear null → year signal disabled (no behavior change for
//      queries without a stated year)
//   6. Snider canonical scenario: 1953 candidate ranks above 1991 candidate

import { describe, expect, it } from "vitest";
import { scoreCandidateForIntent } from "../src/services/unifiedSearch/dispatcher.js";

const NO_INTENT = { intentTokens: [], intentWantsAuto: false };

describe("CF-CH-RERANK-YEAR-MATCH — year-match signal in scoreCandidateForIntent", () => {
  it("exact year match → +4 score", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const withYear = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: 1953 });
    expect(withYear - baseScore).toBe(4);
  });

  it("year delta 1 → 0 score (boundary year neutral)", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const withYear = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: 1954 });
    expect(withYear - baseScore).toBe(0);
  });

  it("year delta 2 → -2 (small drift penalty)", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const withYear = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: 1955 });
    expect(withYear - baseScore).toBe(-2);
  });

  it("year delta 38 (Archives reissue) → -5 (reissue penalty)", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const withYear = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: 1991 });
    expect(withYear - baseScore).toBe(-5);
  });

  it("intentYear null → no year signal (back-compat)", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const r = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: null, candidateYear: 1991 });
    expect(r).toBe(baseScore);
  });

  it("candidateYear missing → no year signal (CH search hit lacks year)", () => {
    const baseScore = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null });
    const r = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: null });
    expect(r).toBe(baseScore);
  });

  it("candidateYear as string (CH sometimes returns string) → coerced", () => {
    const r = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: null, intentYear: 1953, candidateYear: "1953" });
    expect(r).toBe(4);  // exact match
  });

  it("Snider canonical: 1953 candidate beats 1991 reissue under rerank", () => {
    // Volume Test #2 canonical case. Both candidates are otherwise
    // identical (no auto, no parallel tokens). Year signal alone
    // flips the ranking.
    const realCard = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: "Base", intentYear: 1953, candidateYear: 1953 });
    const reissue = scoreCandidateForIntent({ ...NO_INTENT, isAuto: false, parallel: "Base", intentYear: 1953, candidateYear: 1991 });
    expect(realCard).toBeGreaterThan(reissue);
    expect(realCard - reissue).toBe(9);  // +4 for match vs -5 for reissue
  });

  it("intent year + intentWantsAuto: signals stack additively (no interaction bug)", () => {
    // Auto card with matching year: +3 (auto) + 4 (year) = 7
    const r = scoreCandidateForIntent({
      isAuto: true,
      parallel: null,
      intentTokens: [],
      intentWantsAuto: true,
      intentYear: 2025,
      candidateYear: 2025,
    });
    expect(r).toBe(7);
  });
});
