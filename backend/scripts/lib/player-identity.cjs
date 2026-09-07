"use strict";
/**
 * player-identity.cjs -- the ONE name reduction, loaded from the built tree,
 * for the ops scripts that ask "do these two rows name the same card?".
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `playerIdentityKey.ts` is already the single answer for the three call sites
 * inside `src/`, and `lib/player-evidence.cjs` already bridges it into the
 * scripts tree for arm 2's title tally. It bridged it PRIVATELY, though: the
 * loader was a const inside that module, exported only as a by-product of
 * exporting the tally. A second script needing the same reduction therefore had
 * two bad options -- require `player-evidence.cjs` (and with it Cosmos query
 * plans and a MAX_TITLES budget it does not want, plus `source-corroboration`),
 * or restate the expression and become the fourth copy `playerIdentityKey.ts`'s
 * header was written to end.
 *
 * So the loader moves here and `player-evidence.cjs` consumes it. One reduction,
 * one defensive load, and a script that only wants to compare two names does not
 * pull a query module in to get it.
 *
 * ── THE DEFECT THIS CLOSES (#1953) ──────────────────────────────────────────
 *
 * `occupiedByDifferentCard` in relocate-catalog-rows-by-list.cjs compared
 *
 *     String(r?.playerName ?? "").trim().toLowerCase()
 *
 * which is the pre-fix expression `playerIdentityKey.ts` exists to replace. On
 * the #1930 shapes it refuses pairs that are one card:
 *
 *   "Team Magma's Camerupt" vs "Team Magma’s Camerupt"   curly apostrophe
 *   "Mr. Mime"              vs "Mr Mime"                 punctuation
 *   "Flabébé"               vs "Flabebe"                 accent
 *   "Suicune ☆"             vs "Suicune Star"            identity symbol
 *   "Nidoran♀"              vs "Nidoran F"               gender symbol
 *   "Miracle Sphere α"      vs "Miracle Sphere Alpha"    Greek suffix
 *
 * #1953 resolved 138 such refusals BY HAND, reading tcgdex per pair. The lane
 * should not have needed a human for the orthographic ones. It still needs one
 * for the rest -- see the superset rule in the lane.
 *
 * ── THE DEFENSIVE LOAD, AND WHY THE FALLBACK IS THE OLD EXPRESSION ─────────
 *
 * The same contract `market-guard.cjs` and `player-evidence.cjs` have: these
 * modules are required by ops scripts whose dispatch refusals must work WITHOUT
 * a compiled tree (rekeyRetireUntwinned.test.ts loads them that way). A missing
 * `dist/` falls back to the pre-fix reduction -- which is exactly the behaviour
 * the callers had before this file, so a tree-less run is never WORSE than it
 * was, only un-improved. It is never SILENTLY better-or-worse either:
 * `identityKeyIsBuilt()` reports which one is live so a lane can say so in its
 * banner.
 */
const path = require("node:path");

let BUILT = false;

/** A player/card name reduced to the letters and digits that identify it.
 *
 *  THE SAME FUNCTION `playerKey` in sourceCorroboration.ts and `playerKeyOf` in
 *  catalogRowOps.service.ts use -- loaded from the built tree, not restated
 *  here. `playerIdentityKey.ts`'s header records the Pokemon-name defect the
 *  copies shared: accents fold to their base letter and identity-bearing
 *  symbols (☆ ♀ ♂ α β γ δ) transliterate to the token the market spells, so
 *  they survive the a-z0-9 filter instead of being deleted. */
const playerIdentityKey = (() => {
  try {
    const built = require(path.join(__dirname, "..", "..", "dist/services/catalog/playerIdentityKey.js"));
    if (typeof built.playerIdentityKey === "function") {
      BUILT = true;
      return built.playerIdentityKey;
    }
  } catch { /* fall through to the legacy reduction */ }
  return (s) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
})();

/** True when the reduction above came from the compiled tree rather than the
 *  legacy fallback. A lane prints this so an operator can tell a run that had
 *  the Pokemon transliterations from one that did not. */
function identityKeyIsBuilt() {
  return BUILT;
}

module.exports = { playerIdentityKey, identityKeyIsBuilt };
