// ---------------------------------------------------------------------------
// pokemonFinishFromTitle.ts
//
// CF-A-FINISH-IS-A-CARD-LINE, AT THE TITLE PARSER (Drew, 2026-09-07).
//
// #1935 ruled a Pokemon finish is a distinct card line and minted the rows.
// #1937 folded the five market spellings onto two canonical slug tokens. Both
// landed, and the pools did not move -- because the derivation never read a
// finish in the first place. The #1937 measurement is the whole reason this
// file exists: a 600-row sample (150 each of `reverse-foil` / `reverse` /
// `holofoil` / `reverse-holo`) run through the rematch classifier ONCE on main
// and ONCE with the fold produced BYTE-FOR-BYTE IDENTICAL output -- 150/150
// CONFLICT, 0 writable, on every token including the already-canonical one.
//
// The fold was not what refused them. `parseListingIdentity` answered
// `parallel: "Base"` on titles that state the finish in words:
//
//   "2004 Pokemon EX FireRed & LeafGreen #77 Reverse Foil"            -> Base
//   "2015 Pokemon XY Ancient Origins #67 Reverse Holo"                -> Base
//   "2025 Pokemon Scarlet & Violet Prismatic Evolutions #105 Reverse" -> Base
//   "2022 Pokemon Astral Radiance #104 Holofoil"                      -> Base
//
// So the derivation DROPS the parallel, the classifier's base-eviction guard
// correctly refuses on `dropped:parallel`, and the row is CONFLICT with or
// without the fold. A refusal is not a repair: 299,317 reverse-family sales and
// 4,195 holo-family sales sit permanently unactionable, each addressing a pool
// its own title disagrees with.
//
// WHY THE EXISTING CHECKLIST READER DOES NOT COVER THIS
//
// `statedFinishFromChecklist` (#1796) is the right seam and reads the right
// corpus -- but the corpus is a SPORTS corpus. Measured on
// `data/checklist-parallel-names.json` as built 2026-09-04:
//
//     627 products total          1 of them Pokemon
//
// That one product (`pokemon|2022|swsh10-astral-radiance`) lists exactly
// "Holofoil" and "Reverse Holofoil". So for every other Pokemon product there
// is NO product context, the reader falls to its global index, and the global
// index refuses these words for reasons that are correct in the sports hobby
// it was measured on:
//
//   "holo"          4 chars, under MIN_GLOBAL_TOKEN_LEN (5)
//   "reverse foil"  not a corpus name at all -- absent
//   "reverse holo"  not a corpus name at all -- absent
//   "reverse"       not a corpus name; and 7 chars of ordinary English
//   "normal"        not a corpus name at all -- absent
//   "holofoil"      IS a corpus name, but the single-word global floor plus the
//                   truncation guard's "content word in front of a one-word
//                   answer" rule refuse it on a real title
//
// Widening those floors GLOBALLY is the wrong fix and would be a sports
// regression: `MIN_GLOBAL_TOKEN_LEN` exists because "ice"/"war"/"cup" collide
// with card text, and the one-word truncation guard exists because it caught
// "Flair Showcase" being read as the finish "Showcase". This module therefore
// does not touch that reader at all. It runs only under the Pokemon gate, and
// only where `extractParallel` was about to answer "Base".
//
// ONE VOCABULARY, MIRRORED AND PINNED
//
// The words come from `scripts/lib/pokemon-finish-vocab.cjs` -- the SAME table
// `mint-attested-finish-rows` writes rows at (#1935) and the same one
// `POKEMON_FINISH_TOKEN_FOLD` in the slug seam is pinned equal to (#1937). It
// is mirrored rather than imported for the reason `statedFinishFromChecklist`
// and `playerSegmentIsAPerson` both record for their own mirrors: that file is
// a `.cjs` under `scripts/` and nothing in `src/` depends on `scripts/`.
//
// A mirror nothing compares is a second source of truth; a mirror a test
// compares is a cache. `pokemonFinishReachesTheTitleParser.test.ts` asserts
// TABLE EQUALITY in both directions against the `.cjs`, so a word added there
// and not here is a red test rather than a silently unread spelling.
//
// WHY THE ANSWER IS THE DISPLAY NAME AND NOT THE TITLE'S OWN WORDS
//
// Because the mint lane writes `FINISH_DISPLAY` names, and those names are
// pinned in `pokemonFinishIsACardLine.test.ts` as `normalizeParallel` FIXED
// POINTS THROUGH THEIR TOKEN. Answering "Reverse Foil" verbatim would slug to
// `reverse-foil`, which the #1937 fold then folds to `reverse-holofoil` anyway
// -- correct, but only because a second mechanism cleans up after this one.
// Answering "Reverse Holofoil" is the address directly, so the parser's output
// is right even for a caller that reads `parallel` without building a slug.
// Both paths agree, and the test pins that they agree.
//
// SPORTS ARE UNTOUCHED, AND THAT IS THE GATE'S ONLY JOB
//
// "Holo" is Panini Optic's word for a Holo prizm. "Gold Foil" is a 1990s Topps
// and Fleer parallel. "Foil" is a real Skybox finish. "Reverse" appears in
// ordinary sports title text. Every one of those words is ordinary in the
// sports hobby, so this vocabulary is consulted ONLY when the row is Pokemon --
// the same gate `normalizeSetKey`, `resolveSetKeyForSlug` and the #1937 fold
// already apply to the Pokemon set vocabulary, for the same reason.
//
// DIRECTION OF SAFETY. This module WRITES an identity, so its errors are not
// free. It answers only on an EXPLICIT stated finish, never on inference; when
// it cannot be sure it returns null and the caller keeps "Base", which is where
// the row already is and is recoverable. Absent beats wrong.
// ---------------------------------------------------------------------------

