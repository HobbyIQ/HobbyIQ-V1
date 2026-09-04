// ---------------------------------------------------------------------------
// playerSegmentIsAPerson.ts
//
// CF-A-PLAYER-SEGMENT-IS-A-PERSON (Drew, 2026-09-04).
//
// #1728's census of the 89,197 `player-<name>` pseudo-number rows was written
// to measure the NUMBER. Reading its output surfaced a second defect in the
// thing that census took for granted -- the NAME:
//
//     player-kawhi-leonard-tie-dye     the PARALLEL is inside the name
//     player-mega-box-elly-de          the PRODUCT is inside the name, and
//                                      "Elly De La Cruz" was cut to "Elly De"
//     player-pokemon-swsh-fa-mew       not a person at all: franchise + set
//                                      code + layout word, then a character
//
// One mechanism produces all three. `parseCardQuery` derives the player
// SUBTRACTIVELY: it strips the tokens it recognises and DECLARES THE RESIDUE TO
// BE A PERSON'S NAME. That inference is only sound when the strip list is
// complete, and the strip list is a ~250-word hand list -- necessarily smaller
// than the hobby. So every token the list does not know is not merely left
// behind, it is PROMOTED INTO A HUMAN NAME. "Tie-Dye" is a real Panini Select
// parallel (56 rows in our own checklist corpus); the hand list has never heard
// of it; therefore Kawhi Leonard's name grew a finish on the end.
//
// Then `.slice(0, 4)` truncates the survivor to four words. That is a second,
// independent defect: it silently CUTS a real name whenever noise sits ahead of
// it. "Mega Box Elly De La Cruz" is six tokens, so the cut lands mid-name and
// mints "Mega Box Elly De" -- a string that is wrong at both ends.
//
// THE RULE
//
//   A player segment must be a PERSON'S NAME, or nothing.
//
// Doctrine here is the same one that governs every other identity field in this
// repo: BLANK MEANS UNKNOWN. A row with no player can be re-derived tomorrow. A
// row keyed to "Mega Box Elly De" pollutes a pool that belongs to nobody, robs
// the pool that should have had the sale, and reads to a user as a defect in
// our data rather than a gap in it. Absent beats wrong.
//
// WHAT THIS MODULE CHANGES, MECHANICALLY
//
//   1. STRIP BEFORE CUTTING, AND STRIP FROM THE CORPUS. The vocabulary is
//      data/checklist-parallel-names.json -- 36,699 checklist-sourced parallel
//      names over 576 products -- plus CORE_FINISH_TOKENS. That is the SAME
//      vocabulary the GREAT REMATCH audit gate reads, so "is this word a
//      parallel" has exactly one answer in this repo instead of two. A hand
//      list that is smaller than the hobby is what caused this defect; the fix
//      is not a longer hand list.
//   2. NEVER TRUNCATE. `.slice(0, 4)` is gone. A residue that cannot be bounded
//      into a name is returned as null, not as its own first four words.
//   3. THE CHECKLIST OUTRANKS THE TITLE. When a checklist row exists for this
//      (year, setKey, cardNumber) it names the player, and that name wins --
//      it is the authority, and the title is a seller's paraphrase of it.
//   4. MULTI-PLAYER CARDS STAY INTACT. "Ken Dryden/Glenn Resch/Bernie Parent"
//      is ONE card with three people on it. The separators survive the strip
//      and the name is not cut down to the first person.
//
// WHY NOT JUST EXTEND THE NOISE LIST
//
// Because that is what the NOISE list already is, and it is how we got here.
// Its own comments record five separate expansions, each triggered by a
// production defect, each adding the specific words that defect named --
// "speck" after Charles Woodson, "image" after Drake Baldwin, team names after
// the TCA firehose. Every expansion was correct and none of them fixed the
// mechanism, because the mechanism is that a closed list is asked to enumerate
// an open set. The corpus is not a longer list; it is a different KIND of
// answer, and it grows when the hobby does.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A residue token that can be INSIDE a name but can never END one. A name
 *  ending here was cut: "Elly De" is the front of "Elly De La Cruz". */
const TRAILING_PARTICLES = new Set([
  "de", "la", "el", "del", "der", "van", "von", "di", "da", "dos", "das",
  "mc", "mac", "st", "san", "le", "du", "bin", "ibn", "ter", "ten",
]);

/** Names and initials that are genuinely one or two characters, so a short
 *  final token is not mistaken for a truncation. */
