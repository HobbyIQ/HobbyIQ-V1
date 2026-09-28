"use strict";
/**
 * title-has-name-tokens.cjs -- "does this sale's TITLE carry enough of a
 * player's name to be trusted over playerName at all?", for the title-first
 * namesAgree order in repoint-sales-by-list.cjs's GATE 6 and
 * heal-sold-comp-hobbyiqcardid-by-list.cjs's GATE (e).
 *
 * WHY THIS EXISTS (review finding, this PR). The first cut of title-first
 * treated ANY non-blank title as name-shaped -- but a large share of real
 * sold_comps titles are CardHedge/eBay-derived LISTING TEXT with no player
 * name in them at all: "2025 Topps Chrome Update Baseball #AC-NM Base" names
 * a year, a product, a card number and a parallel, and NOTHING that
 * identifies a player. `sale.playerName`, by contrast, is generally already
 * a CLEAN, extracted name field. Treating "title is non-blank" as "title
 * decides" would refuse exactly the titles this shape describes, at scale,
 * on the sale's OWN correct playerName -- the opposite of what title-first
 * is for.
 *
 * A SECOND CUT tried a fixed, hand-maintained blocklist of "not a name"
 * words (brand/finish/grade words) -- rejected on inspection: brand/product
 * vocabulary in this domain is an OPEN set (Topps, Bowman, Panini, Prizm,
 * Optic, Mosaic, Select, Donruss, Chrome, Update, Series, ...), and a title
 * like "2025 Topps Chrome Update Baseball ..." still counted "Topps",
 * "Chrome", "Update", "Baseball" as name-shaped after stripping only the
 * card-number/grade/year tokens a closed list can safely name.
 *
 * THE FIX: strip the vocabulary the CALLER already has on hand for this
 * exact destination card, rather than guessing at a universal blocklist --
 * the same discipline GATE 6's own `stripTrailingTokens` already follows
 * (namesAgree itself is product-blind; the CALLER supplies the product's own
 * words). A card_catalog row's `setKey` is a hyphenated slug whose own words
 * ARE the product's brand/line vocabulary ("topps-chrome-update-series" ->
 * topps, chrome, update, series); `sport` is the vertical word ("baseball");
 * `cardNumber` is the card's own number, which can appear in a title bare or
 * with a "#"/"No." prefix. Stripping exactly these -- plus a leading year,
 * grading tokens, and the caller's own `stripTrailingTokens` checklist-
 * parallel vocabulary (identical to what GATE 6 already builds) -- leaves a
 * title's genuine PLAYER-NAME residue, if any, and nothing else this lane
 * can already name. A residue of two or more alphabetic tokens is trusted
 * as a name; fewer than two is not, and the caller falls back to playerName.
 *
 * This is a NARROWER, more conservative test than any fixed blocklist:
 * every word it strips is a word this SPECIFIC entry's own destination
 * already told the caller is not a name (its own product's brand/line
 * words, its own sport, its own card number) -- it can never strip an
 * actual player's surname that happens to collide with some OTHER
 * product's brand word, because only THIS card's own vocabulary is used.
 */

/** A leading 4-digit year, with or without a trailing separator: "2025 ",
 *  "2025-", "2025:". */
const LEADING_YEAR_RE = /^\d{4}[\s:-]+/;

/** A card-number token: "#AC-NM", "#12", "No. 42", "No 7". Matched anywhere
 *  in the title (not just trailing) -- a card number can sit mid-title
 *  ("... #CPA-YM Auto") as in the PR #2485 incident title itself. */
