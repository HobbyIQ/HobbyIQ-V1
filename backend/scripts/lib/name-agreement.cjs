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
 *     Also the BARE trailing rookie marker "RC" (run
 *     https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/36346769892,
 *     repoint-sales-by-list REPORT, USC143: `sale "Adael Amador Teal" vs
 *     destination "Adael Amador RC"`). This module's own header above already
 *     states "Jonah Tong RC" == "Jonah Tong" is the right answer -- the
 *     original TRAILING_SUBSET_MARKERS list just never carried the bare `RC`
 *     token, only its RCup/FS cousins. Measured on the committed checklist
 *     corpus (`backend/data/checklists/**\/*.csv`, `playerName` column):
 *     8,072 rows carry a bare trailing " RC" (e.g. "Jonah Tong RC", "Chase
 *     Burns RC"), zero carry "(RC)" or "RC SP"/"RC SSP" -- so only the bare
 *     shape is added; the parenthesised and SP/SSP-suffixed shapes stay out
 *     until a real row proves them.
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
 * ── THE SURNAME FLOOR (review round 1, PR #2463) ────────────────────────────
 *
 * `opts.stripTrailingTokens` (rule (b)'s caller-supplied extension, below)
 * opened a real hole once a real caller's vocabulary was used: 2025
 * topps-chrome-update-series's own checklist lists bare colour parallel words
 * -- "Green", "Gold", "Black", "Orange", "Red", "Blue" -- and a SURNAME that
 * is also one of those colours ("Nick Green") stripped down to a bare first
 * name, which then "agreed" with ANY other bare "Nick" (or "Nick RC" after
 * rule (b)'s own strip), a false merge with zero relation to the actual
 * different-player question this file exists to answer. Three guards close
 * it, none of them undoing rules (a)-(d) above -- they only ever narrow what
 * a STRIP is allowed to remove, the same one-directional safety the rest of
 * this file already holds to:
 *
 *   FLOOR 1 -- NEVER STRIP BELOW TWO TOKENS. A trailing marker (fixed OR
 *   caller-supplied) is stripped only when the side has at least THREE
 *   whitespace tokens before the strip (so at least two remain after it) --
 *   "Jonah Tong RC" (3 tokens) safely strips to "Jonah Tong" (2), but "Nick
 *   Green" (2 tokens) never strips "Green" down to the bare "Nick" (1) no
 *   matter which list names it. A first name alone proves nothing about
 *   which player a card is.
 *
 *   FLOOR 2 -- A COLOUR THAT IS THE OTHER SIDE'S OWN SURNAME IS A SURNAME,
 *   NOT A COLOUR, ON THIS PAIR. Before stripping a trailing token from side
 *   A, this file checks side B's own trailing token (after B's fixed-marker
 *   strip, so a marker on B does not hide B's real surname): if the two are
 *   the same word, side A's trailing word is refused as a strip candidate
 *   for THIS COMPARISON, because the other side just proved that exact word
 *   names a real surname a card in this pool actually carries ("Nick Green"
 *   vs "Chris Green" -- "Green" is not a stray colour here, it is the
 *   surname BOTH sides in this comparison could plausibly be using).
 *
 *   FLOOR 3 -- A STRIP-PRODUCED SINGLE TOKEN NEVER AGREES. Floors 1-2 already
 *   refuse any strip that would leave fewer than two tokens, so this floor is
 *   the fail-safe of last resort, the same posture rule (d) closes with: if a
 *   side somehow still reads as one bare word AFTER a strip actually removed
 *   something from it, that side never agrees, even against an identical
 *   bare word on the other side -- a lone word this file manufactured by
 *   stripping proves nothing. This draws a DELIBERATE line at NATIVE single
 *   tokens: a side that was already one bare word BEFORE any stripping ran
 *   (a mononym, a placeholder, a sparse field -- real fixtures elsewhere in
 *   this codebase compare bare single names this way) is not a stripped
 *   artefact and is left to the ordinary fold/compare like any other pair,
 *   so two identical native single words still agree and two different ones
 *   still refuse.
 *
 * These floors apply to EVERY strip this file performs -- rule (b)'s own
 * fixed vocabulary included -- because the hole is in what a STRIP can leave
 * behind, not in which list supplied the word. Measured against the existing
 * 127-pair fixture set: every fixed-marker strip already leaves >= 2 tokens
 * (`stripMarkers`'s own test asserts this), so the floors change nothing
 * about rule (b)'s pre-existing behaviour and exist purely to bound the new
 * option.
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
 *  Matched case-insensitively at the END of the (already trimmed) name.
 *  `\s+RC$` (bare, no "up") is the USC143 addition -- see the header note
 *  on rule (b) for the 8,072-row measurement that licenses it and the two
 *  unattested shapes ("(RC)", "RC SP"/"RC SSP") that are deliberately left
 *  out. Order matters here only in that longer/more specific markers should
 *  not be shadowed by this one -- RCup already ends in "up" so `\s+RC$`
 *  cannot fire on it first (the regex anchors at the true end of string).
 *
 *  `\s+Au$` / `\s+Autographs$` -- the 2024 Bowman Chrome CPA residue review
 *  (PR #2485 round 2, 2026-09-28). Measured against the 88-player, 1,385-row
 *  hiq:baseball:2024:bowman:cpa-* checklist corpus this residue targets:
 *  ZERO of the 88 playerName strings end in the bare word "Au" or
 *  "Autographs" -- unlike a real surname (`Green`), these are pure
 *  auto-format vendor tags ("Anthony Baptist Au", "2024 Bowman - Chrome
 *  Prospect Autographs Anthony Baptist #CPA-AB (AU, RC)" reduced by the
 *  extractor to "Anthony Baptist Autographs") that a listing appends after
 *  the player's own name, the identical shape "RC" already covers one word
 *  over. FLOOR 1 (never strip below two tokens) already refuses this on any
 *  two-token name, so a mononym or placeholder is unaffected. Deliberately
 *  NOT adding "Autos" (leading, not trailing -- "Autos Allan Castro") or any
 *  team/city abbreviation ("Texas", "Nats", "Mt", "Ny", "On") seen in the
 *  same review: those are an open-ended, un-closeable list (every card's
 *  seller can abbreviate a team differently) and exactly the hazard FLOOR 2
 *  exists to bound one word at a time, not the shape this fixed list is for
 *  -- see stripVocabularyForDestination's own opts.stripTrailingTokens for a
 *  caller that wants a product-scoped, not global, extension. */
const TRAILING_SUBSET_MARKERS = [/\s+RCup$/i, /\s+FS$/i, /\s+RC$/i, /\s+Autographs$/i, /\s+Au$/i];

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
 * Build a trailing-whole-word matcher for a caller-supplied phrase, matched
 * case-insensitively at the END of the (already trimmed) name only -- never
 * mid-string. "Teal" strips the trailing word "Teal" off "Adael Amador Teal"
 * but must NOT touch "Teal Adael Amador" (the phrase is not trailing there)
 * or fire on a mere substring ("Tealson" does not lose "son"). Built fresh
 * per call rather than cached: `opts.stripTrailingTokens` is caller-supplied
 * and product-scoped, so it is expected to differ call to call.
 */
function trailingTokenRe(phrase) {
  const escaped = String(phrase ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return null;
  return new RegExp(`\\s+${escaped}$`, "i");
}

/** Whitespace-token count -- the unit FLOOR 1 counts in. "Nick Green" is 2
 *  tokens, "Jonah Tong RC" is 3. Empty/blank counts as 0. */
function tokenCount(name) {
  const s = String(name ?? "").trim();
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

/** The LAST whitespace token of a name, lowercased for a case-insensitive
 *  comparison -- what FLOOR 2 checks the OTHER side's own trailing word
 *  against. Empty/blank returns "". */
function lastToken(name) {
  const s = String(name ?? "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * Strip every rule-(b) trailing marker from one name, repeatedly (a name can
 * carry more than one, e.g. two subset tags), THEN strip any caller-supplied
 * `extraTrailingTokens` (opts.stripTrailingTokens -- see `namesAgree`'s own
 * doc) the same way, repeatedly. Order: quoted subset name, then
 * league-leader suffix, then a bare RCup/FS/RC marker, then the caller's own
 * closed list -- repeated until nothing more strips, so a name carrying both
 * a fixed marker and a caller-supplied one ("Adael Amador Teal RC", not seen
 * yet but the same shape) still reduces fully. The generational suffix is
 * NOT stripped here -- it is pulled off separately by
 * `extractGenerationalSuffix` so its own token can be compared by
 * `suffixesCompatible` instead of being discarded.
 *
 * `otherSideLastToken` (see the header's "THE SURNAME FLOOR") is the OTHER
 * side's own trailing word (already reduced past ITS fixed markers, by the
 * caller) -- FLOOR 2. A candidate strip is refused, this call and no other,
 * when removing it would either (FLOOR 1) leave fewer than two tokens on
 * THIS side, or (FLOOR 2) remove exactly the word the other side is using as
 * its own surname. Both floors apply to every marker in the loop below,
 * fixed or caller-supplied -- the hole is in what a strip can leave behind,
 * not in which list named the word.
 */
function stripMarkers(name, extraTrailingTokens, otherSideLastToken) {
  const extraRes = Array.isArray(extraTrailingTokens)
    ? extraTrailingTokens.map(trailingTokenRe).filter(Boolean)
    : [];
  const guardWord = String(otherSideLastToken ?? "").toLowerCase();
  let out = String(name ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [QUOTED_SUBSET_RE, LEAGUE_LEADER_SUFFIX, ...TRAILING_SUBSET_MARKERS, ...extraRes]) {
      const m = out.match(re);
      if (!m) continue;
      const candidate = out.slice(0, m.index).trim();
      // FLOOR 1: never strip below two tokens.
      if (tokenCount(candidate) < 2) continue;
      // FLOOR 2: never strip the exact word the OTHER side is using as its
      // own trailing token (its surname on this pair) -- compare the STRIPPED
      // TEXT itself (m[0], trimmed), not the marker pattern, so this floor
      // reads what was actually about to be removed.
      const strippedText = m[0].trim().toLowerCase();
      if (guardWord && strippedText === guardWord) continue;
      out = candidate;
      changed = true;
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
 *
 * `opts.stripTrailingTokens` (optional, default `[]`) is a CALLER-SUPPLIED
 * closed list of phrases to strip from the END of EITHER side, matched
 * case-insensitively as whole trailing words, applied AFTER rule (b)'s own
 * fixed vocabulary and BEFORE rule (d)'s fold. It exists for
 * `repoint-sales-by-list.cjs`'s USC143 shape -- a sale's player string
 * carrying a parallel colour word the extraction left in ("Adael Amador
 * Teal") compared against a checklist row carrying its own trailing marker
 * ("Adael Amador RC") -- where the phrase to strip is a PRODUCT'S OWN
 * checklist vocabulary, not something this pair-level, product-blind module
 * can know on its own. This module never hardcodes a colour or any other
 * product-specific word; the caller decides what is strippable for the
 * product it is comparing, and `namesAgree(a, b)` with no third argument
 * behaves exactly as it did before this option existed. As with rule (b), a
 * phrase not on the caller's list is left exactly as printed -- "Julio
 * Rodriguez RC" does not fold onto "Adael Amador Teal" just because the
 * caller also supplied "Teal": stripping "Teal" from a name that does not
 * end in it is a no-op, and the two base names still disagree.
 */
function namesAgree(nameA, nameB, opts) {
  const a = String(nameA ?? "").trim();
  const b = String(nameB ?? "").trim();
  if (!a || !b) return false;
  const extraTrailingTokens = Array.isArray(opts?.stripTrailingTokens) ? opts.stripTrailingTokens : [];

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

  // FLOOR 2 (see the header's "THE SURNAME FLOOR"): each side's strip is
  // guarded against removing the exact word the OTHER side is using as its
  // own trailing token. Read off the PRE-STRIP base (post generational-suffix
  // extraction only) so this is never circular -- A's guard word is B's own
  // surname as B was actually given, not whatever B happens to reduce to
  // after its own strip runs.
  const strippedA = stripMarkers(baseA, extraTrailingTokens, lastToken(baseB));
  const strippedB = stripMarkers(baseB, extraTrailingTokens, lastToken(baseA));

  // FLOOR 3: a side that a STRIP reduced to a single token never agrees --
  // even against an identical single token on the other side, and even
  // though the plain fold below would say they match. Floors 1-2 already
  // refuse any strip that would leave fewer than two tokens (see
  // `stripMarkers`), so this side can only be a bare single token here if it
  // WAS ALREADY one before any stripping ran -- a name this file was simply
  // handed as one bare word (a mononym, a placeholder, a sparse field), never
  // a name this file manufactured by stripping something off. That is the
  // line this floor draws: refuse the STRIPPED-DOWN case (there is no
  // vocabulary word this file could have removed from a two-token name and
  // ended up here, by construction of floors 1-2), leave the NATIVE
  // single-token case exactly as every other rule in this file already
  // treats it -- fold and compare, same as any other pair.
  const aWasStripped = tokenCount(strippedA) < tokenCount(baseA);
  const bWasStripped = tokenCount(strippedB) < tokenCount(baseB);
  if ((tokenCount(strippedA) < 2 && aWasStripped) || (tokenCount(strippedB) < 2 && bWasStripped)) return false;

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
