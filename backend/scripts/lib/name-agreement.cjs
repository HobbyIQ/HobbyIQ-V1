"use strict";
/**
 * name-agreement.cjs -- a narrow, pair-level "do these two name-shapes agree"
 * check for `rekey-product-setkey`'s different-player refusal ONLY.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Run 35638061024 (baseball 2025, topps-series-1/topps-series-2 -> topps)
 * refused 127 catalog pairs as "different player, neither corroborated". A
 * diagnosis against that run's own log classified every one of the 127 as
 * name-SHAPE noise, none a genuinely different player:
 *
 *   ~55%  multi-player league-leader / insert cards: the incumbent reads
 *         "Shohei Ohtani / Marcell Ozuna / Kyle Schwarber LL NL HR" and the
 *         incoming row (or the reverse) reads the bare "Shohei Ohtani" --
 *         the FIRST-listed name on a card that, by construction of this run,
 *         is the SAME card number on both sides.
 *   ~30%  a subset tag on the same player: "Joey Ortiz RCup" vs "Joey Ortiz",
 *         "Ceddanne Rafaela FS" vs "Ceddanne Rafaela", 'Carlos Correa "Say
 *         Cheese!"' vs "Carlos Correa".
 *   ~15%  Jr./Sr. presence: "Vladimir Guerrero Jr." vs "Vladimir Guerrero",
 *         "Nacho Alvarez Jr." vs "Nacho Alvarez".
 *
 * `playerIdentityKey.ts` (the reduction `arbitratePlayer`'s conflict-or-not
 * gate already runs) is the wrong place to fix this. It answers "is this ONE
 * name's spelling the same", by design symmetric and applied to each side in
 * isolation -- exactly right for "Jonah Tong RC" == "Jonah Tong", exactly
 * wrong for "Shohei Ohtani" vs "Shohei Ohtani / Marcell Ozuna / Kyle
 * Schwarber LL NL HR", where the two sides are not two spellings of one name
 * at all, they are a bare name and a MULTI-PLAYER CARD naming three people.
 * Folding that through one name's own reduction would either merge Marcell
 * Ozuna and Kyle Schwarber into "the same person" (a false merge silently
 * pooling three different players' sales) or never match at all (today's
 * refusal). This module answers a different, PAIR-level question -- "given
 * both sides as they actually are, is disagreement real or a name-shape
 * artefact" -- and stays out of playerIdentityKey's job entirely.
 *
 * ── THE FOUR RULES, IN THE ORDER THEY ARE APPLIED ───────────────────────────
 *
 * (a) MULTI-NAME FIRST-LISTED MATCH. One side splits on " / " into more than
 *     one name; that side's FIRST-listed name is compared against the OTHER
 *     side (which must be a single name) under rules (b)-(d). This is safe
 *     ONLY because of how this lane calls it: both sides are already known to
 *     be the SAME card number (the pair was assembled from one address), so a
 *     multi-name entry is one printed card naming several players together
 *     (a league-leader trio, an insert duo), not several different cards. A
 *     multi-name side whose FIRST name does not match the single-name side
 *     still DISAGREES -- being named second or third on the card is not being
 *     named first, and this rule does not search the rest of the list.
 *
 * (b) SUBSET-TAG STRIP. A CLOSED vocabulary, not "drop the last word": the
 *     trailing rookie/subset markers actually seen in the 127 refusals
 *     (RCup, FS), quoted subset names actually seen ("Say Cheese!", "It Takes
 *     Two", "All Smiles", "Let's Dance!", "Bronx Bombers II", "Hoop Dreams",
 *     "Incoming!"), and the league-leader suffix shape `LL (AL|NL)
 *     (HR|RBI|ERA|W|AVG)`. A word this list does not name is left exactly as
 *     printed -- "Juan Soto" does not become "Juan" because "Soto" is not on
 *     the list.
 *
 * (c) GENERATIONAL SUFFIX: PRESENCE-VS-ABSENCE ONLY, NEVER SUFFIX-VS-SUFFIX.
 *     A generational suffix present on ONE side and absent on the other is
 *     not a different person: "Bobby Witt Jr." and "Bobby Witt" (this run's
 *     own shape) are the same rookie under two spellings. But Jr. and Sr. are
 *     the SAME family's two DIFFERENT, distinct, simultaneously-carded people
 *     -- Ken Griffey Jr. and Ken Griffey Sr., Cal Ripken Jr. and Cal Ripken
 *     Sr., Vladimir Guerrero Jr. and Vladimir Guerrero Sr., and likewise
 *     Bonds/Fielder/Alomar/Tatis/Witt, all of whom have their own cards. So
 *     the suffix is extracted from EACH side separately (not blindly
 *     stripped from both), and the two extracted tokens are compared:
 *     BOTH BLANK, or ONE BLANK AND ONE PRESENT -> agree (rule fires as
 *     before); BOTH PRESENT AND EQUAL (Jr. == Jr.) -> agree; BOTH PRESENT AND
 *     DIFFERENT (Jr. vs Sr., II vs III, Jr. vs II) -> DISAGREE, and this rule
 *     refuses the whole pair regardless of what the rest of the name does.
 *     This is the one place in this file a match can turn a "would otherwise
 *     agree" pair back into a refusal -- see `suffixesCompatible` below.
 *
 * (d) CASE / PUNCTUATION / DIACRITIC INSENSITIVE. "José" == "Jose". Applied
 *     LAST, after (b) has already removed the subset tag's own punctuation
 *     (quotes, "!", "."), so accented letters inside a PLAYER'S name (not a
 *     tag) are what this step folds.
 *
 * Anything still unequal after all four keeps refusing -- exactly the
 * fail-safe `player-evidence.cjs` documents for its own gathering: this module
 * only ever turns a refusal INTO an agreement, never the other way.
 *
 * ── WHERE THIS IS WIRED, AND WHERE IT IS NOT ────────────────────────────────
 *
 * ONLY the different-player decision in `rekey-product-setkey` (MODE=catalog,
 * via its own `contended` gate and via `arbitratePlayer`'s conflict gate in
 * `catalogRowOps.service.ts`, mirrored per the `pokemonFinishFromTitle.ts`
 * pattern -- `src/` does not depend on `scripts/`). MODE=pool has no
 * different-player check today (it moves sales by segment surgery and never
 * compares playerName), so there is nothing to wire there. This module is
 * NEVER consulted by `parseTitleIdentity`, `hobbyIqCardId`, or any I9 stamp
 * input -- it decides nothing about what a row's OWN playerName field is, only
 * whether two ALREADY-STORED playerName strings, compared as a pair, describe
 * an agreement or a real disagreement.
 *
 * ── SELF-CONTAINED ───────────────────────────────────────────────────────────
 *
 * No `require` of anything outside this file (no dist/, no other scripts/lib
 * module) -- callers with no compiled tree can still load it, the same
 * contract `market-guard.cjs` and `player-identity.cjs` state for themselves.
 */