/**
 * Market spelling -> canonical finish token.
 *
 * A MIRROR OF `FINISH_TOKENS` in `scripts/lib/pokemon-finish-vocab.cjs`, pinned
 * EQUAL to it in both directions by `pokemonFinishReachesTheTitleParser.test.ts`.
 * Add a spelling THERE first: that file is the vocabulary, this is its cache,
 * and the mint lane's rows are addressed from it.
 */
const FINISH_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  // The holo family.
  "holofoil": "holofoil",
  "holofoils": "holofoil",
  "holo": "holofoil",
  "holos": "holofoil",
  "holo-rare": "holofoil",
  "foil": "holofoil",
  "foils": "holofoil",
  // The reverse family. NEVER folds onto the holo family above.
  "reverse-holofoil": "reverse-holofoil",
  "reverse-holofoils": "reverse-holofoil",
  "reverse-holo": "reverse-holofoil",
  "reverse-holos": "reverse-holofoil",
  "reverse-foil": "reverse-holofoil",
  "reverse-foils": "reverse-holofoil",
  "reverse": "reverse-holofoil",
  // Era-specific finishes, each its own line.
  "cosmos-holo": "cosmos-holo",
  "cosmos": "cosmos-holo",
  "cracked-ice": "cracked-ice",
  "cracked-ice-holo": "cracked-ice",
  "cracked-ice-holofoil": "cracked-ice",
  // The un-foiled line. "Normal" is TCGplayer's own word for it.
  "normal": "normal",
});

/**
 * Canonical token -> the display name this module ANSWERS WITH.
 *
 * A MIRROR OF `FINISH_DISPLAY` in the same `.cjs`, pinned equal by the same
 * test. These are the names `mint-attested-finish-rows` writes into a row's
 * `parallel` field, and each is a `normalizeParallel` fixed point through its
 * token -- so the name this parser returns and the name the catalog row carries
 * are the same string, and both slug to the same address.
 */
const FINISH_DISPLAY: Readonly<Record<string, string>> = Object.freeze({
  "holofoil": "Holofoil",
  "reverse-holofoil": "Reverse Holofoil",
  "cosmos-holo": "Cosmos Holo",
  "cracked-ice": "Cracked Ice",
  "normal": "Normal",
});

/**
 * SPELLINGS THE MARKET WRITES THAT THE TOKEN TABLE CANNOT CARRY.
 *
 * `FINISH_TOKENS` is keyed by SLUG SEGMENT, because that is what the mint lane
 * and the slug fold read -- `reverse-holo`, not "Rev Holo". A title is prose,
 * and two prose forms have no slug spelling to be keyed under:
 *
 *   "Rev Holo"    the market's own abbreviation; `rev` is not a slug token any
 *                 row is addressed at, so it cannot be a `FINISH_TOKENS` key
 *                 without inventing a sixth address for the mint lane.
 *   "Holo Foil"   two words for the one word `holofoil`. The slug form is
 *                 already a key; the SPACED form is what a seller types.
 *
 * These normalise INTO an existing token and mint nothing new. Every value here
 * must be a `FINISH_TOKENS` key -- pinned by the test, so this cannot become a
 * side vocabulary that reaches an address the mint lane never writes.
 */
const TITLE_SPELLING_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "rev-holo": "reverse-holo",
  "rev-holofoil": "reverse-holofoil",
  "rev-foil": "reverse-foil",
  "holo-foil": "holofoil",
  "reverse-holo-foil": "reverse-holofoil",
});

