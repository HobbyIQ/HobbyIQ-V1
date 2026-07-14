// CF-UNIFIED-SEARCH-RANK (Drew, 2026-07-14) — pins the ranking that
// merges CH + Cardsight candidates into one pool sorted by intent score.
// Pre-fix: Cardsight rows were appended after CH's re-ranked list
// without any scoring, so a user searching "Eric Hartman 2026 Blue
// Refractor Auto" saw the correct SKU at the bottom of the picker even
// though it existed — Cardsight held the parallel, CH didn't.
//
// This file pins:
//   1. scoreIdentityForIntent extends scoreCandidateForIntent with
//      title-token overlap + exact-parallel bonus
//   2. Exact-parallel bonus wins over title-only match
//   3. Title-token overlap is bounded (long titles can't dominate)
//   4. Parallel-field matches aren't double-counted via the title branch

import { describe, expect, it } from "vitest";
import { scoreIdentityForIntent } from "../src/services/unifiedSearch/dispatcher.js";

describe("scoreIdentityForIntent — base + title bonus + exact-parallel bonus", () => {
  const intentTokens = ["hartman", "2026", "blue", "refractor", "auto"];
  const intentWantsAuto = true;
  const intentYear = 2026;

  it("Cardsight-exploded Blue Refractor Auto (exact parallel match) → top score", () => {
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: true,
        parallel: "Blue Refractor",
        title: "2026 Bowman Chrome Prospects Autographs Eric Hartman CPA-EHA Blue Refractor",
        year: 2026,
      },
      intentTokens,
      intentWantsAuto,
      intentYear,
      intentParallel: "Blue Refractor",
    });
    // +3 auto + 2×2 (blue+refractor parallel tokens) + 4 year-exact
    // + 5 exact-parallel bonus = 16
    // Title bonus: "hartman" (in title, not in parallel) = +1
    //              "2026" = +1
    // = 18 total
    expect(score).toBe(18);
  });

  it("CH Base auto with title-only 'blue' mention → lower than exact-parallel row", () => {
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: true,
        parallel: "Base",
        title: "2026 Bowman Eric Hartman blue background auto",
        year: 2026,
      },
      intentTokens,
      intentWantsAuto,
      intentYear,
      intentParallel: "Blue Refractor",
    });
    // +3 auto + 0 parallel + 4 year + 0 exact-parallel (base != blue refractor)
    // Title bonus: "hartman" + "2026" + "blue" + "auto" (all present in title,
    // none already in parallel) = 4 (cap kicks in at 4)
    // = 11 total
    expect(score).toBe(11);
  });

  it("wrong year drives negative delta penalty regardless of parallel match", () => {
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: true,
        parallel: "Blue Refractor",
        title: "2020 Bowman Chrome Eric Hartman Blue Refractor Auto",
        year: 2020,
      },
      intentTokens,
      intentWantsAuto,
      intentYear,
      intentParallel: "Blue Refractor",
    });
    // +3 auto + 2×2 parallel - 5 year-delta-6 + 5 exact-parallel
    // Title bonus: "hartman" + "auto" (neither already in parallel) = +2
    // = 9 total (still negative year signal drags it down, as intended)
    expect(score).toBe(9);
  });

  it("title-token bonus is bounded at +4 (long descriptive titles can't dominate)", () => {
    const wideTokens = ["blue", "refractor", "auto", "shiny", "rare",
      "chrome", "prospect", "rookie", "star", "hartman"];
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: false,
        parallel: "Base",
        title: "shiny rare chrome prospect rookie star Hartman blue refractor auto version",
        year: null,
      },
      intentTokens: wideTokens,
      intentWantsAuto: false,
      intentYear: null,
      intentParallel: null,
    });
    // Base doesn't match any intent parallel tokens.
    // Title has all 10 intent tokens, but bonus caps at +4.
    // No year signal, no exact parallel, no auto ask.
    // Score = 4 (title bonus capped)
    expect(score).toBe(4);
  });

  it("parallel-field match is NOT double-counted via the title branch", () => {
    // "blue" and "refractor" appear in BOTH the parallel and the title —
    // the title branch must skip tokens already claimed by the parallel branch.
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: true,
        parallel: "Blue Refractor",
        title: "2026 Bowman Blue Refractor Eric Hartman",
        year: 2026,
      },
      intentTokens: ["blue", "refractor"],
      intentWantsAuto: false,
      intentYear: 2026,
      intentParallel: null,
    });
    // +2 (blue in parallel) + 2 (refractor in parallel) + 4 year-exact
    // Title branch: "blue" and "refractor" already claimed by parallel → 0
    // = 8 total (no double-count)
    expect(score).toBe(8);
  });

  it("no intent parallel → no exact-parallel bonus", () => {
    const score = scoreIdentityForIntent({
      candidate: {
        isAuto: true,
        parallel: "Blue Refractor",
        title: "2026 Bowman Blue Refractor Auto",
        year: 2026,
      },
      intentTokens: ["blue"],
      intentWantsAuto: true,
      intentYear: 2026,
      intentParallel: null,
    });
    // +3 auto + 2 (blue parallel) + 4 year = 9. No exact-parallel bonus.
    expect(score).toBe(9);
  });
});

describe("scoreIdentityForIntent — ordering the Hartman Blue Refractor Auto scenario", () => {
  // The exact live scenario Drew reported:
  // Query: "Eric Hartman 2026 Blue Refractor Auto"
  // Candidates come from CH (base variants, no Blue Refractor)
  // + Cardsight-exploded parallels (Base, Refractor, Blue Refractor,
  //   Orange, etc. — all as separate rows).
  // Pre-fix: Blue Refractor Auto landed at bottom of the picker.
  // Post-fix: Blue Refractor Auto ranks first among the exploded set.
  it("Blue Refractor Auto beats sibling parallels for a Blue Refractor query", () => {
    const intentTokens = ["hartman", "2026", "blue", "refractor", "auto"];
    const intentWantsAuto = true;
    const intentYear = 2026;
    const intentParallel = "Blue Refractor";

    function scoreCard(parallel: string, title: string) {
      return scoreIdentityForIntent({
        candidate: { isAuto: true, parallel, title, year: 2026 },
        intentTokens,
        intentWantsAuto,
        intentYear,
        intentParallel,
      });
    }

    const blueRefractor = scoreCard(
      "Blue Refractor",
      "2026 Bowman Chrome Prospects Autographs Eric Hartman Blue Refractor",
    );
    const orangeRefractor = scoreCard(
      "Orange Refractor",
      "2026 Bowman Chrome Prospects Autographs Eric Hartman Orange Refractor",
    );
    const speckle = scoreCard(
      "Speckle Refractor",
      "2026 Bowman Chrome Prospects Autographs Eric Hartman Speckle Refractor",
    );
    const baseRefractor = scoreCard(
      "Refractor",
      "2026 Bowman Chrome Prospects Autographs Eric Hartman Refractor",
    );

    // Blue Refractor MUST rank strictly higher than any sibling.
    expect(blueRefractor).toBeGreaterThan(orangeRefractor);
    expect(blueRefractor).toBeGreaterThan(speckle);
    expect(blueRefractor).toBeGreaterThan(baseRefractor);
  });
});