/** Trailing subset/rookie markers seen in the diagnosed run, closed list.
 *  Matched case-insensitively at the END of the (already trimmed) name. */
const TRAILING_SUBSET_MARKERS = [/\s+RCup$/i, /\s+FS$/i];

/** League-leader suffix: "LL AL HR", "LL NL ERA", etc. -- league then stat. */
const LEAGUE_LEADER_SUFFIX = /\s+LL\s+(?:AL|NL)\s+(?:HR|RBI|ERA|W|AVG)$/i;

/** Quoted subset/insert names actually seen in the 127 refusals. Matched as a
 *  trailing quoted segment so "Elly De La Cruz / Jonathan India "It Takes
 *  Two"" strips to "Elly De La Cruz / Jonathan India" before the " / " split
 *  in rule (a) ever runs. A quoted phrase NOT on this list is left alone --
 *  this is a closed vocabulary, not "strip any trailing quotes". */
const QUOTED_SUBSET_NAMES = [
  "Say Cheese!",
  "It Takes Two",
  "All Smiles",
  "Let's Dance!",
  "Bronx Bombers II",
  "Hoop Dreams",
  "Incoming!",
];

/** Matches a trailing `"<one of QUOTED_SUBSET_NAMES>"`, straight or curly
 *  quotes, with optional leading whitespace. Built once, from the closed list
 *  above, so adding a name to the list is the only edit a new subset tag
 *  needs. */
const QUOTED_SUBSET_RE = new RegExp(
  `\\s+[""](?:${QUOTED_SUBSET_NAMES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[""]$`,
);

/** Generational suffixes: presence on one side only is not a different
 *  person, but Jr. vs Sr. (or any two DIFFERENT tokens here) is a different
 *  person -- see rule (c) above. Mirrors the suffix set `cleanPlayerName`
 *  (cardCatalog.service.ts) strips, restated rather than imported -- this
 *  file has no dependency on `src/` (see the header). Matches with or
 *  without the owner's own comma ("Bobby Witt, Jr." and "Bobby Witt Jr."
 *  both extract "Jr"). CAPTURING, unlike the other markers, so the token
 *  itself can be compared rather than merely discarded. */
const GENERATIONAL_SUFFIX = /,?\s+(Jr|Sr|II|III|IV|V)\.?$/i;

/**
 * Pull the generational suffix token (if any) off the END of a name, once.
 * Returns `{ base, suffix }` -- `suffix` is the normalised token ("jr", "sr",
 * "ii", ...) or `null` when the name carries none. Runs BEFORE stripMarkers
 * so the suffix is captured rather than discarded by a generic loop, and only
 * once: nobody carries two generational suffixes.
 */
function extractGenerationalSuffix(name) {
  const s = String(name ?? "").trim();
  const m = s.match(GENERATIONAL_SUFFIX);
  if (!m) return { base: s, suffix: null };
  return { base: s.slice(0, m.index).trim(), suffix: m[1].toLowerCase() };
}

