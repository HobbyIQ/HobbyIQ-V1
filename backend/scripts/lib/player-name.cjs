"use strict";
/**
 * player-name.cjs -- the ONE playerName cleaner, loaded from the built tree,
 * for ops scripts (scrapers, backfills) that ask "what does this checklist
 * cell's player text actually say?" outside of a guaranteed-dist context.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * cleanPlayerName (src/services/portfolioiq/cardCatalog.service.ts) is
 * already the single answer -- it strips the generational-suffix comma
 * ("Bobby Witt, Jr." -> "Bobby Witt Jr.") and, since #2294, the RC-family
 * rookie marker ("Jonah Tong RC" -> "Jonah Tong"). Two scrapers restated it
 * as their own local `function cleanPlayerName(raw)` instead of importing
 * it: scrape-baseballcardpedia.cjs and scrape-tcdb.cjs, both CLI scripts
 * that run standalone (BCP_URL / TCDB_URL env, no guaranteed dist/ build)
 * rather than through the backfill runner's dist-built environment.
 *
 * #2294's own census found this while tracing every mint path to
 * `playerSlug`: a fixed canonical cleanPlayerName does nothing for a caller
 * that never calls it, and a third/fourth hand-copy of the same regex is
 * exactly the shape catalogAuthority's own header warns about --  five call
 * sites answering one question five ways flipped 51 card-number prefixes.
 * player-identity.cjs already set the precedent for this exact shape
 * (playerIdentityKey, bridged for scripts that cannot assume a built tree);
 * this file is the same bridge for cleanPlayerName.
 *
 * ── THE DEFENSIVE LOAD, AND WHY THE FALLBACK IS EACH SCRAPER'S OLD LOCAL RULE
 *
 * A missing `dist/` falls back to a name-cleaning rule that only trims
 * trailing metadata Beckett writes -- documented per call site below, not
 * restated as a NEW third rule. `identityKeyIsBuilt` (this file's own
 * `built()`) reports which one is live so a scraper can say so in its
 * output, the same contract player-identity.cjs keeps for playerIdentityKey.
 */
const path = require("node:path");

let BUILT = false;

/** cleanPlayerName, loaded from the built tree; falls back to a no-op
 *  (returns the trimmed input unchanged) when dist/ is not built. A
 *  no-op fallback is deliberate here, not "the old local rule": the two
 *  scrapers that use this bridge each had a DIFFERENT local rule (one also
 *  stripped a trailing parenthesised group, the other stripped a leading
 *  hyphen), and restating either one here would make this file a third
 *  implementation instead of the shared bridge it exists to be. A caller
 *  that wants its own trailing-metadata cleanup keeps doing that itself,
 *  in addition to calling this bridge for the RC/comma-suffix cases. */
const cleanPlayerName = (() => {
  try {
    const built = require(path.join(__dirname, "..", "..", "dist/services/portfolioiq/cardCatalog.service.js"));
    if (typeof built.cleanPlayerName === "function") {
      BUILT = true;
      return built.cleanPlayerName;
    }
  } catch { /* fall through to the no-op below */ }
  return (raw) => String(raw ?? "").trim();
})();

/** True when the reduction above came from the compiled tree rather than the
 *  no-op fallback. A caller prints this so an operator can tell a run that
 *  had the RC-marker / generational-suffix cleanup from one that did not. */
function cleanPlayerNameIsBuilt() {
  return BUILT;
}

module.exports = { cleanPlayerName, cleanPlayerNameIsBuilt };