/** The alias map, exposed for the test's "every value is a real token" pin. */
export const __TITLE_SPELLING_ALIASES_FOR_TEST = TITLE_SPELLING_ALIASES;
/** The mirrored tables, exposed for the table-equality pin against the `.cjs`. */
export const __FINISH_TOKENS_FOR_TEST = FINISH_TOKENS;
export const __FINISH_DISPLAY_FOR_TEST = FINISH_DISPLAY;

/**
 * The longest phrase length we try, in words. "reverse holo foil" is three;
 * nothing in the vocabulary is longer, and the test pins that.
 */
const MAX_PHRASE_WORDS = 3;

/**
 * A WORD THAT ENDS THE TITLE'S CARD NAME AND BEGINS ITS CONDITION REPORT.
 *
 * Pokemon marketplace titles routinely append the slab or the condition after
 * the card, and one of those words is `holo`-adjacent in appearance only:
 *
 *   "... #4 Holo PSA 10 Gem Mint"      the card IS the Holo -- read it
 *   "... #4 Near Mint Reverse Holo"    still the finish, just later in the line
 *
 * Both are read. This list exists for the OPPOSITE case, where a would-be
 * finish word is part of a longer non-finish phrase the vocabulary must not
 * truncate -- see `phraseIsTruncated`.
 */
const NON_FINISH_EXTENSIONS: ReadonlySet<string> = new Set([
  // "Cosmos" is the finish; "Cosmos Holo" is too. But a HOLO that is really the
  // head of "holo rare" is already a key, and these extend a match into a
  // phrase that is NOT a finish at all.
  "bomb", "burst", "stamp", "stamped", "promo",
]);

const lower = (s: string): string => String(s ?? "").toLowerCase();

/** Title -> comparable word sequence. `&` becomes a word so "Scarlet & Violet"
 *  cannot glue into a phrase, and every other non-alphanumeric is a boundary --
 *  which is what makes TCGplayer's " - Holofoil" suffix read as a bare word. */
function words(s: string): string[] {
  const n = lower(s)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return n ? n.split(" ") : [];
}

/** The canonical token a phrase names, following the alias map first. */
function tokenOfPhrase(phraseSlug: string): string | null {
  const aliased = TITLE_SPELLING_ALIASES[phraseSlug] ?? phraseSlug;
  return Object.prototype.hasOwnProperty.call(FINISH_TOKENS, aliased)
    ? FINISH_TOKENS[aliased]
    : null;
}

/**
 * Would extending this match by the following word produce a phrase that is NOT
 * a finish?
 *
 * The same shape `statedFinishFromChecklist`'s truncation guard refuses, for the
 * same reason: answering the head of a longer name writes half a card. Here the
 * hazard is concrete and narrow -- "Cosmos Bomb" and "Holo Stamped" are not the
 * "Cosmos" and "Holo" card lines -- so the check is a small explicit list rather
 * than a corpus test, and a refusal costs only a recovery.
 */
function phraseIsTruncated(seq: string[], start: number, len: number): boolean {
  const after = seq[start + len];
  return after != null && NON_FINISH_EXTENSIONS.has(after);
}

export interface PokemonFinishFromTitleResult {
  /** The display name to write as `parallel`, e.g. "Reverse Holofoil". */
  display: string;
  /** The canonical token it addresses, e.g. `reverse-holofoil`. */
  token: string;
}

/**
 * THE FINISH THIS POKEMON TITLE STATES, AS THE MINT LANE SPELLS IT -- or null.
 *
 * PRECEDENCE IS LONGEST-PHRASE-FIRST, and it is load-bearing rather than a
 * tidiness: "Reverse Holo" contains "Holo", and a shortest-first reader would
 * answer `holofoil` on a REVERSE holofoil card -- folding 215,231 reverse sales
 * into a holo pool, which is the single corruption #1937's family separation
 * exists to prevent. Three-word phrases are tried before two, two before one,
 * and the FIRST position in the title that yields a match at the longest length
 * wins.
 *
 * Null means "this title states no finish", and the caller keeps its own answer.
 */
export function pokemonFinishFromTitle(title: string): PokemonFinishFromTitleResult | null {
  const seq = words(title);
  if (!seq.length) return null;

  for (let len = MAX_PHRASE_WORDS; len >= 1; len--) {
    for (let i = 0; i + len <= seq.length; i++) {
      const phrase = seq.slice(i, i + len).join("-");
      const token = tokenOfPhrase(phrase);
      if (!token) continue;
      if (phraseIsTruncated(seq, i, len)) continue;
      const display = FINISH_DISPLAY[token];
      if (!display) continue;
      return { display, token };
    }
  }
  return null;
}