/**
 * Rule (c)'s own verdict, independent of everything else in this file: do
 * these two extracted suffix tokens permit an agreement? Both blank, or
 * exactly one present, is PRESENCE-VS-ABSENCE -- not a disagreement, the
 * shape this run actually has ("Bobby Witt Jr." vs "Bobby Witt"). Both
 * present is SUFFIX-VS-SUFFIX -- father and son both have cards, so equal
 * tokens agree (the same person's name, spelled with and without a trailing
 * comma) and unequal tokens (Jr. vs Sr., II vs III, Jr. vs II) are a REAL
 * disagreement that this rule alone must refuse, no matter what the base
 * names or any other rule in this file decide.
 */
function suffixesCompatible(suffixA, suffixB) {
  if (!suffixA || !suffixB) return true;
  return suffixA === suffixB;
}

/**
 * Strip every rule-(b) trailing marker from one name, repeatedly (a name can
 * carry more than one, e.g. two subset tags). Order: quoted subset name, then
 * league-leader suffix, then a bare RCup/FS marker -- repeated until nothing
 * more strips. The generational suffix is NOT stripped here -- it is pulled
 * off separately by `extractGenerationalSuffix` so its own token can be
 * compared by `suffixesCompatible` instead of being discarded.
 */
function stripMarkers(name) {
  let out = String(name ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [QUOTED_SUBSET_RE, LEAGUE_LEADER_SUFFIX, ...TRAILING_SUBSET_MARKERS]) {
      if (re.test(out)) {
        out = out.replace(re, "").trim();
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Rule (d): case / punctuation / diacritic-insensitive reduction, applied
 * AFTER stripMarkers so a tag's own punctuation (quotes, "!") is already gone
 * and this step only folds accents and residual punctuation inside the
 * player's own name -- "José" -> "jose", "Pete Crow-Armstrong" ->
 * "petecrowarmstrong".
 */
function foldForCompare(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * The FIRST-listed name of a " / "-separated multi-name card, or null when
 * the name is not multi-name at all. Splits ONLY on " / " (the exact
 * separator every measured pair uses) so a hyphenated single name
 * ("Pete Crow-Armstrong") is never mistaken for a list.
 */
function firstListedName(name) {
  const s = String(name ?? "");
  if (!s.includes(" / ")) return null;
  const first = s.split(" / ")[0];
  return first ? first.trim() : null;
}

/**
 * Do these two ALREADY-STORED playerName strings agree, for the purpose of
 * `rekey-product-setkey`'s different-player refusal ONLY?
 *
 * `true` means "this is not the contradiction the refusal exists for -- let
 * the ordinary ladder decide, or leave a genuine agreement alone". `false`
 * means "still disagree", and the caller's existing refusal/arbitration path
 * is unchanged -- this function only ever narrows what counts as a conflict,
 * it never manufactures one.
 *
 * Order: rule (a) first, because it changes WHICH strings rules (b)-(d) run
 * on (the multi-name side is reduced to its first-listed name before the tag
 * stripping and folding below ever see it). If neither side is multi-name,
 * (a) is a no-op and (b)-(d) run on the names as given.
 */
function namesAgree(nameA, nameB) {
  const a = String(nameA ?? "").trim();
  const b = String(nameB ?? "").trim();
  if (!a || !b) return false;

  // Rule (a): a multi-name side compares by its FIRST-listed name only, and
  // only against a genuinely single-name other side -- two multi-name sides
  // are not this run's shape and are left to disagree unless they already
  // match verbatim after folding.
  const firstA = firstListedName(a);
  const firstB = firstListedName(b);
  let leftName = a;
  let rightName = b;
  if (firstA && !firstB) leftName = firstA;
  if (firstB && !firstA) rightName = firstB;
  // Both multi-name, or neither: rules (b)-(d) run on the names as they are
  // (a both-multi-name pair falls through to the plain fold below, which will
  // only agree if the two lists are byte-for-byte the same after tag strip).

  // Rule (c): extract each side's OWN generational suffix before rule (b)
  // strips anything else, and refuse outright on a real suffix-vs-suffix
  // disagreement -- this check overrides every other rule in this file,
  // because Jr. and Sr. (or II and III) name two different, both-carded
  // people no matter how the rest of the name reads.
  const { base: baseA, suffix: suffixA } = extractGenerationalSuffix(leftName);
  const { base: baseB, suffix: suffixB } = extractGenerationalSuffix(rightName);
  if (!suffixesCompatible(suffixA, suffixB)) return false;

  const strippedA = stripMarkers(baseA);
  const strippedB = stripMarkers(baseB);
  return foldForCompare(strippedA) === foldForCompare(strippedB);
}

module.exports = {
  namesAgree,
  // exported for the mirror-equality test against the TS copy, and for a
  // caller that wants the intermediate reduction rather than the boolean.
  stripMarkers,
  foldForCompare,
  firstListedName,
  extractGenerationalSuffix,
  suffixesCompatible,
  TRAILING_SUBSET_MARKERS,
  LEAGUE_LEADER_SUFFIX,
  QUOTED_SUBSET_NAMES,
  GENERATIONAL_SUFFIX,
};
