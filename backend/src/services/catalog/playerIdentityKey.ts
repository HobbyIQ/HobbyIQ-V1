import { cleanPlayerName } from "../portfolioiq/cardCatalog.service.js";

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
 *
 * ── A ROOKIE MARKER IS NOT A DIFFERENT PLAYER (2026-09-19) ──────────────────
 *
 * #2294 fixed cleanPlayerName so the catalog stops MINTING "jonah-tong-rc" as
 * a playerSlug, but the fold lane runs on the STORED playerName field, and
 * every row minted before that fix -- and every row this reduction is ever
 * asked to compare against one of them -- still carries the raw checklist
 * text with " RC" attached. Before this change, playerIdentityKey("Jonah
 * Tong RC") -> "jonahtongrc" and playerIdentityKey("Jonah Tong") ->
 * "jonahtong": DIFFERENT KEYS, so the survivor rule in catalogRowOps.service
 * (CF-A-FOLD-NEVER-CHANGES-THE-PLAYER) read the RC row and its clean sibling
 * at the same card number as two different players and either arbitrated a
 * survivor by corroboration/sale-title evidence that had nothing to do with
 * the real question, or REFUSED the pair outright with neither side
 * corroborated. RC-suffixed rows are, by construction, rookies, so this was
 * concentrated damage on exactly the population where a fold decision matters
 * most.
 *
 * The fix: reduce through cleanPlayerName FIRST, on the ORIGINAL-CASE string
 * -- before this function's own lowercasing, because cleanPlayerName's RC
 * strip is deliberately case-sensitive (an already-lowercased "jonah tong rc"
 * would never match it). cleanPlayerName only touches the RC family (" RC",
 * " RC*", " (RC)") and the pre-existing generational-suffix comma case; every
 * other input passes through unchanged, so this is additive in exactly the
 * same sense the symbol transliterations above are: a name cleanPlayerName
 * does not touch reduces exactly as it did before.
 *
 * RULING R72 (owner, 2026-09-19) EXTENDS cleanPlayerName'S SCOPE, AND THIS
 * REDUCTION INHERITS IT UNCHANGED. cleanPlayerName now also strips RR, DP,
 * TC, UER, SP, SSP and a tier letter directly before an RC-family marker --
 * see that function's header in cardCatalog.service.ts for the full ruling.
 * Because this file reduces through cleanPlayerName first, a pair like
 * "Jonah Tong SP" / "Jonah Tong" or "New York Yankees TC" / "New York
 * Yankees" now folds onto ONE playerIdentityKey, exactly the way the RC
 * family already did.
 *
 * THIS IS STILL ONLY A VETO, NEVER A MERGE TRIGGER -- read carefully, because
 * "the keys are now equal" sounds like "the rows now merge" and it is NOT
 * that. The one and only place this key decides anything is
 * catalogRowOps.service.ts's `arbitratePlayer` (playerKeyOf = this function,
 * aliased at that file's own "const playerKeyOf = playerIdentityKey;"): at
 * catalogRowOps.service.ts:838, `if (!keyIn || !keyInc || keyIn === keyInc)
 * return { kind: "not-a-conflict" };`. When the keys are EQUAL, the function
 * returns "not-a-conflict" and arbitratePlayer's own contradiction logic
 * (corroboration / sale-title tally / refuse-by-name) simply never runs --
 * it does not cause chooseSurvivor (catalogRowOps.service.ts:935) to pick a
 * survivor or write anything. chooseSurvivor's ACTUAL merge decision runs on
 * source authority, vendorIds, sales count and confidence
 * (catalogRowOps.service.ts:942-977), all upstream of and independent of this
 * key; the two rows being compared were already going to be evaluated as
 * candidates for the SAME address (same slug/id) by the caller before either
 * function is reached. A different playerIdentityKey is what makes
 * arbitratePlayer FIRE and potentially REFUSE the pair (or arbitrate a
 * winner) instead of falling through to the ordinary ladder; an equal key
 * only removes that veto's objection -- it supplies no merge logic of its
 * own. So R72 stripping SP/SSP/UER from the compared NAME cannot, by itself,
 * cause two rows to be folded that would not already have collided on
 * address; it can only stop this ONE guard from blocking a fold the address
 * collision and the ladder were already going to decide. SP/SSP/UER can still
 * name a genuinely different CARD (a short-print or error variation) --
 * that identity question is NOT this file's job and was never decided by
 * playerName equality; it is why the repair lane
 * (repair-rc-marker-playername.cjs) lists every SP/SSP/UER row for a human
 * instead of trusting the cleaned name as proof of anything by itself.
 *
 * RR/DP/TC/tier-letter rows fold the same way and carry no such caveat --
 * RC/RR/DP/TC never name a different card at the same number, only a
 * different FACT about the same person's card, which is exactly what
 * cleanPlayerName's header states.
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
 * are one card; "Suicune ☆" and "Suicune" are NOT; "Jonah Tong RC" and
 * "Jonah Tong" are the same rookie, not two different players. See the header.
 */
export function playerIdentityKey(name: unknown): string {
  // cleanPlayerName's RC-family strip is case-sensitive and must see the
  // ORIGINAL casing -- run it before this function's own toLowerCase(), on
  // the untrimmed original (cleanPlayerName trims internally). A name it does
  // not touch (no RC/RC*/(RC), no generational-suffix comma) comes back
  // byte-identical, so this is a strict narrowing of what reduces together,
  // never a widening.
  let s = cleanPlayerName(String(name ?? "")).trim().toLowerCase();
  if (!s) return "";
  for (const [re, to] of IDENTITY_SYMBOLS) s = s.replace(re, to);
  // Accents fold to their base letter rather than being deleted: NFD splits
  // "é" into "e" + a combining mark, and the mark is what gets filtered.
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return s.replace(/[^a-z0-9]/g, "");
}
