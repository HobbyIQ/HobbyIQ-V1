"use strict";
/**
 * checklist-parallel-strip-vocab.cjs -- a namesAgree() `stripTrailingTokens`
 * vocabulary builder for heal-sold-comp-hobbyiqcardid-by-list.cjs's own
 * title-first GATE (e) (this PR).
 *
 * WHY THIS EXISTS (this PR's own review finding). GATE (e)'s title-first fix
 * reads the sale's TITLE before its (possibly corrupt) playerName -- but a
 * real listing title is not name-shaped on its own: "Allan Castro Blue
 * Refractor Auto" does not bare-match the checklist's own "Allan Castro"
 * without stripping the trailing print-attribute words. This lane's own
 * committed list (2,022 real sales, #2485 census,
 * data/sold-comp-hobbyiqcardid-heals/2026-09-28-cpa-2024-bowman-chrome-stale
 * -hobbyiqcardid.json) carries exactly this shape, so running title-first
 * namesAgree with NO strip support would mass-refuse real, correct heals the
 * moment this fix ships -- a regression this builder exists to prevent.
 *
 * Modeled on repoint-sales-by-list.cjs's own GATE 6 vocabulary builder
 * (CF-A-PARALLEL-WORD-IS-NOT-A-PLAYER-NAME, USC143 run 36346769892) --
 * deliberately a SEPARATE module, not a shared one, so this file's own
 * addition of "Auto"/"Autograph" to the bare-strippable word list (this
 * lane's real titles carry it; repoint-sales-by-list.cjs's shipped, reviewed
 * vocabulary does not need it and is left byte-for-byte unchanged by this
 * PR) cannot silently widen the sibling lane's own already-shipped gate.
 *
 * `namesAgree` itself stays product-blind on purpose (see its own header,
 * "no hardcoded colours") -- this builder reads the DESTINATION product's
 * own checklist parallel vocabulary from the committed checklist corpus via
 * `checklistParallelNamesFor`, never a fixed list of our own.
 */
const { checklistParallelNamesFor } = require("./rematch-finish-vocab.cjs");

/** "<Colour> Refractor" / "<Colour> Prizm" -- the colour word alone is also
 *  strippable, so "Blue" folds even though the sale never wrote "Refractor".
 *  Matched against the CHECKLIST's own listed names, never a fixed colour
 *  list of our own -- a word only earns strip eligibility by being the FIRST
 *  word of one of THIS product's own "<Colour> <Family>" rungs. */
const COLOUR_PREFIX_FAMILY_RE = /^([a-z][a-z'-]*)\s+(refractor|prizm)s?$/i;

/** Bare family/print-attribute words this lane's own real titles carry that
 *  a sale's title can leave dangling with no colour in front of them
 *  ("Allan Castro Blue Refractor Auto"). Not a colour list -- these are
 *  finish/format/print-attribute WORDS themselves, always strippable once
 *  the destination is checklist-grade (this lane's own gate (d) already
 *  proved that before this vocabulary is ever built). "Auto"/"Autograph(s)"
 *  name a PRINT ATTRIBUTE (autographed or not), never a player's own name,
 *  so stripping them can never fold two different players together. */
const BARE_FAMILY_WORDS = ["Refractor", "Prizm", "Parallel", "Auto", "Autograph", "Autographs"];

const _cache = new Map();

/**
 * The `stripTrailingTokens` list for a namesAgree() call against `catalogRow`
 * (the destination card_catalog row), plus a `{ size, setKey }` detail for a
 * caller's own banner line. Returns `{ tokens: [], size: 0, setKey }` when
 * the product has no checklist parallel vocabulary (corpus miss, or a
 * setKey/year the corpus does not cover) -- namesAgree with an empty list
 * behaves exactly as it did before this builder existed, so a corpus miss
 * never widens or narrows the gate on its own.
 *
 * Built once per (year, setKey) and cached across calls in this process -- a
 * list can repeat the same destination across many entries, and the corpus
 * read + colour scan is wasted work to repeat per entry.
 */
function stripVocabularyForDestination(catalogRow) {
  const year = catalogRow?.year ?? catalogRow?.cardYear ?? null;
  const setKey = String(catalogRow?.setKey ?? "").trim();
  const cacheKey = `${year}|${setKey.toLowerCase()}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const names = setKey ? checklistParallelNamesFor(year, setKey) : null;
  const tokens = new Set();
  if (names) {
    for (const name of names) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) continue;
      // The whole listed name ("Blue Refractor") strips as one phrase...
      tokens.add(trimmed);
      // ...and, when it is a "<Colour> Refractor"/"<Colour> Prizm" rung, the
      // colour word ALONE also strips -- this is what lets "Blue" fold when
      // the title's own extraction dropped "Refractor" but kept the colour.
      const m = trimmed.match(COLOUR_PREFIX_FAMILY_RE);
      if (m) tokens.add(m[1]);
    }
  }
  for (const w of BARE_FAMILY_WORDS) tokens.add(w);

  const result = { tokens: [...tokens], size: names ? names.size : 0, setKey };
  _cache.set(cacheKey, result);
  return result;
}

module.exports = { stripVocabularyForDestination, COLOUR_PREFIX_FAMILY_RE, BARE_FAMILY_WORDS };
