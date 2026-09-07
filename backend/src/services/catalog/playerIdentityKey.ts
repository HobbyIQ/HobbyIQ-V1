/**
 * playerIdentityKey.ts -- the ONE reduction that decides whether two catalog
 * rows name the same card.
 *
 * CF-A-FOLD-NEVER-CHANGES-THE-PLAYER depends on a single question: are these
 * two `playerName` strings the same person or card? Three call sites answered
 * it, each with its own copy of the same expression:
 *
 *   catalogRowOps.service.ts   playerKeyOf   (the survivor rule's own compare)
 *   sourceCorroboration.ts     playerKey     (arm 1's rival compare)
 *   scripts/lib/player-evidence.cjs playerKeyOf (arm 2's title tally)
 *
 * All three carried the comment that the other two "must agree" with them --
 * which is the tell that nothing made them. `catalogAuthority`'s header records
 * what that shape costs: five call sites answering one question five ways
 * flipped 51 card-number prefixes. This file is the single answer; the three
 * sites now import it.
 *
 * ── THE DEFECT THE COPIES SHARED ────────────────────────────────────────────
 *
 * `replace(/[^a-z0-9]/g, "")` DELETES every character outside a-z0-9. On Latin
 * sports names that is exactly right: "T.J. Hockenson" and "TJ Hockenson" are
 * one person and the punctuation is noise. On Pokemon names the same expression
 * deletes the character that IS the card. Measured on the 2026-09-07 report
 * runs of the English Pokemon re-key (rekey-product-setkey MODE=catalog):
 *
 *   pokemon/2003 skyridge -> ecard3, run 34074108822, 7 pairs REFUSED:
 *     "Miracle Sphere α"  -> "miraclesphere"   ── all three reduce to
 *     "Miracle Sphere β"  -> "miraclesphere"   ── ONE key: three distinct
 *     "Miracle Sphere γ"  -> "miraclesphere"   ── cards, one identity
 *     and their own English spellings "Miracle Sphere Alpha"/"Beta"/"Gamma"
 *     reduce to `miraclespherealpha` etc, so a card does not even match ITSELF
 *     across two transcriptions. The market's titles say "Miracle Sphere A"
 *     (x24), matching NEITHER side -- so both arms scored 0 and the pair
 *     refused for a purely orthographic reason.
 *
 *   pokemon/2005 unseen-forces -> ex10, run 34074070785:
 *     "Suicune ☆" -> "suicune". The Pokemon Star is a distinct secret-rare
 *     card and the star is the only thing distinguishing it from the ordinary
 *     Suicune. Deleting it makes a card its own different card's twin.
 *
 * Two failure modes, opposite directions, one cause:
 *
 *   FALSE SPLIT   the same card under two spellings gets two keys, so a fold
 *                 that should resolve refuses (the 7 skyridge pairs).
 *   FALSE MERGE   two DIFFERENT cards get one key, so the rule never sees the
 *                 conflict at all and the ordinary ladder silently folds one
 *                 card onto another (Suicune ☆ / Suicune, Nidoran♀ / Nidoran♂).
 *
 * The false merge is the dangerous one. A refusal is a pair a human settles; a
 * silent fold is a pool with two cards' sales in it and no record that it
 * happened.
 *
 * ── THE FIX: TRANSLITERATE WHAT MEANS SOMETHING, DELETE ONLY NOISE ──────────
 *
 * Before the a-z0-9 filter runs, two things happen:
 *
 *   1. ACCENTS FOLD TO THEIR BASE LETTER, via NFD + combining-mark strip.
 *      "Flabébé" -> "flabebe", not "flabb". This is what the old expression
 *      was already TRYING to do for punctuation and simply could not do for
 *      letters, because a combining mark is not in a-z0-9 and neither is é.
 *      It makes "Pokémon" and "Pokemon" one word, which they are.
 *
 *   2. IDENTITY-BEARING SYMBOLS BECOME LETTERS. A symbol that distinguishes
 *      one printed card from another is transliterated to the token the
 *      market itself uses for it, so it survives the filter:
 *
 *        ☆ ★ -> "star"    the Pokemon Star secret rares (Suicune ☆)
 *        ♀   -> "f"       Nidoran♀, and "Nidoran F" is the common spelling
 *        ♂   -> "m"       Nidoran♂
 *        α β γ δ -> "alpha"/"beta"/"gamma"/"delta"   the e-Card Greek suffixes
 *        δ also appears as the "delta species" marker on ex Holon rows
 *
 *      The right-hand sides are chosen to match the ENGLISH spelling the same
 *      card carries in its other transcription -- that is the whole point:
 *      "Miracle Sphere α" and "Miracle Sphere Alpha" must land on one key.
 *
 * WHAT IS DELIBERATELY NOT TRANSLITERATED. Everything else still falls to the
 * a-z0-9 filter, unchanged: hyphens, apostrophes, periods, colons, spaces and
 * the em dash are noise between two spellings of one name and always were.
 * `Porygon-Z` / `Porygon Z` and `Farfetch'd` / `Farfetchd` keep merging exactly
 * as before. This change is ADDITIVE at the character level -- it moves
 * characters from "deleted" to "spelled out", and moves none the other way.
 *
 * ── WHAT THIS DOES NOT DECIDE ───────────────────────────────────────────────
 *
 * A SUFFIX IS NOT AN ACCENT. "Charizard" vs "Charizard ex", "M Venusaur" vs
 * "M Venusaur EX", "Flying Pikachu" vs "Flying Pikachu V" still produce
 * DIFFERENT keys, and that is correct here: whether the bare row is a truncated
 * transcription of the EX card or a genuinely different card at the same number
 * is a question about the product's checklist, not about orthography, and this
 * file has no checklist. Those pairs stay contended and are settled by the arms
 * -- the market titles answer them -- or refused for a human. Folding them by
 * string rule would be exactly the "right guard, wrong scope" error.
 */

/** Symbols that carry card identity, mapped to the English token the same card
 *  carries in its other transcription. Applied BEFORE the a-z0-9 filter, so the
 *  replacement survives it. Keys are matched literally, longest first is not
 *  needed -- every key is a single character. */
const IDENTITY_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = [
  // The Pokemon Star secret rares: "Suicune ☆" is not "Suicune".
  [/[☆★]/g, " star "],
  // Nidoran comes in two species that differ only by the gender symbol, and
  // the market spells them "Nidoran F" / "Nidoran M".
  [/♀/g, " f "],
  [/♂/g, " m "],
  // The e-Card Greek suffixes, and the delta-species marker. The English
  // transcription of the same card spells them out.
  [/α/g, " alpha "],
  [/β/g, " beta "],
  [/γ/g, " gamma "],
  [/δ/g, " delta "],
];

/**
 * A player/card name reduced to the letters and digits that identify it.
 *
 * "T.J. Hockenson" and "TJ Hockenson" are one person; "Flabébé" and "Flabebe"
 * are one card; "Suicune ☆" and "Suicune" are NOT. See the header.
 */
export function playerIdentityKey(name: unknown): string {
  let s = String(name ?? "").trim().toLowerCase();
  if (!s) return "";
  for (const [re, to] of IDENTITY_SYMBOLS) s = s.replace(re, to);
  // Accents fold to their base letter rather than being deleted: NFD splits
  // "é" into "e" + a combining mark, and the mark is what gets filtered.
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return s.replace(/[^a-z0-9]/g, "");
}