const REAL_SHORT_NAMES = new Set([
  "oh", "ng", "ho", "ko", "lu", "li", "yu", "wu", "xu", "an", "im", "ok",
  "ha", "so", "no", "ah", "yi", "je", "cy", "ed", "al", "aj", "cj", "jj",
  "tj", "dj", "rj", "bj", "jr", "sr", "ii", "iii", "iv",
]);

/**
 * Set codes and layout words from the Pokemon vertical. These are NOT parts of
 * a character's name: `swsh` is Sword & Shield, `fa` is full art, `sv2a` is a
 * Japanese set code. A residue containing one is not a name at all.
 *
 * The Pokemon CHARACTER name itself ("Mew", "Charizard") is a legitimate player
 * segment on a pokemon row -- that vertical's cards name characters the way a
 * baseball card names an athlete -- so nothing here matches a character.
 */
const VERTICAL_CODE_RE =
  /^(swsh|sm|xy|bw|hgss|dp|gx|vmax|vstar|fa|sar|char|ur|sir|promo|s\d{1,2}[a-z]?|sv\d{0,2}[a-z]?)$/i;

/**
 * Packaging, product-form and set-qualifier words. None of these is
 * decomposable from a setKey the parser managed to recognise, and each is a
 * PRODUCT word wherever it appears: "Mega Box" is how a card was sold, and
 * "Traded" / "Update" name the boxed set a card came out of ("1987 Topps
 * Traded" is a different product from 1987 Topps, with its own checklist).
 * Left in the residue they read as parts of a person's name -- the census found
 * "Traded Tiffany Greg Maddux" and "Chee Deckle Roberto Clemente".
 */
const PACKAGING_WORDS = new Set([
  "mega", "box", "blaster", "hobby", "jumbo", "retail", "pack", "case",
  "hanger", "cello", "rack", "value", "tin", "blister", "fat", "exclusive",
  "traded", "deckle", "chee", "opc",
]);

const lower = (s: string): string => s.toLowerCase();
const tokenize = (s: string): string[] =>
  lower(s).replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// THE CORPUS -- the vocabulary is the checklist, not a hand list.
// ---------------------------------------------------------------------------

interface ParallelCorpus {
  products?: Record<string, { parallels?: { name?: string }[] }>;
}

let _corpusWords: Set<string> | null = null;
let _corpusByProduct: Map<string, Set<string>> | null = null;
let _corpusLoadFailed = false;

/**
 * THE CORPUS CONTAINS PLAYER-NAMED INSERTS, AND A NAIVE HARVEST EATS NAMES.
 *
 * `baseball|2024|panini-flawless` lists a parallel literally called
 * `Ken Griffey Jr. "The Kid"`. Harvesting every token of every parallel name
 * therefore puts `ken`, `griffey` and `kid` into the "this word is a finish"
 * vocabulary -- and the strip then deletes the first name from
 * "Ken Dryden/Glenn Resch/Bernie Parent", which is the exact defect this module
 * exists to prevent, reintroduced from the other direction.
 *
 * Measured over the whole corpus: 2,108 distinct tokens of length >= 3, of
 * which the person-name contaminants (ken, griffey, kid, david, ohtani, aaron,
 * judge) appear EXACTLY ONCE each. Every real finish word recurs -- across
 * products, across years, across spellings -- because a finish is a thing the
 * hobby does repeatedly and a player-named insert is a one-off.
 *
 * So the floor is frequency, not a hand-maintained blocklist: a token must be
 * seen in at least two distinct parallel names to count as vocabulary. At
 * floor 2 the vocabulary keeps 1,779 of 2,239 tokens and loses NONE of the
 * finish words checked against CORE_FINISH_TOKENS and the family list -- while
 * dropping every one-off, which is where the names live.
 *
 * A token still counts regardless of frequency when the hand vocabulary in
 * rematch-finish-vocab.cjs names it, because that list is adjudicated.
 */
const CORPUS_FREQUENCY_FLOOR = 2;

/**
 * THE ADJUDICATED FINISH WORDS THE CORPUS CANNOT SUPPLY.
 *
 * Two gaps, one list:
 *
 *   1. VINTAGE. Beckett's bulk pull floors at 2020, so Tiffany, Desert Shield,
 *      Glossy Send-In and the rest are real, adjudicated parallels that sit
 *      outside the corpus's range. Without them "1987 Topps Traded Tiffany
 *      Greg Maddux" keeps the finish inside the name, and a Tiffany sale --
 *      a distinct card with its own price curve -- is filed as a base card.
 *   2. SPELLING SPLITS. "X FRACTOR" reaches the residue as two tokens, and
 *      neither `x` nor `fractor` is a whole parallel name in the corpus, so
 *      the frequency harvest never sees it. `fractor` IS in CORE_FINISH_TOKENS.
 *
 * THIS LIST IS A MIRROR, NOT A SECOND VOCABULARY. Every entry is copied from
 * rematch-finish-vocab.cjs's CORE_FINISH_TOKENS / HAND_SPELLINGS /
 * FINISH_FAMILY_TOKENS, which is the adjudicated vocabulary of record and is
 * kept under a ceiling by its own tests. It is duplicated here rather than
 * imported ONLY because that module is a `.cjs` under scripts/ and nothing in
 * src/ depends on scripts/ -- a dependency in that direction would make the
 * request path load the rematch tooling. `playerSegmentVocabularyMirrorsTheAudit`
 * in playerSegmentIsAPerson.test.ts asserts this list stays a SUBSET of that
 * module's, so the two cannot drift apart silently: add a word there first.
 */
