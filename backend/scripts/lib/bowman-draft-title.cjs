"use strict";
/**
 * bowman-draft-title.cjs -- the CJS door onto the ONE "does this title spell
 * the Bowman DRAFT product?" predicate.
 *
 * CF-BOWMAN-CHROME-DRAFT-KEEPS-DRAFT (Drew, 2026-09-06, #1911 then #1912).
 * The rule and all of its reasoning live in
 * `src/services/portfolioiq/parseTitleIdentity.service.ts`
 * (`titleSpellsBowmanDraft`); this file adds NOTHING to it and deliberately
 * re-implements NOTHING of it.
 *
 * WHY A BRIDGE AND NOT A COPY. #1911 fixed the parser so a title that says
 * DRAFT reads as a Bowman Draft card in both word orders. #1912 needs the
 * SAME question answered one layer up: the rematch classifier will only let
 * the ladder move a sale off a `bowman-chrome` slug onto `bowman-draft` when
 * the title SPELLS the Draft product. That is one question, and a second copy
 * of its regex would be free to drift by a word -- which here means moving
 * real sales between two products' comp pools, and on a colliding card number
 * onto another PERSON's card (cpa-dt is Diego Tornes in bowman-chrome and
 * Devin Taylor in bowman-draft). `catalogAuthority.service.ts`'s header
 * records what that costs when it has already happened.
 *
 * This is the same seam, and the same solution, as `source-corroboration.cjs`:
 * the scripts are CJS, the service is ESM-TypeScript, and the bridge requires
 * the COMPILED build rather than keeping a local copy of the rule.
 *
 * REQUIRES dist/. A script that loads this needs `npm run build` to have run --
 * the same precondition the other bridges carry, and the same failure mode (a
 * clear error naming the missing build) rather than a silent fallback to a
 * stale copy.
 */
const path = require("path");

const dist = path.resolve(
  __dirname, "..", "..", "dist", "services", "portfolioiq", "parseTitleIdentity.service.js",
);

let mod;
try {
  mod = require(dist);
} catch (e) {
  const err = new Error(
    `bowman-draft-title.cjs: could not load ${dist} -- run \`npm run build\` in backend/.\n` +
    `  The "title spells Bowman Draft" rule has exactly one definition\n` +
    `  (src/services/portfolioiq/parseTitleIdentity.service.ts: titleSpellsBowmanDraft)\n` +
    `  and this file refuses to keep a second copy of it. Original: ${String((e && e.message) || e).slice(0, 200)}`,
  );
  err.code = "BOWMAN_DRAFT_TITLE_BUILD_MISSING";
  throw err;
}

if (typeof mod.titleSpellsBowmanDraft !== "function") {
  const err = new Error(
    `bowman-draft-title.cjs: ${dist} exports no titleSpellsBowmanDraft -- the build is stale.`,
  );
  err.code = "BOWMAN_DRAFT_TITLE_BUILD_STALE";
  throw err;
}

module.exports = { titleSpellsBowmanDraft: mod.titleSpellsBowmanDraft };
