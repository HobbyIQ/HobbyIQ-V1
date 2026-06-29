// CF-AUTO-INTENT-SEARCH-FILTER (2026-06-29) — pins the dispatcher's
// search-query composition for auto-intent queries. The dispatcher
// strips the user query down to just the player name when structured
// filters are present (CF-CH-SEARCH-MINIMAL-WHEN-FILTERED, for
// parallel-noise reduction). For auto-intent queries that same strip
// removes the auto signal entirely — CH then ranks the candidate pool
// by trade volume, which favors BASE INSERTS over autographs (CPA-XX
// sat below 50 base inserts for "Bryce Harper 2011 Bowman Chrome
// Prospect Auto" in the 2026-06-29 volume test).
//
// THIS CF: when intentWantsAuto AND structured filters present, append
// "autograph" to the search string so CH's relevance ranker biases the
// pool toward autograph SKUs. PR #178's matcher-rejection + rerank are
// the authoritative auto check; this CF only widens the pool that
// rerank operates on.
//
// THIS FILE PINS:
//   1. intentWantsAuto + filters + playerName → "Player autograph"
//   2. intentWantsAuto + NO filters → hyphen-stripped raw (autograph
//      word already in query, no transformation needed)
//   3. NO intentWantsAuto + filters → bare player name (unchanged
//      pre-CF behavior — parallel-noise reduction preserved)
//   4. NO intentWantsAuto + NO filters → hyphen-stripped raw
//
// Mirror pattern matches queryHyphenNormalize.test.ts —
// the dispatcher's app-import chain is heavy and not required for
// a pure-predicate test.

import { describe, expect, it } from "vitest";

/**
 * Mirror of the chSearchQuery composition in dispatcher.ts
 * dispatchFreetextMode. Inputs are the same locals the dispatcher
 * computes upstream.
 */
function composeChSearchQuery(opts: {
  hyphenStripped: string;
  filters: { player?: string | null } | undefined;
  playerName: string | null;
  intentWantsAuto: boolean;
  sanitizePlayerForCH: (s: string) => string;
}): string {
  const baseSearchQuery =
    opts.filters && opts.playerName
      ? opts.sanitizePlayerForCH(opts.playerName)
      : opts.hyphenStripped;
  return opts.intentWantsAuto && opts.filters && opts.playerName
    ? `${baseSearchQuery} autograph`
    : baseSearchQuery;
}

const identity = (s: string) => s;

describe("CF-AUTO-INTENT-SEARCH-FILTER — chSearchQuery composition", () => {
  it("intentWantsAuto + filters + playerName → 'Player autograph'", () => {
    const q = composeChSearchQuery({
      hyphenStripped: "bryce harper 2011 bowman chrome prospect auto",
      filters: { player: "Bryce Harper" },
      playerName: "Bryce Harper",
      intentWantsAuto: true,
      sanitizePlayerForCH: identity,
    });
    expect(q).toBe("Bryce Harper autograph");
  });

  it("NO intentWantsAuto + filters + playerName → bare player (parallel-noise reduction preserved)", () => {
    const q = composeChSearchQuery({
      hyphenStripped: "drake baldwin 2025 bowman chrome image variation",
      filters: { player: "Drake Baldwin" },
      playerName: "Drake Baldwin",
      intentWantsAuto: false,
      sanitizePlayerForCH: identity,
    });
    expect(q).toBe("Drake Baldwin");
  });

  it("intentWantsAuto + NO filters → hyphen-stripped raw (no transformation, autograph already in text)", () => {
    const q = composeChSearchQuery({
      hyphenStripped: "kurtz green lava auto",
      filters: undefined,
      playerName: null,
      intentWantsAuto: true,
      sanitizePlayerForCH: identity,
    });
    expect(q).toBe("kurtz green lava auto");
  });

  it("NO intentWantsAuto + NO filters → hyphen-stripped raw", () => {
    const q = composeChSearchQuery({
      hyphenStripped: "eric hartman blue x fractor",
      filters: undefined,
      playerName: null,
      intentWantsAuto: false,
      sanitizePlayerForCH: identity,
    });
    expect(q).toBe("eric hartman blue x fractor");
  });

  it("intentWantsAuto + filters but playerName missing → hyphen-stripped raw (no widening without player to anchor)", () => {
    // Edge: parser confidence cleared the filter floor but didn't extract
    // a clean playerName. The narrow-search branch can't fire (no player
    // to use), so fall through to the raw query — which already contains
    // the auto signal.
    const q = composeChSearchQuery({
      hyphenStripped: "2024 topps chrome auto serial 99",
      filters: { player: null },
      playerName: null,
      intentWantsAuto: true,
      sanitizePlayerForCH: identity,
    });
    expect(q).toBe("2024 topps chrome auto serial 99");
  });

  it("sanitizePlayerForCH is applied to the player name segment", () => {
    // Verify that the sanitizer hook is preserved — a polluted parser
    // result (e.g., "Bryce Harper Prospect") should be cleaned before
    // hitting CH, matching the CF-CH-SANITIZE-PLAYER-FILTER contract.
    const q = composeChSearchQuery({
      hyphenStripped: "bryce harper prospect auto",
      filters: { player: "Bryce Harper Prospect" },
      playerName: "Bryce Harper Prospect",
      intentWantsAuto: true,
      sanitizePlayerForCH: (s) => s.replace(/\s+Prospect$/i, ""),
    });
    expect(q).toBe("Bryce Harper autograph");
  });
});