const ADJUDICATED_FINISH_WORDS = [
  // vintage (HAND_SPELLINGS)
  "tiffany", "embossed", "glossy", "pennant", "premier", "photographers",
  "mahogany", "rapture", "peel", "reveal", "crusade", "unparalleled",
  "vector", "astral", "marvels", "unleashed", "proof", "proofs", "shield",
  // split spellings the corpus harvest cannot see as whole names
  "fractor", "refractor", "superfractor", "logofractor", "xfractor",
  "diecut", "holofoil",
];

/**
 * Candidate locations for the corpus, in the order bowmanParallelsDataset.ts
 * and setKeyReconciliation.ts already use: compiled `dist/services/compiq/` and
 * source `src/services/compiq/` both sit three levels under the package root
 * where `data/` lives, and the cwd-relative forms cover tests and scripts.
 */
const CORPUS_CANDIDATES = (): string[] => [
  join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "data", "checklist-parallel-names.json"),
  join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
];

function readCorpusFile(): string | null {
  for (const candidate of CORPUS_CANDIDATES()) {
    try { return readFileSync(candidate, "utf8"); } catch { /* try the next */ }
  }
  return null;
}

function loadCorpus(): void {
  if (_corpusWords || _corpusLoadFailed) return;
  const words = new Set<string>();
  const byProduct = new Map<string, Set<string>>();
  try {
    const text = readCorpusFile();
    if (text == null) throw new Error("checklist-parallel-names.json not found");
    const raw = JSON.parse(text) as ParallelCorpus;

    // Pass 1: count how many distinct parallel names each token appears in, so
    // the frequency floor can tell a finish word from a player-named insert.
    const frequency = new Map<string, number>();
    for (const product of Object.values(raw.products ?? {})) {
      for (const parallel of product.parallels ?? []) {
        for (const w of new Set(tokenize(parallel.name ?? ""))) {
          if (w.length >= 3 && !/^\d+$/.test(w)) frequency.set(w, (frequency.get(w) ?? 0) + 1);
        }
      }
    }

    // Pass 2: admit the tokens that clear the floor, plus the adjudicated
    // vintage words the corpus's 2020 floor cannot supply.
    for (const [key, product] of Object.entries(raw.products ?? {})) {
      const parts = key.split("|");
      const productKey = `${parts[1] ?? ""}|${parts[2] ?? ""}`;
      let bucket = byProduct.get(productKey);
      if (!bucket) { bucket = new Set<string>(); byProduct.set(productKey, bucket); }
      for (const parallel of product.parallels ?? []) {
        for (const w of tokenize(parallel.name ?? "")) {
          if (w.length < 3 || /^\d+$/.test(w)) continue;
          if ((frequency.get(w) ?? 0) < CORPUS_FREQUENCY_FLOOR) continue;
          words.add(w);
          bucket.add(w);
        }
      }
      // the product's OWN setKey words are product words on that product
      for (const w of (parts[2] ?? "").split("-")) if (w.length >= 3) bucket.add(lower(w));
    }
    for (const w of ADJUDICATED_FINISH_WORDS) for (const t of tokenize(w)) if (t.length >= 3) words.add(t);
    _corpusWords = words;
    _corpusByProduct = byProduct;
  } catch {
    // The corpus is a build artifact copied into dist/. If it is absent the
    // module still refuses to truncate and still strips the core vocabulary --
    // it just cannot see product-specific parallels. Degrade, never throw.
    _corpusLoadFailed = true;
    _corpusWords = new Set<string>(ADJUDICATED_FINISH_WORDS.flatMap((w) => tokenize(w)).filter((t) => t.length >= 3));
    _corpusByProduct = new Map();
  }
}