const HASH_OR_NO_CARD_NUMBER_RE = /(^|\s)(#[a-z0-9-]+|no\.?\s*\d+[a-z-]*)(?=\s|$)/gi;

/** A grading token: "PSA 10", "BGS 9.5", "SGC 10", "CGC 9". */
const GRADE_TOKEN_RE = /\b(?:PSA|BGS|SGC|CGC|HGA)\s*\d+(?:\.\d+)?\b/gi;

/** Bare structural/print-attribute words universal enough across every
 *  product (never a brand/line name, never a player's own name) that they
 *  are safe to strip unconditionally -- the same closed shape namesAgree's
 *  own BARE_FAMILY_WORDS and checklist-parallel-strip-vocab.cjs already
 *  treat as strippable, restated here so this module stays self-contained
 *  (matching name-agreement.cjs's own "no dependency" contract). */
const BARE_STRUCTURAL_WORDS = new Set([
  "base", "auto", "autograph", "autographs", "refractor", "prizm", "parallel",
  "rc", "rcup", "fs", "ssp", "sp", "insert", "inserts", "rookie", "card",
]);

/** Escape a string for use inside a RegExp. */
function reEscape(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reduce a title to its ALPHABETIC-token count after stripping: a leading
 * year, card-number tokens, grade tokens, the caller's own
 * `stripTrailingTokens` vocabulary (GATE 6's checklist-parallel words), and
 * the DESTINATION CARD'S OWN vocabulary -- its `setKey`'s hyphen-split
 * words, its `sport`, and its `cardNumber` (bare, as it would appear
 * without a "#"/"No." prefix). `context` is `{ setKey, sport, cardNumber }`
 * -- every field optional; a missing one is simply not stripped, never
 * treated as an error. Returns the count, never the reduced string -- this
 * module answers a yes/no question, it does not itself decide what
 * namesAgree should compare.
 */
function alphabeticNameTokenCount(title, stripVocab, context) {
  let t = String(title ?? "").trim();
  if (!t) return 0;
  t = t.replace(LEADING_YEAR_RE, " ");
  t = t.replace(HASH_OR_NO_CARD_NUMBER_RE, " ");
  t = t.replace(GRADE_TOKEN_RE, " ");

  const vocab = Array.isArray(stripVocab) ? stripVocab.slice() : [];
  const setKey = String(context?.setKey ?? "").trim();
  if (setKey) {
    // A setKey slug's own hyphen-split words ARE this product's brand/line
    // vocabulary ("topps-chrome-update-series" -> topps, chrome, update,
    // series) -- bounded to THIS card's own product, never a universal list.
    for (const word of setKey.split(/[-_]+/)) if (word) vocab.push(word);
  }
  const sport = String(context?.sport ?? "").trim();
  if (sport) vocab.push(sport);
  const cardNumber = String(context?.cardNumber ?? "").trim();
  if (cardNumber) vocab.push(cardNumber);

  for (const phrase of vocab) {
    const escaped = reEscape(phrase);
    if (!escaped) continue;
    t = t.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }

  const tokens = t
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    // A token surviving to here counts only when it is PURELY alphabetic
    // (letters, apostrophes, hyphens WITHIN a word -- "Crow-Armstrong" is
    // one name token) and not one of the closed bare structural words.
    .filter((w) => /^[a-z][a-z'-]*$/i.test(w) && !BARE_STRUCTURAL_WORDS.has(w.toLowerCase()));
  return tokens.length;
}

/**
 * Does this title carry enough of a name to be trusted as the DECIDING
 * field, ahead of the sale's own (possibly corrupt) playerName? True iff at
 * least two alphabetic name-shaped tokens survive every strip this module,
 * the caller's own checklist-parallel vocabulary, and the destination
 * card's own (setKey/sport/cardNumber) vocabulary can apply. A caller that
 * answers `false` here falls back to playerName instead of testing the
 * title at all -- the fix for the false-refusal shape a bare
 * "title is non-blank" check produces on real CardHedge/eBay listing titles
 * that carry no player name whatsoever, e.g. "2025 Topps Chrome Update
 * Baseball #AC-NM Base" (setKey "topps-chrome-update-series", sport
 * "baseball", cardNumber "AC-NM" all strip, leaving zero alphabetic tokens).
 */
function titleHasNameTokens(title, stripVocab, context) {
  return alphabeticNameTokenCount(title, stripVocab, context) >= 2;
}

module.exports = { titleHasNameTokens, alphabeticNameTokenCount };
