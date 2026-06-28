// CF-CH-RERANK-BY-INTENT (2026-06-28) — pins the scoring function that
// reorders CardHedge candidates by parsed user intent.
//
// PRIOR-CF GAP: CH's relevance ranker buries the user's actually-intended
// variant deep in the result list. Observable: Kurtz CPA-NK Green Lava
// (an autograph + specific parallel) sat at position 35 of 50 for the
// query "nick kurtz green lava auto" — the Base auto and base BCP-114
// ranked above it even though they don't match parallel intent.
//
// THIS FILE PINS:
//   1. isAuto match scoring (user wants auto, candidate IS auto → +3;
//      user wants auto, candidate is NOT auto → -1)
//   2. Parallel-token matching (per matching token → +2)
//   3. Combined scoring favors matching BOTH dimensions over either alone
//   4. Tokens are case-insensitive, hyphen-tolerant, length-gated
//   5. Empty parallel / empty intent tokens → no parallel contribution

import { describe, expect, it } from "vitest";
import { scoreCandidateForIntent } from "../src/services/unifiedSearch/dispatcher.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE KURTZ GREEN LAVA SCENARIO — pins the bug we fixed
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCandidateForIntent — Kurtz Green Lava regression", () => {
  const intentTokens = ["nick", "kurtz", "green", "lava", "auto"];
  const intentWantsAuto = true;

  it("CPA-NK Green Lava isAuto=true → highest score (matches both dimensions)", () => {
    const score = scoreCandidateForIntent({
      isAuto: true,
      parallel: "Green Lava",
      intentTokens,
      intentWantsAuto,
    });
    // +3 (auto match) + 2×2 (green + lava tokens) = 7
    expect(score).toBe(7);
  });

  it("CPA-NK Base isAuto=true → mid score (auto only, no parallel match)", () => {
    const score = scoreCandidateForIntent({
      isAuto: true,
      parallel: "Base",
      intentTokens,
      intentWantsAuto,
    });
    // +3 (auto) + 0 (base doesn't match any intent parallel tokens) = 3
    expect(score).toBe(3);
  });

  it("BCP-114 Green Geometric isAuto=false → low (parallel partial, no auto)", () => {
    const score = scoreCandidateForIntent({
      isAuto: false,
      parallel: "Green Geometric",
      intentTokens,
      intentWantsAuto,
    });
    // -1 (no auto, user wants auto) + 2 (green matches) = 1
    expect(score).toBe(1);
  });

  it("BCP-114 Base isAuto=false → lowest (neither matches)", () => {
    const score = scoreCandidateForIntent({
      isAuto: false,
      parallel: "Base",
      intentTokens,
      intentWantsAuto,
    });
    // -1 (no auto) + 0 = -1
    expect(score).toBe(-1);
  });

  it("orders Green Lava auto above CPA-NK Base above BCP-114 Green Geometric above BCP-114 Base", () => {
    const greenLavaAuto = scoreCandidateForIntent({
      isAuto: true, parallel: "Green Lava", intentTokens, intentWantsAuto,
    });
    const cpaBase = scoreCandidateForIntent({
      isAuto: true, parallel: "Base", intentTokens, intentWantsAuto,
    });
    const bcpGreenGeo = scoreCandidateForIntent({
      isAuto: false, parallel: "Green Geometric", intentTokens, intentWantsAuto,
    });
    const bcpBase = scoreCandidateForIntent({
      isAuto: false, parallel: "Base", intentTokens, intentWantsAuto,
    });
    expect(greenLavaAuto).toBeGreaterThan(cpaBase);
    expect(cpaBase).toBeGreaterThan(bcpGreenGeo);
    expect(bcpGreenGeo).toBeGreaterThan(bcpBase);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. HAMMOND AUTO REFRACTOR — pins behavior when no perfect-match variant exists
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCandidateForIntent — Hammond auto refractor (no perfect match)", () => {
  const intentTokens = ["josh", "hammond", "auto", "refractor"];
  const intentWantsAuto = true;

  it("CPA-JH Base isAuto=true ranks higher than BDC-185 Refractor isAuto=false", () => {
    // No 'CPA-JH Refractor' exists for Hammond — both candidates partial-match.
    // The CPA auto should still beat the non-auto refractor because the user
    // wants AUTO. iOS will surface CPA-JH Base auto + BDC-185 Refractor near
    // the top so the user can pick.
    const cpaBaseAuto = scoreCandidateForIntent({
      isAuto: true, parallel: "Base", intentTokens, intentWantsAuto,
    });
    const bdcRefractor = scoreCandidateForIntent({
      isAuto: false, parallel: "Refractor", intentTokens, intentWantsAuto,
    });
    // CPA Base auto: +3 (auto) + 0 (base) = 3
    // BDC Refractor non-auto: -1 (no auto) + 2 (refractor matches) = 1
    expect(cpaBaseAuto).toBeGreaterThan(bdcRefractor);
  });

  it("imaginary CPA-* Refractor isAuto=true would rank above either alone (the perfect match case)", () => {
    const perfectMatch = scoreCandidateForIntent({
      isAuto: true, parallel: "Refractor", intentTokens, intentWantsAuto,
    });
    // +3 (auto) + 2 (refractor) = 5
    expect(perfectMatch).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. INTENT WITHOUT AUTO — isAuto signal does not penalize or bonus
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCandidateForIntent — when user did NOT type 'auto'", () => {
  const intentTokens = ["mike", "trout", "refractor"];
  const intentWantsAuto = false;

  it("auto vs non-auto candidates score the same (no auto signal in query)", () => {
    const auto = scoreCandidateForIntent({
      isAuto: true, parallel: "Refractor", intentTokens, intentWantsAuto,
    });
    const nonAuto = scoreCandidateForIntent({
      isAuto: false, parallel: "Refractor", intentTokens, intentWantsAuto,
    });
    expect(auto).toBe(nonAuto);
  });

  it("undefined isAuto (no card-number info) → still scored neutrally when query has no auto signal", () => {
    const score = scoreCandidateForIntent({
      isAuto: undefined, parallel: "Refractor", intentTokens, intentWantsAuto,
    });
    expect(score).toBe(2); // refractor token match only
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. TOKENIZATION EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCandidateForIntent — tokenization", () => {
  it("hyphenated parallel name matches hyphenated intent token", () => {
    const score = scoreCandidateForIntent({
      isAuto: true,
      parallel: "X-Fractor",
      intentTokens: ["blue", "fractor"],
      intentWantsAuto: true,
    });
    // +3 (auto) + 2 (fractor matches after hyphen normalize) = 5
    expect(score).toBe(5);
  });

  it("case insensitive", () => {
    const score = scoreCandidateForIntent({
      isAuto: false,
      parallel: "BLUE LAVA",
      intentTokens: ["blue", "lava"],
      intentWantsAuto: false,
    });
    expect(score).toBe(4);
  });

  it("short tokens (< 3 chars) in parallel are ignored", () => {
    const score = scoreCandidateForIntent({
      isAuto: false,
      parallel: "A B",
      intentTokens: ["green", "lava"],
      intentWantsAuto: false,
    });
    expect(score).toBe(0);
  });

  it("empty parallel → 0 parallel contribution", () => {
    const score = scoreCandidateForIntent({
      isAuto: true,
      parallel: null,
      intentTokens: ["green", "lava"],
      intentWantsAuto: true,
    });
    // Only auto match contributes: +3
    expect(score).toBe(3);
  });

  it("empty intent tokens → 0 parallel contribution", () => {
    const score = scoreCandidateForIntent({
      isAuto: true,
      parallel: "Green Lava",
      intentTokens: [],
      intentWantsAuto: true,
    });
    // Only auto match contributes: +3
    expect(score).toBe(3);
  });
});