/**
 * The finish/parallel words that apply to a card, widest-first: the corpus's
 * whole parallel vocabulary, narrowed by the product's own setKey words (a word
 * that NAMES this product is a product word here, not a finish -- "Chrome" on
 * topps-chrome names the set).
 */
function vocabularyFor(year: number | null, setKey: string | null): Set<string> {
  loadCorpus();
  const all = new Set(_corpusWords ?? []);
  const own = new Set((setKey ?? "").split("-").map(lower).filter((w) => w.length >= 3));
  // A product word is still stripped from a NAME -- it is not a person either.
  // The distinction matters only for classification, never for the strip.
  for (const w of own) all.add(w);
  const productKey = `${year ?? ""}|${setKey ?? ""}`;
  for (const w of _corpusByProduct?.get(productKey) ?? []) all.add(w);
  return all;
}

/** Test seam: force a corpus reload (used by the fixture tests). */
export function _resetCorpus(): void {
  _corpusWords = null;
  _corpusByProduct = null;
  _corpusLoadFailed = false;
}

// ---------------------------------------------------------------------------
// THE DECISION
// ---------------------------------------------------------------------------

export type PlayerSegmentReason =
  | "clean"
  | "stripped-vocabulary"
  | "refused-unbounded"
  | "refused-not-a-person"
  | "refused-empty"
  | "checklist";

export interface PlayerSegment {
  /** The person's name, or null. Null is an ANSWER: it means unknown. */
  player: string | null;
  reason: PlayerSegmentReason;
  /** Vocabulary tokens removed from the residue, for telemetry. */
  stripped: string[];
}

/** Title-case a token, preserving interior capitals of Mc/Mac and O'. */
function titleCaseToken(tok: string): string {
  if (!tok) return tok;
  const cased = tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
  return cased
    .replace(/^(Mc)([a-z])/, (_m, p, c: string) => p + c.toUpperCase())
    .replace(/^(O')([a-z])/, (_m, p, c: string) => p + c.toUpperCase());
}

/**
 * MULTI-PLAYER CARDS. "Ken Dryden/Glenn Resch/Bernie Parent" is ONE card with
 * three people on it, and the checklist lists it that way. Splitting on the
 * separator and keeping only the first person would mint a DIFFERENT card --
 * the Dryden single -- and merge a three-player pool into it.
 */
const MULTI_PLAYER_SPLIT = /\s*[/&+]\s*|\s+and\s+/i;

function isMultiPlayer(raw: string): boolean {
  return MULTI_PLAYER_SPLIT.test(raw) && raw.split(MULTI_PLAYER_SPLIT).filter((p) => p.trim()).length >= 2;
}

/**
 * Bound a token list into a person's name, or refuse.
 *
 * A name is bounded when every token in it is a name token. It is NOT bounded
 * when a vocabulary token sits in the middle (the residue is two things joined,
 * and we cannot tell where one stops), or when it ends on a particle (it was
 * cut), or when it is longer than any real name.
 *
 * NAME_CEILING IS A REFUSAL THRESHOLD, NOT A CUT -- and that distinction is the
 * whole point of this module. The old code shared this number (4) and used it
 * to `.slice()`, which is why "Mega Box Elly De La Cruz" became "Mega Box Elly
 * De": the same threshold, applied as a cut, MINTS a wrong name where applied
 * as a refusal it returns null.
 *
 * Four tokens covers every real name we key on, "Jose de la Cruz" included. A
 * residue longer than that is noise the strip did not recognise sitting next to
 * a name we cannot delimit -- "Berk Ross Campanella Brooklyn No" is a set, a
 * player, a team and a fragment, and there is no rule that recovers "Roy
 * Campanella" from it without guessing. The honest answer is that we do not
 * know, and the row can be re-derived when the vocabulary grows.
 */
const NAME_CEILING = 4;

function boundName(tokens: string[]): { name: string | null; reason: PlayerSegmentReason } {
  if (!tokens.length) return { name: null, reason: "refused-empty" };

  // A set code or layout word anywhere means this is not a person's name.
  if (tokens.some((t) => VERTICAL_CODE_RE.test(t))) {
    return { name: null, reason: "refused-not-a-person" };
  }
  if (tokens.includes("pokemon")) return { name: null, reason: "refused-not-a-person" };

  // Too long to be a name. REFUSE -- do not cut to the ceiling. Cutting is the
  // defect this module exists to remove.
  if (tokens.length > NAME_CEILING) return { name: null, reason: "refused-unbounded" };

  const last = tokens[tokens.length - 1];
  // Ends on a particle: the name was cut ("Elly De" <- "Elly De La Cruz").
  if (tokens.length >= 2 && TRAILING_PARTICLES.has(last)) {
    return { name: null, reason: "refused-unbounded" };
  }
  // A final token too short to be a name, and not one of the real short ones.
  if (last.length < 3 && !REAL_SHORT_NAMES.has(last)) {
    return { name: null, reason: "refused-unbounded" };
  }
  // A single token is a surname at best; keep it only if it reads as a name.
  if (tokens.length === 1 && (tokens[0].length < 3 || /\d/.test(tokens[0]))) {
    return { name: null, reason: "refused-not-a-person" };
  }
  // A digit anywhere means a number survived the strip; that is not a name.
  if (tokens.some((t) => /\d/.test(t))) return { name: null, reason: "refused-not-a-person" };

  return { name: tokens.map(titleCaseToken).join(" "), reason: "clean" };
}

export interface PlayerSegmentContext {
  year?: number | null;
  setKey?: string | null;
  /** The checklist's player for this (year, setKey, cardNumber), when one
   *  exists. The checklist is the authority and this wins outright. */
  checklistPlayer?: string | null;
}

/**
 * Turn the parser's residue into a person's name, or into null.
 *
 * `residue` is what parseCardQuery has left after stripping year / brand / set
 * / parallel / cardNumber / printRun / grade / NOISE. This function does NOT
 * trust that residue to be a name -- it is the string the old code declared to
 * be one.
 */
export function playerSegmentIsAPerson(
  residue: string | null | undefined,
  ctx: PlayerSegmentContext = {},
): PlayerSegment {
  const raw = String(residue ?? "").trim();
  if (!raw) return { player: null, reason: "refused-empty", stripped: [] };

  // (3) THE CHECKLIST OUTRANKS THE TITLE. When the checklist names the player
  // for this exact (year, setKey, cardNumber), that is the authority and no
  // amount of title parsing improves on it.
  const fromChecklist = String(ctx.checklistPlayer ?? "").trim();
  if (fromChecklist) return { player: fromChecklist, reason: "checklist", stripped: [] };

  // (4) MULTI-PLAYER CARDS survive intact. Each side is bounded on its own and
  // the separator is preserved, so a three-player card stays one card.
  if (isMultiPlayer(raw)) {
    const parts = raw.split(MULTI_PLAYER_SPLIT).map((p) => p.trim()).filter(Boolean);
    const bounded: string[] = [];
    const strippedAll: string[] = [];
    for (const part of parts) {
      const one = playerSegmentIsAPerson(part, { ...ctx, checklistPlayer: null });
      // Every side must bound. A multi-player card whose second name is noise
      // is not a card we can key -- refuse the whole thing rather than mint a
      // partial roster.
      if (!one.player) return { player: null, reason: one.reason, stripped: one.stripped };
      bounded.push(one.player);
      strippedAll.push(...one.stripped);
    }
    return { player: bounded.join("/"), reason: bounded.length ? "clean" : "refused-empty", stripped: strippedAll };
  }

  // (1) STRIP BEFORE CUTTING, from the corpus vocabulary.
  const vocab = vocabularyFor(ctx.year ?? null, ctx.setKey ?? null);
  const tokens = tokenize(raw);
  const stripped: string[] = [];
  const kept: string[] = [];
  for (const tok of tokens) {
    const bare = tok.replace(/^-+|-+$/g, "");
    if (!bare) continue;
    // Hyphenated compounds are vocabulary if EITHER half is ("tie-dye").
    const halves = bare.split("-").filter(Boolean);
    const isVocab =
      vocab.has(bare) ||
      PACKAGING_WORDS.has(bare) ||
      (halves.length > 1 && halves.every((h) => vocab.has(h) || PACKAGING_WORDS.has(h))) ||
      (halves.length > 1 && halves.some((h) => h.length >= 4 && vocab.has(h)));
    if (isVocab) { stripped.push(bare); continue; }
    // An ORPHANED SINGLE LETTER is the other half of a vocabulary word the
    // title spelled with a space: "X FRACTOR" strips `fractor` and leaves a
    // bare `x`, "E X" leaves `e`. A single letter is never a name token on its
    // own (an initial reaches us as "J." and keeps its stop), and leaving it
    // makes the name look truncated -- "Cooper Flagg X" was refused for ending
    // on a short token, losing a name the strip had otherwise recovered.
    if (bare.length === 1 && !/^[&]$/.test(bare)) { stripped.push(bare); continue; }
    kept.push(bare);
  }

  // (2) NEVER TRUNCATE -- bound or refuse.
  const { name, reason } = boundName(kept);
  return {
    player: name,
    reason: name ? (stripped.length ? "stripped-vocabulary" : "clean") : reason,
    stripped,
  };
}
