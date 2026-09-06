// CF-PARSE-TITLE-IDENTITY (Drew, 2026-07-23, issue #722). Extract a
// (cardNumber, parallel, isAuto, printRun) tuple from a marketplace
// listing title. Foundational module for the persist-on-lookup
// pipeline — every vendor row we ingest goes through this parser
// so its identity ends up canonical + matchable to hobbyiqCardId.
//
// Extracted from the scratchpad ingest scripts (v3/v5/v7) that shipped
// Owen Carey Sapphire + Eric Hartman + Gage Wood on 2026-07-23.
//
// DESIGN
// - Pure function. No I/O.
// - Case-insensitive.
// - Whitelist over guess: parallel matches specific recognized patterns;
//   unrecognized text keeps parallel = "Base".
// - cardNumber extraction is regex-first; caller can pass a narrower
//   whitelist when the target card is known (e.g. "only accept CPA-EHA
//   for Eric Hartman queries") via the optional cardNumberRe.

// CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14: "fix it").
//
// The TCG `POS/TOTAL` card-number rule below had no vertical guard, so it fired
// on SPORTS titles too, where `N/M` means something completely different:
//
//   "Macklin Celebrini OL 22/30"
//     cardNumber "22/30" -> slug ...:2230:...  + printRun 30
//
// 22/30 is a SERIAL. The real card number is "OL", sitting in the same title,
// discarded. One token consumed twice, and the resulting slug can never match —
// no checklist contains card #2230. Verified against raw titles: 206 of 208
// decided cases were this bug (99%), covering ~6,500 slugs and ~32,000 stuck
// sales, with ~5,600 phantom cards already in sold_comps.
//
// The Pokemon half is the mirror image. There, "40/147" really IS the card
// number (card 40 of a 147-card set) — but extractPrintRun ALSO read 147 as a
// print run, so the slug carried `:num-147` and matched nothing. A set size is
// not a print run.
//
// Both halves are the same root cause: the `N/M` token was interpreted without
// asking what it means in this vertical. So the vertical now decides. It is
// taken from the caller when known, and otherwise detected from the title by
// classifyTcg — the same pure classifier the ingest path already uses, so the
// two cannot disagree.
import { classifyTcg } from "./tcgVertical.service.js";
import { canonicalVariationName, readVariationFromTitle, type VariationMarker } from "../catalog/variationVocabulary.js";
import { checklistSaysAuto, type ChecklistAutoResolver } from "../catalog/checklistAutoLookup.js";
import { POKEMON_SET_ALIASES } from "../catalog/pokemonSetAliases.js";
import {
  POKEMON_EN_SET_CODES,
  POKEMON_PROMO_SET_CODES,
  POKEMON_JA_SET_CODES,
  AMBIGUOUS_MARKET_CODES,
} from "../catalog/pokemonSetCodes.js";
import { slugify } from "./hobbyIqCardId.service.js";
import { statedFinishFromChecklist } from "./statedFinishFromChecklist.js";

/** TCG `POS/TOTAL` card number, e.g. "008/132". Position CAN exceed the total
 *  (secret/hyper rares are numbered above set size), so only the <=400 bound
 *  is enforced, not num <= total.
 *
 *  The `#` in the leading class matters: sellers write BOTH "40/147" and
 *  "#044/193". Without it the generic #-prefix rule wins on the second form,
 *  returns "044", and silently drops the set half — which is a different card
 *  number and matches nothing. */
const TCG_NUMBER_RE = /(?:^|[\s#])(\d{1,3})\/(\d{1,3})(?:\s|$)/;
/** Global twin of the above, used to REMOVE the token before print-run
 *  extraction so a set size is never mistaken for a print run. */
const TCG_NUMBER_RE_G = /(?:^|[\s#])(\d{1,3})\/(\d{1,3})(?=\s|$)/g;

// CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE (Drew, 2026-09-05, from the #1796
// unknown-setKey census).
//
// THE DEFECT. The census measured ~22,780 sold_comps rows (extrapolated from a
// 60k sample of 889,860 setKey=unknown rows) refused as
// `guard:cardnumber-unparsed` whose titles DO state a card number. Every one of
// them is a Pokemon title, and every one fails for the same reason: this parser
// only reads a number written as `#N`, plus the ONE `N/M` shape above, which is
// delimited by whitespace or `#` and bounded at 3 digits on both halves. Pokemon
// sellers write the number six other ways, none of which that regex sees.
// Measured against 3,117 real pokemon rows sampled from the unknown population:
//
//   559  plain N/M that the bound or the delimiter rejects
//          "759/742 MC Japanese"         total > 400, and 3+ digits
//          "017/000 SWSH Shining Fates"  total 000 fails `total > 0`
//   263  a promo code glued to its era     "Pokemon SWSH180", "SM211"
//   127  a subset code over its subset total  "TG09/TG30", "GG10/GG70"
//    68  "SV107" secret-rare codes
//    15  the e-Card holo run                "H03/H32", "H25/H32"
//     9  the Japanese vintage spelling      "No. 141", "No.094"
//     8  a lettered position                "77a/73"
//     3  the number in brackets             "[077/067]", "(23/83)"
//
// WORSE THAN NULL: `extractPrintRun` then reads the TOTAL as a print run, so
// "[077/067]" yields cardNumber null AND printRun 67 -- a set size sold as a
// serial number. The N/M removal that prevents that is keyed to the same
// too-narrow regex, so it never fires on any of these shapes either.
//
// WHY THIS IS SAFE FOR SPORTS, WHICH IS THE WHOLE RISK. In sports `N/M` is a
// SERIAL and a bare integer is a listing index -- CF-SERIAL-IS-NOT-A-CARDNUMBER
// documents the 99%-wrong outcome when that was got wrong, ~6,500 slugs and
// ~32,000 stuck sales. So NONE of these forms is enabled by `isTcg`, which is
// true for Yu-Gi-Oh and One Piece too. They are enabled only when the vertical
// is POKEMON specifically, decided by `isPokemonVertical` below from the
// caller's own `vertical` field or an unmistakable title/slug signal. A sports
// title cannot reach this code, and the mutation test proves it: delete the
// pokemon gate and a sports-title-reads-a-bare-number test goes red.
//
// AMBIGUOUS MEANS NULL. Where two candidate numbers survive, the parser returns
// null rather than picking one -- absent beats wrong, because a wrong number
// files a real sale onto a card that does not exist and the slug agrees with
// the parse, so nothing downstream catches it.
//
// NOTHING HERE TOUCHES isAuto. `isAuto` is decided by the cardNumber PREFIX
// (isCardNumberAutoSubset, keyed to baseball subsets CPA-/BCPA-/BSPA-/...), and
// no form added here can produce one of those prefixes: they are digits,
// digits/digits, or the TG/GG/SV/SWSH/SM/XY/BW/H era codes. Pinned by a test.

/** `N/M` in a Pokemon title, where the TOTAL is the set size and never part of
 *  the identity. Wider than TCG_NUMBER_RE on every axis that measured a miss:
 *  brackets and parens as delimiters, up to 4 digits a side, a lettered
 *  position ("77a/73"), and a total of `000` -- all real spellings, none of
 *  which can occur in a sports title reachable from here. */
const POKEMON_NUMBER_OVER_TOTAL_RE =
  /(?:^|[\s#[(])(\d{1,4}[a-z]?)\s*\/\s*(\d{1,4})(?=[\s\])]|$)/i;

/** The same, global, to REMOVE the token before print-run extraction so a set
 *  size is never sold as a serial. */
const POKEMON_NUMBER_OVER_TOTAL_RE_G =
  /(?:^|[\s#[(])(\d{1,4}[a-z]?)\s*\/\s*(\d{1,4})(?=[\s\])]|$)/gi;

/** A subset/promo code over its own subset total: "TG09/TG30", "GG10/GG70",
 *  "H03/H32". The POSITION is the whole left half ("TG09") and keeps its
 *  spelling verbatim -- normalizePokemonCardNumber rule 3 never pads it. */
const POKEMON_SUBSET_OVER_TOTAL_RE =
  /(?:^|[\s#[(])((?:TG|GG|GH|SV|H)\d{1,3})\s*\/\s*(?:TG|GG|GH|SV|H)?\d{1,3}(?=[\s\])]|$)/i;

/** A bare era/subset code with no total: "SWSH180", "SM211", "TG03", "SV107",
 *  "XY42", "BW34". These are the Black Star promo and subset numbering schemes
 *  and are card numbers wherever they appear in a Pokemon title.
 *
 *  `SV` is on this list ONLY because the pokemon gate keeps sports out. A bare
 *  `SV\d+` in a SPORTS title is a Topps Chrome Sapphire card number and a
 *  different card entirely -- the exact collision CF-TCG-ERA-PREFIX-COLLISION
 *  had to repair once already. */
const POKEMON_PROMO_CODE_RE =
  /(?:^|[\s#[(])((?:SWSH|SM|XY|BW|TG|GG|GH|SV)\d{1,3})(?=[\s\])]|$)/i;

/** The Japanese vintage spelling: "No. 141", "No.094", "No 197". The word `No`
 *  is the seller stating this IS the card number, so it outranks the bare-token
 *  walk and is not subject to its ambiguity refusal. */
const POKEMON_NO_PREFIX_RE = /\bNo\.?\s*(\d{1,4})\b/i;

/** Tokens that precede a number that is NOT this card's number. Used by the
 *  bare-standalone walk, which is the only form here with no syntactic marker
 *  of its own and therefore the only one that must prove a negative. */
// CF-RAW-IS-A-GRADE-WORD (I9 run 34029662735). Every GRADER token is here --
// PSA, BGS, CGC -- because "PSA 10" states a grade and not a card number. But
// the pool's largest Pokemon source spells an UNGRADED sale " - Raw 10", and
// "RAW" was missing from this list, so that trailing 10 survived the walk as a
// candidate number.
//
// On its own that is harmless: two surviving candidates are AMBIGUOUS and the
// walk returns null. The damage needs the second half -- "EX" sits in
// CONDITION_WORDS as the sports condition "EX(cellent)", and in Pokemon "Ex" is
// the card's RARITY SUFFIX ("Jolteon Ex 030"), so the real number was skipped
// as a graded-condition follower. One candidate was left standing, and it was
// the grade.
//
// Measured over five Prismatic Evolutions pools (8,301 re-derived rows): 2,839
// rows derived a cardNumber that is the GRADE, against 913 whose only
// difference is the checklist's zero-padding. The grade defect is 3x the
// padding class it was mistaken for, and it is the one that files a real sale
// onto a card that does not exist.
const POKEMON_NOT_A_NUMBER_BEFORE: ReadonlySet<string> = new Set([
  "PSA", "BGS", "SGC", "CGC", "BVG", "HGA", "TAG", "ACE", "GMA", "KSA",
  "GEM", "MINT", "PRISTINE", "GRADE", "GRADED", "POP", "LOT", "OF", "X",
  "QTY", "ED", "EDITION", "SERIES", "GEN", "GENERATION", "VOL", "SET",
  "PACK", "BOX", "PSADNA", "CERT", "RAW",
]);

/**
 * The condition words that are NOT condition words in a Pokemon title.
 *
 * "EX" is the one that matters: it is `EX(cellent)` on a 1975 Topps listing and
 * the rarity suffix on "Jolteon Ex 030". CONDITION_WORDS is shared with the
 * SPORTS reader (the bare-number walk below), where dropping "EX" would let a
 * grade become a card number -- so the exemption is applied HERE, in the
 * pokemon walk only, and the sports list is left exactly as it is.
 *
 * "GX" and "V" follow for the same reason; they are Pokemon rarity suffixes
 * that no sports grade uses.
 */
const POKEMON_NOT_A_CONDITION_WORD: ReadonlySet<string> = new Set(["EX", "GX", "V"]);

/**
 * A bare standalone number in a Pokemon title -- the LAST resort, and the only
 * form that can be genuinely ambiguous.
 *
 * THE RULE IS EXACTLY ONE CANDIDATE. Every numeric token in the title is
 * examined and disqualified if anything else claims it: a year (1996-2035, the
 * Pokemon TCG's whole life), a price ("$127"), a grade or a pop count (the
 * token before it is a grader or a condition word), a lot count ("Lot of 76"),
 * or a print run (a leading `/`). If exactly ONE token survives, it is the card
 * number. If two survive, the answer is NULL -- the title states two things
 * that could be the number and this parser does not guess which. Removing that
 * refusal turns a corpus pin red.
 */
function pokemonBareCardNumber(title: string): string | null {
  const toks = String(title).split(/\s+/).filter(Boolean);
  const found: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    // A token carrying a `/` was already offered to the N/M rules; whatever
    // they made of it, it is not a BARE number.
    if (raw.includes("/")) continue;
    // A price is not a card number.
    if (/[$\u20ac\u00a3\u00a5]/.test(raw)) continue;
    const tok = raw.replace(/^[[(#]+/, "").replace(/[\]),.!;:]+$/, "");
    if (!/^\d{1,4}$/.test(tok)) continue;
    const n = Number(tok);
    if (!(n > 0)) continue;
    // A 4-digit token in the TCG's lifetime is the SET YEAR. Pokemon numbers a
    // handful of cards above 999 only in Japanese "MC"-style promo runs, and
    // conceding those is the cheap side of this trade.
    if (tok.length === 4 && n >= 1996 && n <= 2035) continue;
    const prevRaw = i > 0 ? toks[i - 1] : "";
    const prev = prevRaw.toUpperCase().replace(/[^A-Z]/g, "");
    if (POKEMON_NOT_A_NUMBER_BEFORE.has(prev)) continue;
    // CF-RAW-IS-A-GRADE-WORD: "Ex"/"GX"/"V" before a number is a Pokemon
    // RARITY suffix, never a condition. Skipping it here discarded the card's
    // real number and left the grade standing alone as the only candidate.
    if (CONDITION_WORDS.has(prev) && !POKEMON_NOT_A_CONDITION_WORD.has(prev)) continue;
    // "Lot of 76" / "lot 76" -- the count of cards in a lot, not a card number.
    if (/\blot\b/i.test(prevRaw) || (prev === "OF" && /\blot\b/i.test(toks[i - 2] ?? ""))) continue;
    // A print run states the DENOMINATOR alone: "/99". The token walk splits on
    // whitespace so "/99" arrives whole and is caught by the `/` test above,
    // but "Card /99" can leave the slash on the previous token.
    if (prevRaw.endsWith("/")) continue;
    found.push(tok);
    if (found.length > 1) return null;   // ambiguous -- absent beats wrong
  }
  return found.length === 1 ? found[0] : null;
}

/** Read a Pokemon card number from the title, most-specific form first.
 *  Returns null when the title states nothing this function can stand behind. */
function pokemonCardNumber(title: string): string | null {
  // A subset code over its subset total is the most specific shape: the left
  // half carries a prefix, so nothing else in a title is written this way.
  const subset = title.match(POKEMON_SUBSET_OVER_TOTAL_RE);
  if (subset) return subset[1].toUpperCase();

  // POS/TOTAL. The total is the set size and is dropped downstream by
  // normalizePokemonCardNumber; it is kept in the parse because the number the
  // seller PRINTED is the evidence and the padding rule needs to see it.
  const overTotal = title.match(POKEMON_NUMBER_OVER_TOTAL_RE);
  if (overTotal) return `${overTotal[1]}/${overTotal[2]}`.toUpperCase();

  // A bare era/subset code -- "SWSH180", "TG03", "SV107".
  const promo = title.match(POKEMON_PROMO_CODE_RE);
  if (promo) return promo[1].toUpperCase();

  // "No. 141" -- the seller has SAID this is the number.
  const no = title.match(POKEMON_NO_PREFIX_RE);
  if (no) return no[1];

  // A bare standalone integer, only when nothing else in the title could be it.
  return pokemonBareCardNumber(title);
}

/** TCG verticals that are NOT pokemon. A row filed under one of these is never
 *  read by the pokemon rules even if its title happens to say "Pokemon". */
const TCG_NON_POKEMON_VERTICALS: ReadonlySet<string> = new Set([
  "yugioh", "mtg", "lorcana", "anime-tcg", "tcg-other",
]);

/** True when the row is POKEMON specifically, not merely TCG.
 *
 *  Every rule above is gated on this and not on `isTcg`, because `isTcg` is
 *  also true for Yu-Gi-Oh, One Piece, Magic and Lorcana, whose numbering
 *  conventions are different ("OP07-038", "MRL-047") and whose bare integers
 *  have not been measured. Widening to them is a separate change with its own
 *  corpus. */
function isPokemonVertical(title: string, vertical?: string | null, slug?: string | null): boolean {
  const v = String(vertical ?? "").trim().toLowerCase();
  if (v === "pokemon") return true;
  if (v && TCG_NON_POKEMON_VERTICALS.has(v)) return false;
  const slugStr = String(slug ?? "");
  // A slug already in the pokemon namespace is the pipeline's own verdict.
  if (/^hiq:pokemon:/i.test(slugStr)) return true;
  return /\bpok[e\u00e9]mon\b/i.test(`${title} ${slugStr}`);
}

export interface ParseListingIdentityOptions {
  /** Vertical when the caller already knows it (vendor feed field, resolved
   *  slug, etc). Authoritative — checked before title detection. */
  vertical?: string | null;
  /** Canonical slug when available. Carries the setKey, which survives in
   *  cases where the title is too terse to classify. */
  hobbyiqCardId?: string | null;
  /** CF-A-TITLE-THAT-NAMES-A-FINISH-IS-NOT-A-BASE-CARD (I9 triage, 2026-09-06).
   *  The product's year + setKey, so the CHECKLIST can say which parallels this
   *  card HAS when the title states one no rule enumerates. Same shape and same
   *  reasoning as `InferIsAutoInput.year/setKey`.
   *
   *  Optional, and the reader degrades rather than guessing: with a product it
   *  reads that product's checklist; without one it falls back to the global
   *  name index under stricter floors. Callers that derive the setKey AFTER the
   *  parse (slugRederivation) pass nothing and lose only the product-scoped
   *  half. */
  year?: number | null;
  setKey?: string | null;
}

export interface ParsedListingIdentity {
  cardNumber: string | null;
  parallel: string;
  isAuto: boolean;
  printRun: number | null;
  autoStyle: "on-card" | "sticker" | null;
  /** CF-GRADE-FROM-TITLE (Drew, 2026-08-01). "PSA 9", "BGS 9.5", "SGC 10",
   *  "PSA 10 GEM MINT" etc. — extracted from title. Null when raw. */
  gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | "HGA" | null;
  gradeValue: number | null;
  /** CF-A-VARIATION-IS-A-CARD (D22). A weak variation marker the title
   *  carries WITHOUT naming a variation — bare "SP", "SSP", "Short Print",
   *  or a standalone "IV" out of context. The seam corroborates it against
   *  the product's checklist; this parser never guesses. */
  variationMarker: VariationMarker | null;
}

// CF-GRADE-FROM-TITLE (Drew, 2026-08-01). Matches:
//   "PSA 9", "PSA 10", "PSA 10 GEM MINT", "PSA GEM MT 10",
//   "BGS 9.5", "BGS 10 PRISTINE", "SGC 10", "SGC 9.5",
//   "CGC 10", "CGC 9.5", "HGA 9"
// Value: 1-10, half-point steps for BGS/SGC/CGC.
const GRADE_RE = /\b(PSA|BGS|SGC|CGC|HGA)\s+(?:GEM\s+M(?:INT|T)\s+|PRISTINE\s+|MINT\s+)?(\d{1,2}(?:\.5)?)\b/i;

export function extractGradeFromTitle(title: string): { gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | "HGA" | null; gradeValue: number | null } {
  if (!title) return { gradeCompany: null, gradeValue: null };
  const m = String(title).match(GRADE_RE);
  if (!m) return { gradeCompany: null, gradeValue: null };
  const company = m[1].toUpperCase() as "PSA" | "BGS" | "SGC" | "CGC" | "HGA";
  const value = Number(m[2]);
  if (!Number.isFinite(value) || value < 1 || value > 10) return { gradeCompany: null, gradeValue: null };
  return { gradeCompany: company, gradeValue: value };
}

/** Default cardNumber regex — matches the common Bowman/Topps/Panini
 *  slab-printed formats. Caller-passed regexes take precedence when a
 *  specific target is known. */
// CF-PAPER-AUTO-CARDNUMBERS (Drew, 2026-07-29). Bowman flagship (paper)
// carries autograph subsets on paper stock — Bowman Prospect Autographs
// (BPA-XX), Bowman Draft Autographs (BDA-XX), Bowman Chrome Rookie Autos
// on paper (BCRA-XX overlaps chrome variant), Topps Chrome Rookie Autos
// paper (TCRA-XX). Card-number prefix is the disambiguating signal —
// CPA/BCPA/BCDA/BDPA on chrome stock, BPA/BDA on paper stock.
//
// CF-HERITAGE-BARE-CARDNUMBER (Drew, 2026-07-29). Topps Heritage +
// vintage Topps use bare digit card numbers like #136, #500. The prior
// regex required 1-3 leading letters before digits, so #136 got no
// match and Heritage rows shipped with cardNumber=null. Now accepts
// 1-4 pure digits after '#' as a fallback alternative.
// CF-CARDNUM-LOOSEN (Drew, 2026-08-02). Original regex required `#` with
// zero whitespace before the number. Real eBay titles from the TCA
// firehose showed 30% of skips are titles with `# NN` (space between)
// or `NN` standalone in a card-number-shaped position. Add `\s*` after
// the `#` and preserve the strict letter-prefix formats for high-signal
// SKUs like BCP-102 / CPA-EH / US175.
// CF-A-TRAILING-LETTER-IS-PART-OF-THE-NUMBER (2026-09-04). The alternation
// below reads letter-LED codes (`US88`, `CPA-EW`, `BCP-102`) and bare
// integers, but had no alternative for the digits-THEN-letter shape. On
// "#70T" the bare `\d{1,4}` branch matched "70" and the trailing `\b` then
// failed against the "T", so the whole regex returned NO MATCH and the card
// number came back null -- while "#T70" (letters first) parsed correctly.
//
// That shape is not an edge case: it is how every Topps Traded, Score
// Traded and Fleer Update card is numbered (#70T Greg Maddux, #41T Griffey,
// #20T Canseco, #24T Coleman). Measured read-only on 2026-09-04: of 3,000
// sampled sold_comps titles containing "traded" and a "#", 2,358 carry the
// `#<digits><letter>` shape.
//
// A null cardNumber is not a harmless gap -- it is what feeds the
// `player-<name>` pseudo-cardNumber shape (hobbyIqCardId.service.ts:114-125,
// where `isUnnumberedCardNumber` treats a PARSE FAILURE as the vendor
// asserting "this card has no number"). 89,138 sold_comps rows carry that
// shape today, 87,671 of them with a null cardNumber, and the resulting
// buckets pool unrelated cards: `hiq:baseball:1987:topps:player-todd-worrell
// :base:no-auto` holds Wade Boggs, Greg Maddux and David Cone sales.
//
// The new alternative is placed BEFORE the bare `\d{1,4}` so it wins on the
// titles it is for, and it cannot change any title that has no trailing
// letter -- pinned in tradedTiffanySetKey.test.ts.
// The optional `-[A-Z0-9]{1,6}` tail keeps the retro-insert shape whole:
// "#83T-6" (2018 Topps Chrome 1983 Topps refractor) is ONE card number, and
// matching only its "83T" prefix would split a real SKU. Pinned by
// cardNumberIntegrityParity.test.ts, which caught exactly that on the first
// version of this alternative.

const DEFAULT_CARD_NUMBER_RE =
  /#\s*([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4}|BCP-\d+|CPA-\w+|BSPA-\w+|BCPA-\w+|BDCA-\w+|BPA-\w+|BDA-\w+|BCRA-\w+|TCRA-\w+|CPALD|CPATWH|BDC-\d+|HL\d+|US\d+|\d{1,4}[A-Z](?:-[A-Z0-9]{1,6})?|\d{1,4})\b/i;

// CF-CARDNUM-STANDALONE (Drew, 2026-08-02). Second-chance regex for when
// the title has no `#` at all but a plausible card-number-shaped token
// appears after the year+set+player triple. Requires the token to be
// preceded by whitespace and followed by whitespace / EOL / PSA-style
// grader, and to NOT be a print run (no leading `/`).
// Example: "2023 PANINI SELECT GOLD GLITTER JALEN BRUNSON 194 PSA 10" → 194
const STANDALONE_CARD_NUMBER_RE =
  /(?:^|\s)(\d{1,4})(?=\s+(?:PSA|BGS|SGC|CGC|BVG|HGA|GEM|MINT|NM|RC|ROOKIE|GRADED|RAW|$))/i;

// CF-A-GRADE-IS-NOT-A-CARD-NUMBER (Drew, 2026-08-24). The regex above has a
// lookahead but no lookbehind, so on a title with no `#` it reads the GRADE:
//
//   "1972 Icee Bear Set Break Wilt Chamberlain PSA 9 MINT"  -> cardNumber "9"
//   "... Wilt Chamberlain SGC 8 NM-MT"                      -> cardNumber "8"
//   "CGC 10 GEM MINT Entei ... Movie Promo 34"              -> cardNumber "10"
//
// "9" is followed by MINT, which is on the follower list, so it matched. The
// damage is not one bad field: it SPLITS ONE CARD INTO ONE ROW PER GRADE, so a
// single Wilt Chamberlain became cards #7, #8, #9 and #10, each with its own
// comp pool. Caught in a dry run before any row was written.
//
// The discriminator is the token BEFORE the number. A number directly after a
// grading company or a condition word is that company's grade.
const GRADER_BEFORE_NUMBER = new Set([
  "PSA", "BGS", "SGC", "CGC", "BVG", "HGA", "KSA", "GMA", "ACE", "TAG", "RCG",
  "ISA", "CSG", "AGS", "RAW", "GEM", "MINT", "PRISTINE", "GRADE", "GRADED",
]);
// Condition vocabulary, hyphens removed so "EX-MT" and "NM-MINT" both land
// here. Two uses, and enumerating the family beats enumerating its members:
//   1. "PSA EX-MT 6" -- the token before the number is the condition, not the
//      grader, so a grader-only check missed it and read card number "6".
//   2. "NR-MT" and "NM-MINT" are shaped exactly like a prefixed SKU and are
//      printed in caps, so neither the shape test nor the caps test rejects
//      them. Both halves being condition words does.
const CONDITION_WORDS = new Set([
  "NR", "NM", "MT", "EX", "VG", "GD", "PR", "FR", "PO", "MINT", "NEAR", "GEM",
  "POOR", "FAIR", "GOOD", "VERY", "EXMT", "NMMT", "NRMT", "NMMINT", "NRMINT",
  "EXMINT", "GEMMT", "VGEX", "GDVG", "MTNM", "NRMINT", "AUTHENTIC", "ALTERED",
]);
// Followers that make a bare number card-number-shaped, per CF-CARDNUM-STANDALONE.
// Matched by prefix so "NM-MT" counts via "NM".
const NUMBER_FOLLOWERS = [
  "PSA", "BGS", "SGC", "CGC", "BVG", "HGA", "GEM", "MINT", "NM", "RC",
  "ROOKIE", "GRADED", "RAW",
];

/** Bare card number with no '#', skipping grades and years.
 *  Written as a token walk rather than a lookbehind: the preceding-token test
 *  is a set membership, and string comparison does not have escape bugs. */
function standaloneCardNumber(title: string): string | null {
  const toks = String(title).split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/[^0-9]/g, "");
    if (!tok || tok.length > 4 || tok !== toks[i]) continue;
    // A 4-digit token in year range, with no '#' to make it explicit, is the
    // set year far more often than it is card #1972.
    const n = Number(tok);
    if (tok.length === 4 && n >= 1900 && n <= 2035) continue;
    const prev = i > 0 ? toks[i - 1].toUpperCase().replace(/[^A-Z]/g, "") : "";
    if (GRADER_BEFORE_NUMBER.has(prev) || CONDITION_WORDS.has(prev)) continue;
    // A follower must actually be present. End-of-string does NOT qualify: in
    // "2025 Bowman Draft CPA-EW Eli Willits Yellow Refractor Auto 75" the
    // trailing 75 would otherwise win and pre-empt the prefixed rule, which is
    // the one that knows the card number is CPA-EW.
    const next = i + 1 < toks.length ? toks[i + 1].toUpperCase() : "";
    if (next && NUMBER_FOLLOWERS.some((f) => next.startsWith(f))) return tok;
  }
  return null;
}

// CF-STANDALONE-PREFIXED-CARDNUMBER (Drew, 2026-08-24). The two regexes above
// cover "#SMLB-10" and a bare "194", but not a PREFIXED number with no hash:
//
//   "2025 Topps Stars of MLB SMLB-10 Shohei Ohtani ..."   -> cardNumber null
//   "2025 Bowman Draft CPA-EW Eli Willits Yellow Refractor" -> cardNumber null
//
// Both state the card number plainly. Nothing read it, and canonicalize's
// fuzzy step requires a cardNumber, so every such sale failed to match — the
// same shape as "Gold Ref." parsing to plain Refractor.
//
// Guarded, because titles are full of hyphenated words that are not card
// numbers. The suffix must contain a digit or be short and uppercase (CPA-EW),
// and grade/condition compounds are excluded outright — those are the ones
// that actually appear in this position.
const NOT_A_CARD_NUMBER = new Set([
  "ALL-STAR", "ALL-STARS", "SET-BREAK", "ON-CARD", "EX-MT", "NM-MT", "GEM-MT",
  "VG-EX", "PO-FR", "GD-VG", "ONE-OF", "SHORT-PRINT", "HALL-OF", "DIE-CUT",
  "MULTI-SPORT", "RE-PACK", "PRE-SALE", "LOW-POP", "HIGH-END", "MINI-DIAMOND",
  // CF-GAME-USED-IS-NOT-A-SKU (Drew, 2026-08-24). "Game-Used" fits the shape
  // exactly -- 4 letters, hyphen, 4 alphanumerics -- so every 2001 Fleer
  // Legacy relic resolved to card number "GAME-USED", collapsing every relic
  // in the set onto one row. Same for "Game-Worn".
  "GAME-USED", "GAME-WORN", "GAME-ISSUED", "PLAYER-WORN", "TAILOR-MADE",
  "BLACK-LABEL", "DUAL-AUTO", "TRIPLE-AUTO", "BOX-BREAK", "CASE-BREAK",
  "TEAM-SET", "TOP-LOADER", "ONE-TOUCH", "TRI-COLOR", "TWO-COLOR",
]);
const STANDALONE_PREFIXED_CARD_NUMBER_RE = /(?:^|\s)([A-Z]{2,6}-[A-Z0-9]{1,6})(?=\s|$)/i;

// Note: `on card` alone does NOT imply auto — "On Card Display" and
// similar non-auto phrases exist. Explicit \bauto\b or "autograph" or
// "hard signed" are required. When "On Card Auto" appears, \bauto\b
// picks it up.
//
// CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE (measured 2026-09-04).
//
// This regex bounded `auto` on BOTH sides and `autograph` on NEITHER, so any
// title containing the letters a-u-t-o-g-r-a-p-h anywhere inside a longer
// word read as an autograph. eBay shop names are appended to the title by the
// seller, and one shop is enormous:
//
//   "Vladimir Guerrero Jr. 2025 Bowman #27 Blue Jays MLB READ FREE SHIP AutographDen"
//
// 102,621 of 271,664 scanned sold_comps rows carried isAuto=true on this
// defect, 102,482 of them from the single phrase "autographden", across ~40
// years of base cards. Base cards were priced as autographs, and every real
// autograph pool was diluted with base sales.
//
// THE FIX IS THE WORD BOUNDARY, AND THE BOUNDARY DOES MOST OF THE WORK.
// Bounding `autograph` to its real inflections (`autograph`, `autographs`,
// `autographed`) already excludes `AutographDen`, because `Den` is not one of
// them -- no seller list is needed for the general case. The corpus agrees:
// over 61,793 titles containing the letters, the only forms appearing at
// scale are
//
//   28,638  autographden      <- a shop name, never a card
//   19,681  autograph         <- real
//   12,397  autographs        <- real
//      940  autographed       <- real
//      190  autographics      <- a REAL Skybox insert set, see below
//
// plus a 9-row tail of typos ("chromeautograph", "metalautograph").
//
// WHY THERE IS STILL AN EXPLICIT SELLER LIST. The boundary is necessary but
// not sufficient: a shop name can END in a real inflection ("Autographs
// Unlimited"), and would then read as evidence. So known shop tokens are
// named and subtracted BEFORE the witness test. The list is DERIVED FROM THE
// CORPUS, not invented -- `autographden` is the one seller token measured
// here, and a speculative list of store suffixes would be vocabulary the data
// does not support.
//
// `autographics` IS NOT ON THAT LIST AND MUST NEVER BE, AND IT IS NAMED IN THE
// WITNESS. It looks exactly like a shop name and is not one: it is Skybox's
// autograph INSERT SET (1996-97 Skybox Premium Autographics, 2004-05 Skybox
// Autographics, 2006 Flair Showcase Autographics), 190 rows here.
//
// It is listed explicitly BECAUSE the boundary would otherwise drop it. It is
// not an inflection of `autograph`, so `\bautograph(?:ed|s)?\b` does not
// match it, and AUTO_SETNAME_RE does not either (its `autographs?` is bounded
// the same way). Measured on the shipped parser before this change, all three
// of those titles read isAuto=true; without this alternation the fix would
// have SILENTLY FLIPPED REAL AUTOGRAPHS TO FALSE -- the exact damage this PR
// exists to undo, running in the opposite direction. The seller-name fix must
// cost nothing on the cards that really are signed.
const SELLER_SHOP_TOKEN_RE = /\bautographden\b/i;

/** The autograph witness in a title. `autograph` is bounded to its real
 *  inflections, so a longer word that merely contains it is not evidence.
 *  Exported as THE ONE SOURCE: the attestation guard and the rematch
 *  classifier's mirror read this exact shape, and a second copy would drift
 *  silently back into the defect described above. */
export const AUTO_RE =
  /\bauto\b|\bautograph(?:ed|s)?\b|\bautographics\b|hard[-\s]signed/i;

/** THE DEFECTIVE SHAPE, KEPT ON PURPOSE -- `autograph` unbounded, the exact
 *  regex that minted the 102,621 wrong rows. `autographWitnessIsSellerNameOnly`
 *  asks its question against THIS, not against the fixed witness above: under
 *  the fixed one `AutographDen` is already not a witness, so "strip the shop
 *  and the witness disappears" would be false for every row, and the predicate
 *  would identify nothing at all. For a STORED row the question is not "is
 *  this an autograph?" but "what did the reader that wrote this flag see?" --
 *  and that reader is this one. Exported so the rematch mirror pins the same
 *  shape, and so that deleting it is a test failure rather than a silent
 *  no-op. */
export const LEGACY_AUTO_RE = /\bauto\b|autograph|hard[-\s]signed/i;

/** True when the title's ONLY autograph witness is a known seller/shop token.
 *  Strip the shop name, then ask the question again: if nothing states an
 *  autograph any more, the shop name was the whole case. Exported so the
 *  rematch classifier can name the same witness rather than restate it. */
export function autographWitnessIsSellerNameOnly(title: string): boolean {
  if (!title || !SELLER_SHOP_TOKEN_RE.test(title)) return false;
  const withoutShop = title.replace(new RegExp(SELLER_SHOP_TOKEN_RE.source, "gi"), " ");
  return LEGACY_AUTO_RE.test(title) && !LEGACY_AUTO_RE.test(withoutShop);
}

/** Chrome products, where a bare colour IS that colour's Refractor.
 *  The chrome-auto SKU prefixes count as product context on their own: real
 *  titles are often just "Eric Hartman Red /5 #CPA-EHA", with the card number
 *  as the only thing naming the product. Same principle as the isAuto
 *  boundary -- the card number is the signal, not the marketing text. */
const CHROME_PRODUCT_RE =
  /bowman\s+chrome|topps\s+chrome|chrome\s+prospect|chrome\s+auto|bowman[^.]*chrome|#?\b(?:CPA|BCPA|BDPA|BCDA|BCRA|TCRA|FCA|CDA)-[A-Z0-9]+/i;

/** Team names that contain a colour word. Stripped before any bare-colour
 *  read, because "Blue Jays" is a team and "Blue" is a parallel.
 *
 *  Insert SET names carry colours too, and cost more than teams do. Measured
 *  on 8,500 sampled rows: "2010 Topps Chrome Carlos Santana Red Hot Rookies
 *  Refractor #RHR-1" was read as a Red Refractor, when it is a plain Refractor
 *  of the Red Hot Rookies insert. The colour belongs to the insert's NAME, not
 *  to the card's finish. Same shape as the team case, so the same treatment:
 *  remove the phrase by name before any colour is read. */
const TEAM_COLOUR_NOISE_RE =
  /\b(blue\s+jays?|red\s+sox|white\s+sox|green\s+bay|red\s+wings?|blue\s+jackets?|golden\s+knights?|red\s+raiders?|blue\s+devils?|red\s+bulls?|orange\s+bowl|black\s?hawks?|white\s+caps?|red\s+hot|blue\s+chip\w*|black\s+gold|gold\s+rush|gold\s+standard|gold\s+label|green\s+machine|purple\s+reign|red\s+zone|blue\s+ribbon|white\s+whale|black\s+friday|red\s+carpet|golden\s+age|silver\s+slugger|green\s+monster|black\s+diamond|white\s+sox|red\s+letter)\b/gi;
/** Phrases that mean the card is NOT signed, despite containing "auto".
 *
 *  CF-NON-AUTO-IS-NOT-AUTO (2026-08-19). This only listed "auto relic" and
 *  "auto patch", so `\bauto\b` matched the "Auto" inside "Non Auto" and every
 *  one of these parsed as SIGNED:
 *
 *    "WALKER JENKINS RC REFRACTOR ... Non Auto Rookie Holo"        -> isAuto true
 *    "2026 Bowman Chrome /199 Fuchsia Konnor Griffin Non-Auto"     -> isAuto true
 *    "2019 Bowman Prospects Yordan Alvarez #BP-123 ... Non Auto"   -> isAuto true
 *
 *  A $22.49 unsigned base card then sits in a signed card's comp pool and drags
 *  its floor — found while auditing a user's Walker Jenkins /499 refractor auto,
 *  whose pool ran from $22.49 to $769.
 *
 *  Note this governs the TITLE TEXT only. The card number remains the boundary
 *  (isCardNumberAutoSubset is OR'd in separately), so a CPA- number still reads
 *  as an auto even if a seller typed something careless. */
const AUTO_NEGATIVE_RE =
  /auto\s+relic|auto\s+patch|\bnon[-\s]?auto|\bno\s+auto|\bnot\s+auto|\bunsigned\b|\bwithout\s+auto/i;

/** CF-A-LOT-IS-NOT-A-CARD (Drew, 2026-08-31).
 *
 *  A title that sells SEVERAL cards does not state one card's finish, and a
 *  parallel read off it files a multi-card price into a single card's pool.
 *  These are the shapes the 2024 mix measurement triaged out — 211 rows it
 *  refused to repair rather than move to a still-wrong pool:
 *
 *    "2024 Bowman Chrome Lot Of 6 Refractors"
 *    "40x 2024 Topps Chrome Refractors"
 *    "(12 Cards) 2024 Bowman Chrome Refractors"
 *
 *  Exported so the repair pass excludes by the SAME rule the parser refuses
 *  by. Two copies of this list would drift, and the drift would show up as a
 *  repair moving rows the live parser would never have written.
 *
 *  EVERY IDIOM HERE MUST SIT NEXT TO A COUNT OF CARDS. The first round's
 *  lexicon was bare words — \blots?\b, \bmore\b, \bpick\b, \bcomplete\s+set\b,
 *  \b\d+\s*x\b — and each of them fires on ordinary single-card seller
 *  boilerplate, turning a correctly-parsed Refractor into Base:
 *
 *    "2024 Bowman Chrome Refractor Dylan Lot RC"          <- a SURNAME
 *    "... Elly De La Cruz MORE ROOKIES AVAILABLE"          <- cross-sell
 *    "2024 Bowman Chrome Refractor #12 Pick Your Card"     <- store boilerplate
 *    "2024 Bowman Chrome Refractor 10x Card Saver"         <- SHIPPING SUPPLIES
 *    "... Refractor Complete Set Break Single"             <- literally "Single"
 *
 *  A guard that eats singles is not conservative, it is wrong in the other
 *  direction: it writes Base over a finish the title plainly states. So each
 *  idiom now carries its own count evidence.
 *
 *    lot        — "Lot of 6", "6 Card Lot", "Lot (12)"; never a bare "Lot",
 *                 which is a surname often enough to matter.
 *    (N cards)  — unchanged; the parenthesised count is already unambiguous.
 *    N x        — must be followed by a CARD noun, not by a supply noun.
 *                 "10x Card Saver" and "10x Toploader" are the packaging the
 *                 single ships in. The old (?!\s*[-\s]?fractor) lookahead is
 *                 kept on top of that so "#1 X-Fractor" still reads as a card
 *                 number, and a bare "40x Refractors" still reads as a lot.
 *    bundle     — must name cards ("card bundle", "bundle of 5").
 *    more       — only the closing lot idiom "and N more", never a bare "more".
 *    pick       — only "you pick" / "pick your card" style multi-listings...
 *                 EXCEPT those are single-card sales from a multi-card listing,
 *                 so they are dropped entirely; the title still names ONE
 *                 card's finish.
 *    complete set — must not be a "set break SINGLE", which is one card.
 *
 *  THE MULTIPLIER NEEDS THE LOOKAHEAD, and the fixtures found out why. The
 *  measurement's triage regex used a bare \b\d+\s*x\b, which matches the "1 X"
 *  inside
 *
 *    "Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"
 *
 *  — a $107.50 SINGLE card, and one of the measurement's own headline examples
 *  of the bug. A quantity "x" is followed by a count of cards, never by the
 *  word fractor, so the lookahead separates "40x Refractors" and "25 x
 *  Refractors" (real lots) from a card number that happens to precede an
 *  X-Fractor. Without it this detector would refuse the exact population it
 *  exists to protect — the guard would eat the repair.
 *
 *  This means the measurement's 211/1,508 lot split is off in the conservative
 *  direction on two counts — the X-Fractor lookahead and now the narrowing —
 *  so the repair re-derives the split with THIS detector rather than
 *  inheriting that number, and the counters it prints are the ones to trust. */

/** CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD, at the source (audit gate 2026-09-03).
 *
 *  Every pattern-family rule below -- Shimmer, Lava, Wave, Ray Wave, Grass --
 *  enumerated its own colour list, and every one of those lists was
 *
 *      (orange|red|green|gold|blue|purple|yellow|aqua)
 *
 *  which omits black, pink, white, fuchsia, silver and bronze. A title the
 *  list could not match fell PAST the family rule and landed on the bare-colour
 *  scan below, which reads the colour and stops -- so
 *
 *      "BLACK WAVE /10"    ->  Black Refractor
 *      "Pink Wave"         ->  Pink Refractor
 *      "Fuchsia Wave"      ->  Fuchsia Refractor
 *      "Black Ray Wave"    ->  Black Refractor
 *
 *  Black Wave Refractor and Black Refractor are BOTH on the 2025 Topps Chrome
 *  football checklist. They are two cards with two print runs and two price
 *  curves, and collapsing one onto the other splits a pool and prices a /10
 *  against a /299. That is 22 of the writable IMPROVE lines the audit gate
 *  found, and the derivation is where they start.
 *
 *  ONE ladder, used by every family rule, so a colour cannot be present for
 *  Speckle (whose list already carried pink/black/silver) and absent for Wave.
 *  It matches the colours the bare-colour scan below already accepts, which is
 *  the ONLY way a family rule can be guaranteed to win the race against it --
 *  a colour that scan can read is a colour a family rule must be able to read
 *  first, or the family word is silently dropped.
 *
 *  The classifier guards this independently (GUARD 4 in rematch-classify.cjs
 *  refuses any write whose derived parallel lacks a finish family the title
 *  names), because a fixed enumeration is a fix, not a guarantee: the next
 *  family word nobody has enumerated fails exactly the same way, and the guard
 *  catches it as a refusal instead of a wrong write. Fixed at the source AND
 *  guarded at the write. */
const PATTERN_COLOUR = String.raw`(orange|red|green|gold|blue|purple|yellow|aqua|pink|black|white|fuchsia|silver|bronze|teal|sepia)`;

/** Nouns that mean "a card", for the count-adjacency tests below. */
const LOT_CARD_NOUN = String.raw`(?:cards?|commons?|rookies|rc'?s|singles?|slabs?|autos?|refractors?|parallels?|inserts?|prospects?)`;
/** Nouns that mean "packaging", which a count in front of does NOT make a lot. */
const LOT_SUPPLY_NOUN = String.raw`(?:card\s*saver|top\s*loader|toploader|penny\s*sleeve|sleeves?|magnetic|one\s*touch|onetouch|holder|screwdown|box(?:es)?|bcw)`;

const LOT_RE = new RegExp(
  [
    // "Lot of 6", "Lot (12)", "Lot: 6" — the count follows the word.
    String.raw`\blots?\b[\s:]*(?:of\s+)?\(?\s*\d+`,
    // "(4x LOT)", "4x Lot" — a multiplier immediately in front of the word.
    String.raw`\b\d+\s*x\s*\)?\s*lots?\b`,
    // "(20) … Lot" — a leading parenthesised bare count anywhere in a title
    // that also says Lot. Measured on a 2024 pull: "(20) 2024 Bowman AI Chrome
    // Refractor Insert George Lombard Jr. #19 Rookie RC Lot" is twenty cards.
    // The count must be parenthesised and standalone, so a print run (/50) and
    // a card number (#19) cannot reach this.
    String.raw`\(\s*\d+\s*\)(?=.*\blots?\b)`,
    // "6 Card Lot", "12-card lot" — the count and noun precede it.
    String.raw`\b\d+\s*[-\s]?${LOT_CARD_NOUN}\s+lots?\b`,
    // "Lot of Refractors" / "Card Lot" — a card noun on either side.
    String.raw`\blots?\s+of\s+${LOT_CARD_NOUN}\b`,
    String.raw`\b${LOT_CARD_NOUN}\s+lots?\b`,
    // "(12 Cards)" — the parenthesised count is unambiguous on its own.
    String.raw`\(\s*\d+\s*cards?\s*\)`,
    // "40x Refractors", "25 x 2024 Topps Chrome Refractors" — a quantity
    // multiplier whose title goes on to name cards. The card noun is NOT
    // adjacent in practice: the year and product sit between them ("40x 2024
    // Topps Chrome Refractors"), so requiring adjacency here would let every
    // real lot through. What must be adjacent is the DISQUALIFIER — packaging.
    // "10x Card Saver" and "10x Toploader" are the supplies the single ships
    // in, and the supply noun always follows the count directly.
    //
    // The (?!\s*[-\s]?fractors?) lookahead is kept on top of that so the "#1 X"
    // of "Shohei Ohtani #1 X-Fractor" still reads as a card number.
    String.raw`\b\d+\s*x\b(?!\s*[-\s]?fractors?)(?!\w)(?!\s*${LOT_SUPPLY_NOUN})(?=.*\b${LOT_CARD_NOUN}\b)`,
    // "card bundle", "bundle of 5"
    String.raw`\b${LOT_CARD_NOUN}\s+bundle\b`,
    String.raw`\bbundle\s+of\s+\d+`,
    // "and 5 more", "+ 3 more cards" — the closing lot idiom, never a bare
    // "more" (which is "MORE ROOKIES AVAILABLE" cross-sell boilerplate).
    String.raw`\b(?:and|\+|plus)\s*\d+\s+more\b`,
    // "3 more cards" standing alone, with the same disqualifier the sibling
    // above gets for free from its and/+/plus anchor: the count must not be a
    // PRINT RUN. \b sits happily between "/" and "499", so "…#12 Judge /499
    // MORE ROOKIES AVAILABLE" matched "499 MORE ROOKIES" and filed a numbered
    // single as a lot -> Base. That title is cross-sell boilerplate attached to
    // one /499 card, and it is the exact shape the lexicon was narrowed to
    // stop. A slash before the digits means the number counts COPIES OF THIS
    // CARD, never cards in the listing.
    String.raw`(?<![/\d])\b\d+\s+more\s+${LOT_CARD_NOUN}\b`,
    // "complete set" — but a "set break single" is exactly one card.
    String.raw`\bcomplete\s+set\b(?!\s*break\b)`,
  ].join("|"),
  "i",
);

export function isMultiCardLot(title: string | null | undefined): boolean {
  const t = String(title ?? "");
  if (!t) return false;
  // "Set Break Single" / "Break Single" names ONE card no matter what else the
  // title says, so it settles the question before the lexicon runs.
  if (/\bbreak\s+single\b|\bsingle\s+card\b/i.test(t)) return false;
  return LOT_RE.test(t);
}

/** Extract identity from a marketplace title.
 *
 *  When cardNumberRe is provided, only that pattern is tried (useful
 *  when the caller knows the target card and wants to reject rows for
 *  other cards from the same search response). */
export function parseListingIdentity(
  title: string,
  cardNumberRe?: RegExp,
  opts?: ParseListingIdentityOptions,
): ParsedListingIdentity {
  const t = String(title ?? "");
  // CF-SERIAL-IS-NOT-A-CARDNUMBER. Decide the vertical ONCE, then let it govern
  // both readings of the `N/M` token. Callers that know the vertical should say
  // so — title detection is a fallback, and a Pokemon listing too terse to
  // classify will now yield cardNumber=null rather than a confidently wrong
  // number. Null is recoverable; a wrong identity silently files a real sale
  // against a card that does not exist.
  const isTcg = classifyTcg({
    sport: opts?.vertical ?? null,
    title: t,
    hobbyiqCardId: opts?.hobbyiqCardId ?? null,
  }).isTcg;
  // CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE. Narrower than isTcg on purpose --
  // only Pokemon's numbering conventions have been measured, so only Pokemon
  // rows get the wider reader.
  const isPokemon = isTcg && isPokemonVertical(t, opts?.vertical ?? null, opts?.hobbyiqCardId ?? null);
  const cardNumber = extractCardNumber(t, cardNumberRe, isTcg, isPokemon);
  // CF-CARDNUMBER-IMPLIES-AUTO (Drew, 2026-07-30). Auto-subset card
  // numbers carry a fixed prefix on ALL products — CPA-, BCPA-, BSPA-,
  // BDA-, BPA-, BCRA-, TCRA-, CA-, SPA-, CPALD-, etc. If the title
  // failed the AUTO_RE check but the card number is one of these,
  // trust the card number. This rescues terse marketplace titles that
  // omit "auto" but list a #CPA-XXX card number (very common when
  // sellers use CH's slab-derived title).
  const isAuto = extractIsAuto(t) || isCardNumberAutoSubset(cardNumber);
  const grade = extractGradeFromTitle(t);
  // CF-A-VARIATION-IS-A-CARD (D22). The variation family is read by the one
  // vocabulary; a named variation is the finish ("Image Variation", "Golden
  // Mirror Variation", the label form "Image Variation Chrome"), composed
  // ahead of any colour / refractor the title also names ("Image Variation
  // Gold Speckle Refractor"); a weak marker rides along for the seam.
  const variation = readVariationFromTitle(t.toLowerCase());
  // The product context the checklist reader needs. An explicit option wins;
  // otherwise the canonical slug carries both -- `hiq:sport:year:setKey:...` --
  // and a caller that already resolved the card has nothing else to pass.
  const slugParts = String(opts?.hobbyiqCardId ?? "").split(":");
  const fromSlug = slugParts[0] === "hiq" && slugParts.length >= 7
    ? { year: Number(slugParts[2]) || null, setKey: slugParts[3] || null }
    : { year: null as number | null, setKey: null as string | null };
  const finish = extractParallel(t, {
    year: opts?.year ?? fromSlug.year,
    setKey: opts?.setKey ?? fromSlug.setKey,
  });
  // The whitelist below already names some variations verbatim ("Chrome-Image
  // Variation"); that spelling is more specific than the family read and is
  // kept — the slug layer speaks the vocabulary either way.
  const parallel = variation.finish
    ? (canonicalVariationName(finish) ? finish
      : finish && !/^base$/i.test(finish) && !/^refractor$/i.test(finish) ? `${variation.finish} ${finish}` : variation.finish)
    : finish;
  return {
    cardNumber,
    parallel,
    variationMarker: variation.finish ? null : variation.marker,
    isAuto,
    printRun: extractPrintRun(t, isTcg, isPokemon),
    autoStyle: isAuto ? extractAutoStyle(t) : null,
    gradeCompany: grade.gradeCompany,
    gradeValue: grade.gradeValue,
  };
}

/** True when the cardNumber prefix belongs to a known BASEBALL autograph
 *  subset. Domain-curated list from Drew (2026-07-30) — where an
 *  empirically-low auto ratio contradicts the list, that's a signal
 *  that parser text-extraction is UNDER-tagging these products, which
 *  is exactly what this rule (+ backfill-isauto-from-cardnumber.cjs)
 *  is designed to fix.
 *
 *  BOWMAN FAMILY (all 100% auto by product definition):
 *    CPA   Chrome Prospect Autographs (Bowman/Bowman Chrome flagship 1st)
 *    CDA   Chrome Draft Pick Autographs (Bowman Draft)
 *    CRA   Chrome Rookie Autographs
 *    BPA   Bowman Prospect Autographs (paper, retail)
 *    PA    Paper Prospect Autographs / Bowman Inception Prospect Autos
 *    BSPA  Bowman Sterling Prospect Autographs (2016+)
 *    BGA   Bowman Glass Autographs (Draft insert)
 *    MRA   Mood Ring Autographs (Draft insert)
 *    DPPA  Draft Picks & Prospects Autographs
 *    54FAV Bowman '54 Flag Variation Autographs
 *    FFDA  Franchise Futures Dual Autographs
 *    APDCA Applied Pressure Autographs (Draft)
 *    UAC   Ultimate Autograph Book Card
 *    BA    Bowman's Best Autographs
 *    B96A  Bowman's Best "Best of '96" Autographs
 *    C##A  Class of [Year] Autographs (year-varying, C20A/C23A/etc)
 *
 *  TOPPS CHROME / CHROME-ADJACENT:
 *    RA    Topps Chrome Rookie Autographs (flagship auto)
 *    CUSA  Chrome Update Series Autographs
 *    CBA   Topps Chrome Black Autographs
 *    CCA   Cosmic Chrome Autographs
 *    FSA   Future Stars Autographs / Five Star Autographs (collision, both auto)
 *
 *  TOPPS HERITAGE:
 *    ROA   Real One Autographs
 *    RODA  Real One Dual Autographs
 *    ROTA  Real One Triple Autographs
 *    CCAR  Clubhouse Collection Autograph Relics
 *    FAR   Flashback Autograph Relics
 *
 *  OTHER TOPPS:
 *    GQA   Gypsy Queen Autographs
 *    FFA   Archives Fan Favorites Autographs
 *    AGA   Allen & Ginter Framed Autographs
 *    BSA   Baseball Stars Autographs (2021+)
 *    SCA   Stadium Club Autographs
 *    T1A   Tier One Autographs
 *    BOA   Tier One Break Out Autographs
 *    PPA   Tier One Prime Performers Autographs
 *    TA    Tribute Autographs
 *    AA    Museum Collection Archival Autographs
 *    DCA   Definitive Autograph Collection
 *    CAA   Clearly Authentic Autographs
 *    FA    Finest Autographs / Fire Autographs (collision, both auto)
 *    ODA   Opening Day Autographs
 *    TTAR  Triple Threads Autograph Relics
 *    UAR   Triple Threads Unity Autograph Relics
 *    IAP   Inception Autograph Patch
 *    AP    Dynasty Autograph Patches
 *
 *  PLUS earlier empirical additions:
 *    USA   Update Series Autographs — 100%, n=516
 *    SCCA  Sterling Chrome Certified — 93.3%, n=445
 *    DAS   Draft Autograph Series — 100%, n=254
 *    NTS   National Treasures Signatures — 100%, n=137
 *    SSM   Sterling Signature Materials — 100%, n=116
 *    CPALD, CPATWH  Chrome Prospect Auto special CH variants
 *    BCPA, BCRA, TCRA  Bowman Chrome Prospect/Rookie + Topps Chrome Rookie
 *                       (product convention, sub-100 sample)
 *
 *  Regex ordering: LONGEST alternatives first because JS regex
 *  alternation is left-to-right (not longest-match). "APDCA" MUST
 *  come before "AP" or every APDCA-XX would match as AP prefix.
 *
 *  Sport-awareness: currently BASEBALL-scoped implicitly (Drew's list).
 *  Football/basketball/hockey have their own auto-prefix vocab; this
 *  function may over-tag when applied cross-sport. Consider adding a
 *  sport param when we expand to other sports.
 *
 *  Silent-safe on null/empty. */
export function isCardNumberAutoSubset(cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  const AUTO_PREFIX = /^(CPATWH|CPALD|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CPA|CDA|CRA|BPA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|C\d{2}A|BA|PA|RA|FA|TA|AA|AP)(-|$)/;
  if (AUTO_PREFIX.test(cn)) return true;
  // CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling d): a card-number comparison
  // is hyphen-insensitive, and this one must be too. Sellers and CardHedge
  // both print CPA-BR as CPABR, and sameCardNumber() already calls those the
  // same card — so without this the auto flag disagrees with identity: the
  // folded spelling is tagged no-auto and splits from its own hyphenated
  // pool. Re-test with the separator restored after the longest prefix that
  // actually matches, never on a bare fold (which would let ANY letters
  // starting in BA/PA/RA read as an auto).
  if (!cn.includes("-")) {
    const m = /^(CPATWH|CPALD|APDCA|54FAV|FFDA|CUSA|SCCA|CCAR|RODA|ROTA|TTAR|DPPA|BSPA|BCPA|BCRA|TCRA|B96A|BGA|MRA|UAC|BSA|FSA|CPA|CDA|CRA|BPA|CBA|CCA|USA|DAS|NTS|SSM|DCA|CAA|GQA|AGA|ROA|FAR|FFA|BOA|T1A|SCA|PPA|ODA|IAP|UAR|C\d{2}A)([A-Z]{1,4})$/.exec(cn);
    if (m) return true;
  }
  return false;
}

// CF-INSERT-DETECTION (Drew, 2026-07-30). Inserts are separate card
// sets within a product — a "Bowman BTP-10 Scouts' Top 100 Refractor"
// is NOT the same card (or FMV pool) as a base Bowman #10 Refractor.
// Currently the parser conflates them: cardNumber "BTP-10" gets slugged
// as `hiq:baseball:2024:bowman:btp-10:refractor:no-auto` — same pool
// as any BTP-10 might land in, and separate from where OTHER insert
// numbers land.
//
// This function detects when a cardNumber prefix (or anniversary year
// stamp) indicates an insert set and returns the compound insert-name
// slug. Callers combine it with the base setKey to produce
// setKey = `${base}-${insertSlug}` (e.g. bowman-scouts-top-100).
//
// Curated from Drew's baseball insert vocabulary (2026-07-30):
//
//   BOWMAN inserts (2013+):
//     BTP  Scouts' Top 100
//     BSP  Bowman Spotlights
//     MR   Mood Ring        (also Draft variant)
//     DPP  Draft Picks & Prospects
//     TT   Transformative Talent
//     54F  Bowman '54       (design-throwback)
//   TOPPS FLAGSHIP inserts:
//     HRC  Home Run Challenge
//     SMLB Stars of MLB
//     CC   City Connect
//     GOAT Greatest of All Time  (varies by year, sometimes prefixed differently)
//     HA   Heavy Artillery
//   TOPPS CHROME inserts:
//     FS   Future Stars
//     USC  Ultraviolet (colored inserts, year-varying)
//   TOPPS HERITAGE inserts:
//     NF   New Age Performers (some years)
//     TAN  Then and Now
//     BF   Baseball Flashbacks
//     NAP  New Age Performers (canonical prefix)
//   ANNIVERSARY year-stamped: pattern ^\d{2}[A-Z]{1,4}-  (85TF, 87ASA,
//     88BF, 89BC, 87TB, etc.) — design-year prefix + insert-code suffix
//
// Returns null when the cardNumber doesn't match any known insert
// prefix — caller keeps the base setKey unchanged. */
export function detectInsertSet(cardNumber: string | null): string | null {
  if (!cardNumber) return null;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  // Ordered longest-first for correct alternation matching.
  const map: Array<[RegExp, string]> = [
    // 4+ char prefixes
    [/^SMLB-/, "stars-of-mlb"],
    [/^GOAT-/, "greatest-of-all-time"],
    // 3-char
    [/^BTP-/, "scouts-top-100"],
    [/^BSP-/, "spotlights"],
    [/^DPP-/, "draft-picks-prospects"],
    [/^HRC-/, "home-run-challenge"],
    [/^USC-/, "ultraviolet"],
    [/^NAP-/, "new-age-performers"],
    [/^TAN-/, "then-and-now"],
    // 2-char
    [/^CC-/, "city-connect"],
    [/^HA-/, "heavy-artillery"],
    [/^FS-/, "future-stars"],
    [/^MR-/, "mood-ring"],
    [/^TT-/, "transformative-talent"],
    [/^NF-/, "new-age-performers"],
    [/^BF-/, "baseball-flashbacks"],
    [/^54F-/, "bowman-54"],
    // Anniversary year-stamped (85TF, 87ASA, 88BF, 89BC — 2-digit year
    // + 1-4 letters). The letter code is variable per year/product;
    // we route to a generic "anniversary" bucket keyed by the letters
    // for later disambiguation. Alt: return "anniversary-{letters}" so
    // 85TF and 89BC end up in the same "TF"/"BC" insert pool across
    // decades. That's the safer default.
  ];
  for (const [re, slug] of map) {
    if (re.test(cn)) return slug;
  }
  // Anniversary regex — extract the letter suffix as the insert code.
  const anniversary = cn.match(/^(\d{2})([A-Z]{1,4})-/);
  if (anniversary) return `anniversary-${anniversary[2].toLowerCase()}`;
  return null;
}

// CF-UNIFIED-AUTO-INFERENCE (Drew, 2026-07-30). Sport-aware auto
// detection that consolidates every signal:
//   - Title text ("auto" / "autograph" / "hard signed")
//   - Baseball cardNumber prefix (via isCardNumberAutoSubset)
//   - Football-specific cardNumber prefixes (WT for Winning Ticket +
//     baseball prefixes that also work in football: RA/BA/PA)
//   - Basketball + football setName keyword ("Signatures", "Autographs",
//     "Ink", "Penmanship", "Rookie Ticket", "Season Ticket", etc.)
//     — this is the PRIMARY rule for Panini basketball (2009-2024) and
//     Panini football (2016-2025) which don't use prefixes at all
//
// Traps (NOT handled by this function — need slab OCR):
//   - Contenders "Rookie Ticket" autos numbered within base set
//   - Nat'l Treasures / Immaculate / Flawless RPAs numbered within base
//   - Prizm veteran auto parallels sharing base card number
// For those, the caller (image-verify Tier-2a slab OCR) is authoritative.

/** Case-insensitive keyword regex covering auto-set NAMES across
 *  Panini + Topps NBA/NFL. Broad but conservative — must match a full
 *  word/phrase, not a substring inside another word. Includes both
 *  auto keywords and product families that ARE 100% auto (Ink,
 *  Penmanship, Rookie Ticket, Real One, etc.). */
const AUTO_SETNAME_RE = /\b(?:signatures?|autographs?|hard[-\s]signed|signature\s+(?:series|blend|style|class)|rookie\s+(?:signatures?|ticket|photo\s+shoot|premiere\s+materials)|season\s+ticket|playoff\s+ticket|championship\s+ticket|winning\s+ticket|clutch\s+gene|next\s+day\s+auto|penmanship|scripts?|signings?|significance|silhouettes?|ink\b|hot\s+signatures?|sensational\s+signatures?|great\s+significance|shadow\s+scripts?|manuscripts?|eternal\s+marks?|hoop\s+signs?|chromographs?|autograph\s+issue|real\s+one|sign\s+of\s+the\s+times|sott|volcanic\s+signatures?|aurora\s+ink|elusive\s+ink|cactus\s+ink|fresh\s+paint|heir\s+apparent|next\s+stop\s+signatures?|skywrite\s+signatures?|stratospheric\s+signatures?|1989\s+signatures?|hyper\s+signatures?|crystal\s+clear\s+autographs?|fast\s+break\s+autographs?|in\s+flight\s+signatures?|signature\s+series|rated\s+rookies?\s+signatures?|autograph\s+patch|dynasty\s+autograph|nfl\s+ink|breakout\s+autographs?|dual\s+autographs?|triple\s+autographs?|quad\s+autographs?|clearly\s+authentic|definitive\s+autographs?|flashback\s+autograph|framed\s+autographs?|prime\s+performers|tier\s+one\s+auto|clubhouse\s+collection\s+auto|inception\s+auto|hometown\s+heroes\s+auto|tribute\s+auto|museum\s+collection\s+auto|allen[-\s]?(?:and\s+)?ginter\s+auto|gypsy\s+queen\s+auto|opening\s+day\s+auto|five\s+star\s+auto|dynasty\s+patch\s+auto|1st\s+bowman(?:\s+chrome)?\s+auto)\b/i;

/** Football-specific cardNumber prefixes NOT in the baseball list.
 *  WT = Winning Ticket (Contenders). Baseball prefixes RA/BA/PA also
 *  work in football (draft/collegiate products), so
 *  isCardNumberAutoSubset already covers them. */
function isFootballCardNumberAutoSubset(cardNumber: string | null): boolean {
  if (!cardNumber) return false;
  const cn = String(cardNumber).toUpperCase().replace(/^#/, "");
  return /^(WT|SOT)(-|$)/.test(cn);
}

export interface InferIsAutoInput {
  sport?: string | null;               // "baseball" | "football" | "basketball" | "hockey" | null
  cardNumber?: string | null;
  setName?: string | null;             // full product/insert name if known
  titleHasAutoText?: boolean;          // pre-computed from extractIsAuto if available
  /** CF-A-CARDNUMBER-PREFIX-IS-SUFFICIENT-NEVER-NECESSARY (Drew, 2026-09-04).
   *  The product's year + setKey, so the CHECKLIST can answer for a card whose
   *  signed variant SHARES the base card number (2011 Topps Chrome #173
   *  Freddie Freeman: one number, a base rookie and an Autographed Rookie).
   *  Optional: without a resolver nothing changes. */
  year?: number | null;
  setKey?: string | null;
  /** Injected checklist index. A title parse never does I/O, so the caller
   *  supplies an in-memory index; absent means "unknown", which is `false`. */
  checklistAuto?: ChecklistAutoResolver | null;
  /** The signal that says THIS sale is the signed row, where the checklist
   *  says a signed row EXISTS at this number. Title auto-words are the usual
   *  source; a slab OCR reading "AUTOGRAPH" off the label is another. Note
   *  that `titleHasAutoText` cannot serve here -- it short-circuits to `true`
   *  at the top of `inferIsAuto`, so by the time the checklist rule runs it
   *  is always false. That is exactly the case this rule is FOR: a title too
   *  terse to prove the auto, on a number the checklist says is signed. */
  autoCorroboration?: boolean;
}

/** Sport-aware isAuto inference — the ONE function callers should use
 *  when they have context beyond a raw title. Combines every signal
 *  and short-circuits on the first positive.
 *
 *  Returns true if ANY of:
 *    1. Title has explicit auto text (extractIsAuto)
 *    2. Baseball or football: cardNumber prefix on the curated list
 *    3. Football-only: Winning Ticket / SOT prefix
 *    4. Any sport: setName matches AUTO_SETNAME_RE
 *
 *  Never returns true just from being "possibly" an auto — bar is
 *  "one clear positive signal". Slab OCR is a separate authoritative
 *  path for numbered-within-base autos. */
export function inferIsAuto(input: InferIsAutoInput): boolean {
  if (input.titleHasAutoText === true) return true;

  const sport = (input.sport ?? "").toLowerCase();
  // Baseball + football + hockey (rare): prefix rule.
  // Basketball Panini era has NO prefix vocabulary — skip prefix rule
  // for basketball unless the sport hint is unset (safer default).
  if (sport !== "basketball") {
    if (isCardNumberAutoSubset(input.cardNumber ?? null)) return true;
  }
  if (sport === "football" && isFootballCardNumberAutoSubset(input.cardNumber ?? null)) return true;

  // Any sport: setName keyword.
  if (input.setName && AUTO_SETNAME_RE.test(input.setName)) return true;

  // CF-A-CARDNUMBER-PREFIX-IS-SUFFICIENT-NEVER-NECESSARY. Everything above is
  // a PREFIX or a NAME rule, and both are structurally blind to a signed card
  // that shares the base card's number -- the "traps" named above as needing
  // slab OCR. They do not need OCR: the product's own checklist lists the
  // auto row at that number. Last, and additive: it can only turn a `false`
  // into a `true`, and only where a checklist actually says so.
  //
  // Gated on corroboration, because a checklist saying "#173 has a signed
  // variant" makes the auto POSSIBLE, not certain -- most #173 sales are the
  // base rookie, and tagging those would wreck the base pool. The caller
  // passes what says THIS sale is the signed one (`autoCorroboration`).
  if (input.checklistAuto) {
    if (checklistSaysAuto({
      sport: input.sport ?? null,
      year: input.year ?? null,
      setKey: input.setKey ?? null,
      cardNumber: input.cardNumber ?? null,
      corroborated: input.autoCorroboration === true,
      resolve: input.checklistAuto,
    })) return true;
  }

  return false;
}

/** A `#`-prefixed token that is a PRODUCT-CODED card number (USC88, PDC-171,
 *  CPA-EW, BCP-102) rather than a bare integer. Deliberately the letter-led
 *  alternatives of DEFAULT_CARD_NUMBER_RE and nothing more: this decides only
 *  which of two stated numbers wins, never whether a number is stated. */
const PREFIXED_HASH_CARD_NUMBER_RE =
  /#\s*([A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4})\b/gi;
/** A bare `#N`, the shape a listing-position prefix also takes. */
const BARE_HASH_CARD_NUMBER_RE = /#\s*(\d{1,4})\b/g;

/**
 * CF-A-PREFIXED-NUMBER-OUTRANKS-A-BARE-ONE. Returns the prefixed card number
 * ONLY when the title states both a prefixed and a bare `#` number — the case
 * where first-match order picks the wrong one. Returns null otherwise, leaving
 * every single-number title to the regex that has always read it.
 *
 * Refuses when the title states SEVERAL DIFFERENT prefixed numbers: that is a
 * lot or a title naming two cards, and picking one of them would be a guess.
 */
function preferPrefixedCardNumber(title: string): string | null {
  const t = String(title);
  const prefixed = [...t.matchAll(PREFIXED_HASH_CARD_NUMBER_RE)]
    .map((m) => m[1].toUpperCase());
  if (!prefixed.length) return null;
  // Several distinct prefixed numbers = two cards named, not one card
  // numbered twice. Refuse rather than pick.
  if (new Set(prefixed).size > 1) return null;
  // Only reorder when a bare number is ALSO present and comes first — that is
  // precisely the listing-index collision. A title with only "#USC88" already
  // parses correctly through the default regex.
  const bare = BARE_HASH_CARD_NUMBER_RE.exec(t);
  BARE_HASH_CARD_NUMBER_RE.lastIndex = 0;
  if (!bare) return null;
  const firstPrefixedAt = t.search(/#\s*(?:[A-Z]{2,5}-[A-Z0-9]{1,6}|[A-Z]{1,3}\d{1,4})\b/i);
  if (firstPrefixedAt < 0 || bare.index < firstPrefixedAt) return prefixed[0];
  return null;
}

function extractCardNumber(
  title: string,
  cardNumberRe?: RegExp,
  isTcg = false,
  isPokemon = false,
): string | null {
  // CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE. The pokemon forms run FIRST and
  // for the same reason the TCG rule below does: a Pokemon title that writes
  // "#SWSH136" would otherwise be read by the generic `#`-prefix regex, whose
  // `[A-Z]{1,3}\d{1,4}` alternative matches only the first three letters and
  // returns "SWS" -- a card number that names nothing. The pokemon reader knows
  // the whole token is the number.
  //
  // A caller-supplied cardNumberRe means the caller is targeting one known card
  // and every rule here is bypassed, exactly as the TCG branch does.
  if (isPokemon && !cardNumberRe) {
    const pk = pokemonCardNumber(title);
    if (pk) return pk;
  }
  // CF-TCG-NUMBER-BEFORE-HASH (Drew, 2026-08-14). In TCG the POS/TOTAL rule
  // must run FIRST. Sellers write the number both ways — "40/147" and
  // "#044/193" — and on the second form the generic #-prefix rule below
  // matches "044" and returns early, dropping "/193". That is not a smaller
  // answer, it is a DIFFERENT card number, and it matches no catalog row.
  //
  // Caught only by running the verbatim listing title through the compiled
  // parser: the unit test had been written against the same title with the
  // "#" removed, so it passed while the real input failed.
  if (isTcg && !cardNumberRe) {
    const tcg = title.match(TCG_NUMBER_RE);
    if (tcg) {
      const num = Number(tcg[1]); const total = Number(tcg[2]);
      if (num > 0 && num <= 400 && total > 0 && total <= 400) {
        return `${tcg[1]}/${tcg[2]}`;
      }
    }
  }
  const re = cardNumberRe ?? DEFAULT_CARD_NUMBER_RE;
  // CF-A-PREFIXED-NUMBER-OUTRANKS-A-BARE-ONE (Drew, 2026-08-31). `String.match`
  // with a non-global regex returns the FIRST match in string order, and a
  // seller's LISTING-POSITION prefix is written first:
  //
  //   "#1 2024 Topps Chrome Update X-Fractor #USC88 Paul Skenes RC PSA 10"
  //        ^ listing index, not a card number      ^^^^^ the real card number
  //
  // The parse returned "1". That is not a near miss: it files a Chrome Update
  // sale against flagship card #1 (a different player entirely), and because
  // the SLUG was minted from the same wrong parse, the slug and the parse
  // AGREE — so no cardNumber-mismatch check anywhere catches it. Two such rows
  // were found in the 2026-08-31 setKey-misfile diagnosis, and the same shape
  // reappears on "#5 2024 Topps Pro Debut #PDC-171".
  //
  // The discriminator is SHAPE, not position. Card numbers printed with a
  // product prefix (USC88, PDC-171, CPA-EW, BCP-102) are unambiguous — nothing
  // else in a title is written that way — whereas a bare small integer is
  // exactly what a listing index also looks like. So when a title states BOTH,
  // the prefixed one is the card number and the bare one is the seller's
  // numbering. When the title states only a bare number, it is unchanged:
  // "2024 Topps Chrome Shohei Ohtani #1 X-Fractor" still parses #1, because
  // genuine #1 cards are everywhere and this rule must never invent a reason
  // to skip one.
  if (!cardNumberRe) {
    const best = preferPrefixedCardNumber(title);
    if (best) return best;
  }
  const m = title.match(re);
  if (m) return m[1].toUpperCase();
  // CF-CARDNUM-STANDALONE fallback — only tried when the primary #-prefix
  // regex didn't fire. Won't match print runs (leading `/` blocked).
  if (!cardNumberRe) {
    const m2 = standaloneCardNumber(title);
    if (m2) return m2;
    // CF-STANDALONE-PREFIXED-CARDNUMBER: a prefixed number with no '#'.
    // "2025 Topps Stars of MLB SMLB-10 Shohei Ohtani" and
    // "2025 Bowman Draft CPA-EW Eli Willits" both state it plainly.
    const m3 = title.match(STANDALONE_PREFIXED_CARD_NUMBER_RE);
    if (m3) {
      const tok = m3[1].toUpperCase();
      const suffix = tok.slice(tok.indexOf("-") + 1);
      // A digitless suffix (CPA-EW) is only credible when the token is printed
      // in caps as SKUs are; "Game-Used" is title case and is a description.
      const asWritten = m3[1];
      const halves = tok.split("-");
      const bothCondition = halves.length === 2 &&
        CONDITION_WORDS.has(halves[0]) && CONDITION_WORDS.has(halves[1]);
      const plausible = !bothCondition &&
        (/\d/.test(suffix) || (suffix.length <= 4 && asWritten === asWritten.toUpperCase()));
      if (plausible && !NOT_A_CARD_NUMBER.has(tok)) return tok;
    }
  }
  // CF-TCG-CARDNUM (Drew, 2026-08-02). Pokemon/TCG card numbers use the
  // format `POS/TOTAL` (e.g. "008/132", "294/217"). Note the position
  // CAN exceed the total (secret/hyper rares are numbered above set
  // total). Constrain both to <=400 so we don't accidentally consume
  // sports print runs like /999 or /2011.
  //
  // CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14). The <=400 bound was the
  // ONLY guard, and it does not separate the two meanings at all: a sports
  // serial like "22/30" or "49/75" sits comfortably inside it. So this rule
  // fired on sports titles and turned serials into card numbers — 99% wrong
  // where it fired, and it reached sold_comps as phantom cards.
  //
  // The bound was never the right discriminator, because `N/M` is not
  // ambiguous once you know the vertical: in TCG it is the card number, in
  // sports it is a serial. Gate on the vertical, not on the magnitude.
  //
  // The TCG branch itself now runs at the TOP of this function — see
  // CF-TCG-NUMBER-BEFORE-HASH — because it has to beat the #-prefix rule.
  return null;
}

function extractIsAuto(title: string): boolean {
  // A shop name is not a signature. When the ONLY thing in the title that
  // says "autograph" is the seller's own store token, the title states
  // nothing about this card -- see CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE.
  if (autographWitnessIsSellerNameOnly(title)) return false;
  return AUTO_RE.test(title) && !AUTO_NEGATIVE_RE.test(title);
}

/** Extract auto style from title. Modern products drop hints like
 *  "On-Card Auto", "On Card Auto", or "OC Auto" (rare) for on-card
 *  signatures; "Sticker Auto" or plain "Sticker" for sticker autos.
 *  Returns null when neither hint is present — callers should treat
 *  as unknown, NOT infer a default. */
function extractAutoStyle(title: string): "on-card" | "sticker" | null {
  const T = title;
  // On-card indicators — check first since "On Card" is very common
  if (/\bon[-\s]card\b/i.test(T)) return "on-card";
  if (/\bhard[-\s]signed\b/i.test(T)) return "on-card";       // Topps' PR term for on-card
  // Sticker indicators
  if (/\bsticker\s+auto(graph)?\b/i.test(T)) return "sticker";
  if (/\bsticker\s+signed\b/i.test(T)) return "sticker";
  return null;
}

/** Extract the print run from a title. Handles serial patterns:
 *  - "3/5" (3-of-5 hand-numbered)
 *  - "77/199"
 *  - "/199" (unnumbered format when only the denominator appears)
 *  - "#/50 Braves" (numerator absent) */
function extractPrintRun(title: string, isTcg = false, isPokemon = false): number | null {
  let t = title;
  // CF-SERIAL-IS-NOT-A-CARDNUMBER (Drew, 2026-08-14). In TCG, "40/147" is
  // card-40-of-a-147-card-set. 147 is the SET SIZE, not a print run — Burning
  // Shadows was not a 147-copy print. Both branches below would have claimed
  // it (the serial branch reads the denominator; the standalone branch matches
  // the "/147" substring), so the token is removed rather than skipped. That
  // leaves a genuinely numbered TCG parallel — "... 40/147 ... /25" — still
  // able to report /25 correctly.
  if (isTcg) t = t.replace(TCG_NUMBER_RE_G, " ");
  // CF-A-POKEMON-CARD-STATES-ITS-NUMBER-BARE. The removal above is keyed to the
  // NARROW `N/M` regex, so every wider Pokemon spelling survived it and was
  // then read as a serial: "[077/067]" reported printRun 67 and "(23/83)"
  // reported 83 -- set sizes sold as print runs, on rows whose cardNumber was
  // simultaneously null. Remove the same token this parser now reads as the
  // card number, so one token is never spent twice.
  if (isPokemon) t = t.replace(POKEMON_NUMBER_OVER_TOTAL_RE_G, " ");

  // CF-GRADE-FRACTION-IS-NOT-A-SERIAL (Drew, 2026-08-20: "we need to fix the
  // parser store"). A GRADE written as a fraction is not a print run:
  //
  //   "...#CPA-LD PSA 10/9 DZ480"   -> read as /9    (catalog says /150)
  //   "...Padres PSA 9/10"          -> read as /10
  //   "...PSA/9 #CPA-LD"            -> read as /9
  //
  // Found via the rematch diagnostic: 4,837 comps claim a serial the checklist
  // denies, and Leo De Vries CPA-LD alone had a cluster sitting in /9 and /10
  // pools for a card that is only ever /150. The comps are real sales at real
  // prices, silently pooled with cards a hundred times rarer.
  //
  // Stripped rather than skipped, so a title carrying BOTH a grade fraction and
  // a genuine serial — "PSA 9/10 ... Blue Refractor /150" — still reports /150.
  t = t.replace(/\b(PSA|BGS|SGC|CGC|HGA|TAG|ACE)\s*\/?\s*\d{1,2}(\.5)?\s*\/\s*\d{1,2}(\.5)?\b/gi, " ")
       .replace(/\b(PSA|BGS|SGC|CGC|HGA|TAG|ACE)\s*\/\s*\d{1,2}(\.5)?\b/gi, " ");

  // First look for X/Y serial style — denominator is the print run
  const serial = t.match(/(?:^|[^0-9])(\d{1,2})\/(\d{1,3})(?:\D|$)/);
  if (serial) return Number(serial[2]);
  // Fall back to /N standalone
  const slash = t.match(/\/(\d{1,4})(?:\D|$)/);
  if (slash) {
    const n = Number(slash[1]);
    // Guard against grabbing a random number (e.g. "/2024") — cap
    // reasonable print runs at 5000. Any /N > 5000 is likely a year
    // or unrelated numeric.
    if (n > 0 && n <= 5000) return n;
  }
  return null;
}

/** Extract a canonical parallel name from a title. Match precedence:
 *  SuperFractor > explicit adjacent color+variant > patterned refractors
 *  (Shimmer/Lava/Wave/RayWave/Grass/X-Fractor) > Sapphire variants when
 *  Sapphire is the product context + a color appears > color refractors
 *  > misc named parallels. Unrecognized → "Base". */
function extractParallel(title: string, ctx?: { year?: number | null; setKey?: string | null }): string {
  // CF-REF-IS-REFRACTOR (Drew, 2026-08-24). Sellers abbreviate it, and the
  // abbreviation was invisible to every rule below.
  //
  //   "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold Ref. #CPA-MWI PSA 9"
  //
  // The bare-refractor rule tests /refractor/, which "Ref." does not
  // match, so every colour and pattern rule was skipped and the title fell all
  // the way to the chrome-auto fallback, returning "Refractor". The colour was
  // not lost by a bad rule — it was never read.
  //
  // That is the real sale above: a Gold Refractor /50 filed as a plain
  // Refractor, which is why the gold pool held ZERO comps for a card that has
  // demonstrably traded, and why the holding priced against /499 commons.
  //
  // Expanding once, up front, means every existing colour and pattern rule
  // gets its chance rather than each having to learn the abbreviation.
  // (?!ractor) so "Refractor" is left alone.
  const T = title.replace(/\bref\b\.?(?!ractor)/gi, "Refractor");
  if (/superfractor|super\s+fractor/i.test(T)) return "SuperFractor";

  // CF-THE-FRACTOR-FAMILY-IS-OPEN-ENDED (Drew, 2026-08-25). Mined from the
  // 10,144 sales the refractor repair held back rather than guessed at one
  // title at a time -- which is how Packfractor was found, and how the next
  // one would have been missed:
  //
  //   "2024 Topps Chrome Logofractor Future Stars Auto ... /99"  -> Base
  //   "... Milwaukee Brewers Chrome PackFractor /89"             -> Base
  //
  // Both read the PRINT RUN and lost the parallel, so a /99 Logofractor auto
  // was filed as base. Topps keeps minting these, and enumerating them has
  // lost every previous race with the marketing department, so match the
  // shape: any word ending in "fractor" names itself. Re- is the plain
  // refractor and is handled by the colour rules below; Super- already
  // returned above; X-Fractor is hyphenated so the letter-run cannot reach it.
  const fractorFamily = T.match(/\b([a-z]+)fractor\b/i);
  if (fractorFamily && !/^(?:re|super|x)$/i.test(fractorFamily[1])) {
    return capFirst(fractorFamily[1].toLowerCase()) + "fractor";
  }

  // CF-MOJO-IS-A-PARALLEL (same mining pass). Bowman Mega Box Mojo is a real
  // parallel and the single most common miss in the held set:
  //   "2022 Bowman Chrome - Mega Box Chrome Mojo Autographs Joshua Baez"
  //   "2023 Bowman Chrome Keiner Delgado Auto /150 Choice Mojo #CPA-KD"
  if (/mojo\s+refractor/i.test(T)) return "Mojo Refractor";
  if (/\bmojo\b/i.test(T)) return "Mojo";

  // ─── Paper-auto Border ladder (runs FIRST to win vs refractor rules) ─
  // CF-PAPER-AUTO-BORDERS (Drew, 2026-07-29). Bowman paper autos
  // (BPA-/BDA-/BCRA- prefixes; on flagship Bowman + Bowman Draft, on
  // paper stock, not chrome) use a "Color Border" parallel ladder
  // that's paper's equivalent of Chrome's Refractor color ladder.
  // Standard Bowman paper-auto Border ladder + print runs:
  //   Sky Blue Border /499     (COLLIDES with Sky Blue Refractor rule
  //                            below — Border MUST win, must run first)
  //   Neon Green Border /399
  //   Fuchsia Border /299
  //   Purple Border /250
  //   Blue Border /150         (COLLIDES with Blue Refractor /150)
  //   Yellow Border /75
  //   Gold Border /50          (COLLIDES with Gold Refractor /50)
  //   Orange Border /25        (COLLIDES with Orange Refractor /25)
  //   Red Border /5            (COLLIDES with Red Refractor /5)
  //   Platinum Border 1/1
  //
  // Match ordering: multi-word colors (sky blue, neon green) first so
  // "sky blue" doesn't fall to the single "blue" match.
  {
    if (/sky\s+blue\s+border/i.test(T)) return "Sky Blue Border";
    if (/neon\s+green\s+border/i.test(T)) return "Neon Green Border";
    if (/platinum\s+border/i.test(T)) return "Platinum Border";
    const bm = T.match(/(fuchsia|purple|blue|yellow|gold|orange|red|black|green)\s+border/i);
    if (bm) return capFirst(bm[1]) + " Border";
    if (/\bborder\b/i.test(T) && AUTO_RE.test(T)) return "Border";
  }

  // CF-TRUE-COLOR-PARALLEL (Drew, 2026-07-28). Market vernacular:
  // "True <Color>" means "<Color> Refractor" (the base colored
  // refractor variant). Real-world example: Eric Hartman's True Blue
  // #CPA-EHA sold at $905 tagged as parallel="Base" because the
  // parser missed the alias.
  //
  // eBay listings put "True" and the color in either order — "True
  // Blue Refractor" OR "Bowman Blue …True" (verified 2026-07-28 on
  // Hartman "2026 Bowman Blue Eric Hartman True #CPA-EHA"). We match
  // when both tokens are present ANYWHERE in the title, ordering
  // agnostic, but guarded to the canonical refractor colors so we
  // don't accidentally absorb "True Metal" / "True Silver" (real
  // Panini parallels distinct from Silver Refractor) or match on
  // stray marketing text.
  //
  // Runs BEFORE the plain color-refractor rules below so both
  // "True Blue Refractor" and "True Blue" land on "Blue Refractor".
  if (/\btrue\b/i.test(T)) {
    const c = T.match(/\b(blue|red|green|orange|yellow|purple|gold|aqua)\b/i);
    if (c) return capFirst(c[1]) + " Refractor";
  }
  // Explicit adjacent Sapphire variants (Color + Sapphire)
  if (/red\s+sapphire/i.test(T)) return "Red Sapphire";
  if (/orange\s+sapphire\s+refractor/i.test(T)) return "Orange Sapphire Refractor";
  if (/orange\s+sapphire/i.test(T)) return "Orange Sapphire";
  if (/yellow\s+sapphire/i.test(T)) return "Yellow Sapphire";
  if (/green\s+sapphire/i.test(T)) return "Green Sapphire";
  if (/blue\s+sapphire/i.test(T)) return "Blue Sapphire";
  // Patterned refractors (color + adjacent pattern word). Direct regex
  // literals — string-concatenated regexes were dropping the \s+ escape
  // when constructed via new RegExp().
  let m: RegExpMatchArray | null;
  // THE TWO-COLOUR CARDS ARE TESTED BEFORE THE ONE-COLOUR LADDER.
  //
  // CF-RED-INK-IS-ITS-OWN-CARD (Drew ruling 2026-08-30) gives "Red Ink" and
  // "Black & White Shimmer" their own rows, and both are spelled with TWO
  // colour words. Widening PATTERN_COLOUR to carry `white` (so "Pink Wave" and
  // "Fuchsia Wave" stop collapsing) put "white" in reach of the single-colour
  // rules below — and "Black & White Shimmer Auto" then matched `white shimmer`
  // and answered "White Shimmer Refractor", a card that does not exist, while
  // the Drew-ruled rule that would have answered correctly sits further down
  // and never ran. Caught by tests/redInkIsItsOwnCard.test.ts.
  //
  // A two-colour name is strictly more specific than either colour alone, so
  // it is asked first. The duplicate rules further down are harmless and are
  // left where they are: they are the ones the ruling's own comment documents,
  // and a reader looking for Red Ink should find it beside its explanation.
  if (/\bred\s+ink\b/i.test(T)) return "Black & White Red Ink";
  if (/\bblack\s*(?:&|and)?\s*(?:\/)?\s*white\s+shimmer/i.test(T)) return "Black & White Shimmer Refractor";
  if (/\bb\s*&\s*w\s+shimmer\b/i.test(T)) return "Black & White Shimmer Refractor";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+shimmer`, "i"));
  if (m) return capFirst(m[1]) + " Shimmer Refractor";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+lava`, "i"));
  if (m) return capFirst(m[1]) + " Lava Refractor";
  // Ray Wave — check BEFORE plain Wave so "Ray Wave" doesn't get
  // swallowed by the wave-only pattern. Accepts three spellings:
  // "Ray Wave" (space), "Ray-Wave" (hyphen), "RayWave" (compound).
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+ray[\s-]?wave`, "i"));
  if (m) return capFirst(m[1]) + " Ray Wave Refractor";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+wave`, "i"));
  if (m) return capFirst(m[1]) + " Wave Refractor";
  // VAPOR and EQUINOX are pattern families with no rule at all before now, so
  // "Yellow Vapor /75" and "Aqua Equinox" fell straight through to the
  // bare-colour scan. 2023 bowman-chrome has NO plain Yellow Refractor, so
  // that collapse did not merely split a pool -- it invented a card.
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+vapou?r`, "i"));
  if (m) return capFirst(m[1]) + " Vapor Refractor";
  if (/\bvapou?r\s+refractors?\b/i.test(T)) return "Vapor Refractor";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+equinox`, "i"));
  if (m) return capFirst(m[1]) + " Equinox Refractor";
  if (/\bequinox\b/i.test(T)) return "Equinox Refractor";
  // ETCH / ETCHED. "Black Etch SSP" is a Black Etch, not a Black Refractor.
  // The bare "Etched In Glass Variation" is a checklist row in its own right
  // and is listed SEPARATELY from "Image Variation" -- two cards, and reading
  // one as the other pooled them.
  if (/\betched\s+in\s+glass\b/i.test(T)) return "Etched In Glass Variation";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+etch(?:ed)?\b`, "i"));
  if (m) return capFirst(m[1]) + " Etch";
  // CF-BARE-WAVE-REFRACTOR (Drew, 2026-07-29). Wave Refractor exists
  // as a bare (silver-based) parallel too — "2026 Bowman Eric Hartman
  // Wave Refractor /350 #BCP-102" landed at parallel="Refractor"
  // because the color-prefix rules above didn't match and the bare
  // Refractor fallback at the bottom did. Order: after color-prefixed
  // Wave rules so "Blue Wave" still returns "Blue Wave Refractor",
  // before the bare "Refractor" fallback so bare "Wave Refractor"
  // beats bare "Refractor". Same for Ray Wave.
  if (/ray[\s-]?wave\s+refractor/i.test(T)) return "Ray Wave Refractor";
  if (/wave\s+refractor/i.test(T)) return "Wave Refractor";
  // BARE SHIMMER, for the same reason bare Wave exists. "2022 Bowman Chrome
  // Shimmer Refractors #BCP-1" carries no colour, so every colour-prefixed
  // rule above missed and the bare "Refractor" fallback near the bottom
  // answered "Refractor" — pooling a Shimmer with the plain refractors, which
  // is one card in two pools. Plural because a checklist heads its section in
  // the plural ("Shimmer Refractors") and sellers copy the heading verbatim.
  if (/\bshimmer\s+refractors?\b/i.test(T)) return "Shimmer Refractor";
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+grass`, "i"));
  if (m) return capFirst(m[1]) + " Grass Refractor";
  // CF-SPECKLE-REFRACTOR (Drew, 2026-07-29). Speckle is a Bowman Chrome
  // pattern refractor — small-dot foil overlay. Ships as bare Speckle
  // (silver-based) and as colored variants (Blue Speckle, Orange
  // Speckle, etc.). Same treatment shape as Shimmer/Lava/Wave/Grass.
  // OBSERVED: Bowman Chrome Speckle Refractor rows landed at
  // setKey=bowman parallel=Base because "Speckle" had no rule.
  m = T.match(new RegExp(PATTERN_COLOUR + String.raw`\s+speckle`, "i"));
  if (m) return capFirst(m[1]) + " Speckle Refractor";
  if (/speckle\s+refractor/i.test(T)) return "Speckle Refractor";
  if (/\bspeckle\b/i.test(T)) return "Speckle Refractor";
  // The colour rule accepts the same three spellings the bare rule below does,
  // singular AND plural. It used to accept only "X-Fractor"/"Xfractor", so
  // "Orange X Fractor /25" dropped its colour — invisible until the bare rule
  // below existed to catch the remainder, at which point the colour loss became
  // a wrong ANSWER rather than a fall-through to Base.
  //
  // The first round's widening added a trailing \b and so broke the PLURAL it
  // never tested: "Orange X-Fractors /25" failed this rule, fell past the bare
  // rule (also singular-only) and landed on the widened /\brefractors?\b/
  // fallback as a plain "Orange Refractor" — a /25 Orange filed into the Orange
  // Refractor pool. Strictly worse than the behaviour it replaced. The `s?`
  // before the \b is what makes the plural reach its own rule, and the \b is
  // kept so this stays off the tail of another word.
  m = T.match(/(orange|red|green|gold|blue|purple|yellow|aqua|black|silver)\s+x[\s-]?fractors?\b/i);
  if (m) return capFirst(m[1]) + " X-Fractor";
  // CF-BARE-X-FRACTOR (Drew, 2026-08-31). X-Fractor was matched ONLY with a
  // colour in front of it. There was no bare rule, so plain "X-Fractor" fell
  // past every rule below and landed on "Base" — in all three spellings
  // sellers use. Line 739 above notes "X-Fractor is hyphenated so the
  // letter-run cannot reach it", which is true of the fractor-family rule;
  // what it missed is that nothing else caught it either.
  //
  //   "Shohei Ohtani #1 X-Fractor LA Dodgers | 2024 Topps Chrome"  -> Base
  //   "Topps 2024 Chrome Update Paul Skenes Rookie X fractor #USC88" -> Base
  //
  // The second is a $40 sale sitting in a $7.49 base pool. Measured over 2024
  // chrome-family sold_comps: 867 rows, the single largest cause of refractors
  // leaking into base pools.
  //
  // Placed AFTER the colour rule deliberately, so "Gold X-Fractor" still
  // returns "Gold X-Fractor" and only a genuinely bare one reaches here.
  // "Superfractor" already returned at the top of this function and cannot be
  // reached; the \b before x keeps this off the tail of another word.
  //
  // The plural gets the same treatment the Refractor fallback got, and for the
  // same reason: "X-Fractors" / "X Fractors" / "Xfractors" is how Topps prints
  // it on the checklist and how sellers title it. The first round applied that
  // reasoning to Refractor and not to the X-Fractor rule it wrote in the same
  // commit, so all three plural spellings still returned Base.
  if (/\bx[\s-]?fractors?\b/i.test(T)) return "X-Fractor";
  // Sapphire product context + standalone color → "Color Sapphire".
  // Real observed: "2026 Bowman Chrome Sapphire Owen Carey Green /99"
  // means Green Sapphire /99 (not Green Refractor /99).
  if (/sapphire/i.test(T)) {
    if (/\bred\b/i.test(T)) return "Red Sapphire";
    if (/\borange\b/i.test(T)) return "Orange Sapphire";
    if (/\byellow\b/i.test(T)) return "Yellow Sapphire";
    if (/\bgreen\b/i.test(T)) return "Green Sapphire";
    if (/\bblue\b/i.test(T)) return "Blue Sapphire";
    if (/\bgold\b/i.test(T)) return "Gold Refractor";       // Gold in Sapphire product = Gold Refractor still
  }
  // Named non-refractor parallels
  if (/mini\s+diamond\s+refractor/i.test(T)) return "Mini Diamond Refractor";
  if (/mini\s+diamond/i.test(T)) return "Mini Diamond";
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|black|pink)\s+geometric/i);
  if (m) return capFirst(m[1]) + " Geometric";
  if (/reptilian(\s+refractor)?/i.test(T)) return "Reptilian Refractor";
  if (/golden\s+mirror/i.test(T)) return "Golden Mirror";
  if (/heavy\s+lumber/i.test(T)) return "Heavy Lumber";
  if (/chrome-?image\s+variation/i.test(T)) return "Chrome-Image Variation";
  if (/image\s+variation/i.test(T)) return "Image Variation";
  if (/logo\s+pattern/i.test(T)) return "Bowman Logo Pattern";
  if (/gum\s+ball/i.test(T)) return "Gum Ball";
  // CF-EXTEND-BASEBALL-PARALLELS (Drew, 2026-07-28). Bowman Draft +
  // Bowman Chrome variants surfaced in the verify_queue that weren't
  // covered by the existing rules. Confirmed against real Cardsight
  // titles landing in pending-manual today.
  // CF-MEGA-MOJO-ALIAS (Drew, 2026-07-29). "Mega Refractor" and "Mojo
  // Refractor" are the SAME physical parallel — orange stock with a
  // pattern overlay — just named differently in the market vocabulary.
  // Distinct from plain Orange Refractor (which is solid orange). Both
  // titles collapse to "Mojo Refractor" here (the more common form) and
  // normalizeParallel in hobbyIqCardId.service.ts also collapses the
  // slug at the write layer so any vendor-supplied "Mega Refractor"
  // parallel string maps to the same canonical slug.
  if (/mojo\s+refractor/i.test(T) || /mega\s+refractor/i.test(T)) return "Mojo Refractor";
  if (/lazer\s+refractor/i.test(T) || /\blaser\s+refractor/i.test(T)) return "Lazer Refractor";

  // CF-STERLING-REFRACTOR (Drew, 2026-07-29). Bowman Sterling is an
  // insert set within Bowman flagship — identified by the BST-XX
  // cardNumber prefix. Its refractor parallel is called "Sterling
  // Refractor" in vendor titles. Kept as its own parallel so pricing
  // pools don't blend Sterling Refractor with Chrome Refractor (they
  // are visually and market-distinct products).
  //
  // OBSERVED 2026-07-29: "2026 Bowman JAC CAGLIANONE Bowman Sterling
  // Refractor Insert #BST-14 Royals RC" landed with parallel="Base".
  //
  // Also: bare "Sterling" appearing alongside a color modifier maps to
  // "<Color> Sterling Refractor" — mirrors the Sapphire treatment.
  {
    const sm = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|pink|black)\s+sterling\s+refractor/i);
    if (sm) return capFirst(sm[1]) + " Sterling Refractor";
    if (/sterling\s+refractor/i.test(T)) return "Sterling Refractor";
  }

  // CF-COLOR-ROOKIE (Drew, 2026-07-29). "Red Rookie" is a parallel —
  // rookie-designated color-foiled variant seen in Topps flagship /
  // Panini Prizm / Bowman rookie subsets. Generalize to the color
  // ladder (Red/Blue/Green/Gold/etc). Matches "<Color> Rookie" phrase
  // ordering because that's how the market vocab labels these.
  {
    const rm = T.match(/(red|blue|green|orange|purple|gold|yellow|pink|black|silver)\s+rookie\b/i);
    if (rm) return capFirst(rm[1]) + " Rookie";
  }

  if (/sepia\s+refractor/i.test(T)) return "Sepia Refractor";
  if (/\bsepia\b/i.test(T) && /\brefractor\b/i.test(T)) return "Sepia Refractor";
  // CF-FOILBOARD-IS-NOT-FOIL (I9 triage, 2026-09-06). The rule had no trailing
  // \b, so `foil` matched the FRONT of a longer finish word and answered the
  // shorter card:
  //
  //   "2025 Topps Archives Baseball #82 Pink Foilboard"   -> Pink Foil
  //   "2025 Topps A&G #47 Orange Foil Filagree"           -> Orange Foil
  //
  // Foilboard and Foil Filagree are their own checklist rows with their own
  // print runs -- the same sibling collapse CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD
  // records for Black Wave / Black Refractor. The \b sends these past this rule
  // to the checklist reader at the fallback, which answers with the whole name
  // ("Orange Foil Filagree") or refuses when it cannot confirm the sibling.
  //
  // The colour list stays as it is deliberately: widening it here would re-run
  // the enumeration that produced the gap. The checklist reader covers the
  // colours this list omits (black, silver, bronze) from the corpus instead.
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua|pink|sky\s+blue)\s+foil\b/i);
  if (m) return capFirst(m[1].replace(/\s+/, " ")) + " Foil";
  if (/sky\s+blue/i.test(T)) return "Sky Blue Refractor";
  if (/aqua\s+lava/i.test(T)) return "Aqua Lava Refractor";
  if (/aqua\s+wave/i.test(T)) return "Aqua Wave Refractor";
  if (/aqua\s+shimmer/i.test(T)) return "Aqua Shimmer Refractor";
  m = T.match(/(rose\s+gold)\s+(refractor|x-?fractor|mini)/i);
  if (m) return "Rose Gold " + capFirst(m[2].replace(/-/, "-"));
  if (/black\s+shimmer\s+refractor/i.test(T)) return "Black Shimmer Refractor";
  // CF-RED-INK-IS-ITS-OWN-CARD (Drew ruling 2026-08-30, card-lingo-glossary).
  // In Bowman prospect autographs "Red Ink" is the SSP variant OF the Black &
  // White Shimmer auto — a DISTINCT card, not a nickname for the shimmer. Both
  // must survive as themselves:
  //   * "Red Ink" must never collapse into the shimmer, and
  //   * neither may fall through to the bare-colour scan below, which read
  //     "Black & White Red Ink" as "Black Refractor" and a plain "Red Ink" as
  //     "Red Refractor" — pricing an SSP against an ordinary /5 Red rung.
  // Red Ink is tested FIRST: a title carries both phrases ("Black & White Red
  // Ink"), and the more specific card wins. The B&W prefix is optional because
  // sellers drop it ("Bowman Chrome Red Ink Auto"), and " and " is spelled out
  // as often as "&" — the old {0,3} window fit " & " but not " and ".
  if (/\bred\s+ink\b/i.test(T)) return "Black & White Red Ink";
  if (/\bblack\s*(?:&|and)?\s*(?:\/)?\s*white\s+shimmer/i.test(T)) return "Black & White Shimmer Refractor";
  if (/\bb\s*&\s*w\s+shimmer\b/i.test(T)) return "Black & White Shimmer Refractor";
  m = T.match(/(blue|red|green|orange|purple|gold|yellow|aqua)\s+prism/i);
  if (m) return capFirst(m[1]) + " Prism Refractor";
  if (/gold\s+ink/i.test(T)) return "Gold Ink";
  if (/prism\s+refractor/i.test(T)) return "Prism Refractor";

  // ─── Topps Heritage "Chrome" family parallels ─────────────────────
  // CF-HERITAGE-CHROME-PARALLELS (Drew, 2026-07-29). Topps Heritage
  // (a paper base product) ships chromium PARALLELS of the base card —
  // "Chrome" itself is the base chromium parallel, then Chrome Refractor,
  // Chrome Purple Refractor, Chrome Black Refractor, Chrome White, etc.
  // These are DISTINCT from the "Topps Chrome" set (which is its own
  // separate product). Detected via the "Chrome <modifier>" ordering
  // that Heritage uses (as opposed to "<color> Refractor" that Topps
  // Chrome uses).
  //
  // OBSERVED: "2026 Topps Heritage Jac Caglianone Chrome White RC #136"
  // — parser was returning "Base" because no rule caught "Chrome White".
  //
  // Ordered specific-first so "Chrome White Refractor" beats bare
  // "Chrome White".
  //
  // ALL Chrome-<modifier> rules here are GATED on /heritage/i so we
  // don't hijack Bowman Chrome / Topps Chrome titles where "Gold"
  // already means Gold Refractor. Without the gate, "Bowman Chrome
  // Gold /50" would wrongly return "Chrome Gold" instead of "Gold
  // Refractor". Heritage is the only context where "Chrome <Color>"
  // is a distinct parallel; elsewhere it's just the color refractor.
  if (/heritage/i.test(T)) {
    const cm = T.match(/chrome\s+(white|purple|black|blue|red|green|gold|orange|yellow)\s+refractor/i);
    if (cm) return "Chrome " + capFirst(cm[1]) + " Refractor";
    const cm2 = T.match(/chrome\s+(white|purple|black|blue|red|green|gold|orange|yellow)\b/i);
    if (cm2) return "Chrome " + capFirst(cm2[1]);
    if (/chrome\s+refractor/i.test(T)) return "Chrome Refractor";
    // Bare "Chrome" in a Heritage title = the base chromium parallel.
    if (/\bchrome\b/i.test(T)) return "Chrome";
  }

  // Base color refractors. The explicit "<Colour> Refractor" form first.
  if (/gold\s+refractor/i.test(T)) return "Gold Refractor";
  if (/red\s+refractor/i.test(T)) return "Red Refractor";
  if (/orange\s+refractor/i.test(T)) return "Orange Refractor";
  if (/purple\s+refractor/i.test(T)) return "Purple Refractor";
  if (/green\s+refractor/i.test(T)) return "Green Refractor";
  if (/yellow\s+refractor/i.test(T)) return "Yellow Refractor";
  if (/aqua\s+refractor/i.test(T)) return "Aqua Refractor";
  if (/blue\s+refractor/i.test(T)) return "Blue Refractor";

  // CF-THE-PRINT-RUN-IS-DATA-NOT-A-GATE (Drew, 2026-08-25: "so orange /25 is
  // orange refractor /25 and so on").
  //
  // These rules used to accept a bare colour ONLY when it arrived with that
  // colour's traditional print run -- gold needed /50, orange needed /25,
  // green needed /99 -- and purple, yellow and aqua had no bare form at all.
  // So the vocabulary decided which colours survived:
  //
  //   "... 1st Auto Orange /25"    -> Orange Refractor    (rule existed)
  //   "... 1st Auto Purple /250"   -> Refractor           (COLOUR LOST)
  //   "... 1st Auto Aqua /125"     -> Refractor           (COLOUR LOST)
  //
  // A dropped colour is not a smaller answer, it is a DIFFERENT CARD: those
  // Purple /250 sales pooled with plain refractors. The print run is a fact
  // about the card, never the thing that licenses reading the colour.
  //
  // Scoped to chrome products deliberately. Colour-equals-refractor is a
  // chrome convention; applied at product level it destroys Panini Prizm,
  // where a colour is a Prizm and not a Refractor at all.
  if (CHROME_PRODUCT_RE.test(T)) {
    // Team names carry colours and are not parallels. Removed by name rather
    // than guessed at, so "Toronto Blue Jays" cannot become a Blue Refractor.
    const noTeams = T.replace(TEAM_COLOUR_NOISE_RE, " ");
    const two = noTeams.match(/\b(sky\s+blue|neon\s+green|hot\s+pink|royal\s+blue)\b/i);
    if (two) {
      const words = two[1].split(/\s+/).map((w) => capFirst(w)).join(" ");
      return words + " Refractor";
    }
    const one = noTeams.match(/\b(gold|red|orange|purple|green|yellow|aqua|blue|pink|black|white|fuchsia|bronze)\b/i);
    if (one) return capFirst(one[1]) + " Refractor";
  }
  // CF-PINK-REFRACTOR (Drew, 2026-07-29). Pink refractor is a Topps
  // Chrome parallel (Mother's Day pink, and other pink variants). Was
  // missing from the color ladder. OBSERVED: "Aaron Judge 2017 Topps
  // Chrome Catching PINK Refractor #169 RC PSA 10 GEM MT" landed as
  // parallel="Base" because no rule caught "Pink Refractor".
  if (/pink\s+refractor/i.test(T)) return "Pink Refractor";

  // CF-BARE-REFRACTOR (Drew, 2026-07-29). The bare "Refractor" fallback used
  // to sit HERE, immediately after the baseball rules. It now lives below the
  // basketball block — see CF-REFRACTOR-FALLBACK-IS-LAST for the measurement
  // that moved it, and for the lot and sapphire guards it carries.

  // ─── Basketball parallels (Prizm, Optic, Select, Contenders, Hoops) ───
  // CF-BASKETBALL-PARALLELS (Drew, 2026-07-28). Basketball card
  // conventions are distinct from baseball's Bowman Chrome vocabulary.
  // These rules run AFTER the baseball checks above so a hybrid title
  // like "Prizm Silver Refractor" still matches "Silver Refractor" first
  // when applicable (rare — most Prizm titles say "Silver Prizm").
  //
  // Verified against real Cardsight/CH titles landing in the verify_queue:
  //   "Panini Prizm Basketball Silver Prizm"
  //   "2024 Donruss Optic Blue Velocity"
  //   "Select Basketball Blue Zebra"
  //   "Contenders Cracked Ice"

  // Prizm — Panini Prizm/Prizm Draft/NBA Hoops Premium Stock uses the same
  // vocabulary. "Silver Prizm" is the base foil; every other color+Prizm
  // is a numbered parallel.
  if (/silver\s+prizm/i.test(T) || /prizm\s+silver/i.test(T)) return "Silver Prizm";
  m = T.match(/(blue|green|red|purple|gold|orange|pink|black)\s+ice\s+prizm/i);
  if (m) return capFirst(m[1]) + " Ice Prizm";
  m = T.match(/(blue|green|red|purple|gold|orange|pink|black)\s+pulsar/i);
  if (m) return capFirst(m[1]) + " Pulsar Prizm";
  m = T.match(/(red|blue|green|orange|purple|gold|pink)\s+wave\s+prizm/i);
  if (m) return capFirst(m[1]) + " Wave Prizm";
  m = T.match(/fast\s+break\s+(silver|blue|red|green|purple|gold|pink|orange|neon)/i);
  if (m) return "Fast Break " + capFirst(m[1]) + " Prizm";
  m = T.match(/hyper\s+(silver|blue|red|green|purple|gold)/i);
  if (m) return "Hyper " + capFirst(m[1]) + " Prizm";
  m = T.match(/mojo\s+prizm/i);
  if (m) return "Mojo Prizm";
  m = T.match(/(blue|red|green|purple|gold|pink|orange)\s+prizm/i);
  if (m) return capFirst(m[1]) + " Prizm";

  // Donruss Optic (basketball) — Holo/Silver base, then color velocities +
  // Pandora + Choice variants
  if (/\boptic\s+holo\b|\bholo\s+optic\b/i.test(T)) return "Holo Optic";
  m = T.match(/(blue|red|green|purple|orange|pink|gold)\s+velocity/i);
  if (m) return capFirst(m[1]) + " Velocity Optic";
  m = T.match(/choice\s+(blue|red|green|purple|orange|pink|gold)/i);
  if (m) return "Choice " + capFirst(m[1]) + " Optic";
  m = T.match(/(blue|red|green|purple|orange|pink|gold)\s+pandora/i);
  if (m) return capFirst(m[1]) + " Pandora Optic";
  m = T.match(/\b(silver|blue|red|green|purple|orange|pink|gold|holo)\s+optic\b/i);
  if (m) return capFirst(m[1]) + " Optic";

  // Panini Select — Concourse/Premier/Courtside tiers; Zebra is a pattern parallel
  if (/\bzebra\b/i.test(T)) return "Zebra Select";
  m = T.match(/(silver|blue|red|green|purple|gold|orange|pink)\s+select/i);
  if (m) return capFirst(m[1]) + " Select";

  // Contenders — Cracked Ice is the iconic parallel
  if (/cracked\s+ice/i.test(T)) return "Cracked Ice";

  // CF-REFRACTOR-FALLBACK-IS-LAST (Drew, 2026-08-31).
  //
  // The bare "Refractor(s)" fallback. Every named colour and pattern rule has
  // already run and returned, so "Blue Refractor" / "Mojo Refractor" / "Silver
  // Prizm" / "Holo Optic" reach their own rules first. This line reads the
  // word alone.
  //
  // CF-REFRACTORS-IS-HOW-TOPPS-PRINTS-IT (Drew, 2026-08-31). The trailing \b
  // made this fallback fail on the PLURAL, which is how Topps names the
  // parallel on its own checklist ("Refractors – /499") and how sellers title
  // it. The singular parsed; the plural fell to Base:
  //
  //   "2024 Bowman Chrome Refractors #80 Aaron Judge 167/499 YANKEES" -> Base
  //
  // 235 such rows in 2024 chrome-family alone. The plural is the SAME parallel
  // as the singular, so it returns the same canonical "Refractor" — one card,
  // one row, one pool.
  //
  // WHY IT SITS HERE AND NOT ABOVE THE BASKETBALL BLOCK. It used to sit right
  // after the baseball rules, which was survivable only while it was singular:
  // basketball titles say "Refractors" often enough that widening it to the
  // plural up there INTERCEPTED a whole sport before its own vocabulary was
  // reached. Measured, main vs branch:
  //
  //   "2024 Panini Prizm Silver Refractors #12 Wembanyama"  Silver Prizm -> Refractor
  //   "2023 Panini Donruss Optic Holo Refractors #10"       Holo Optic   -> Refractor
  //
  // The block's own comment ("These rules run AFTER the baseball checks
  // above") described an ordering that the widening quietly broke. A fallback
  // is only a fallback if every specific rule has had its turn, so it moved
  // below all of them. Nothing above it changed meaning: the singular already
  // lost to every rule it now still loses to.
  //
  // THE SAPPHIRE GATE. Bowman Chrome Sapphire is a DIFFERENT PRODUCT from
  // Bowman Chrome (the setKey taxonomy is explicit: bowman, bowman-chrome and
  // sapphire are different cards). The sapphire block above returns a "<Colour>
  // Sapphire" only when the title also names a colour; a sapphire title whose
  // only finish word is "Refractors" used to fall through to Base, and the
  // widened fallback turned that into a confident plain "Refractor" — a
  // sapphire sale leaking into the Bowman Chrome refractor pool at the LIVE
  // INGEST path.
  //
  // The repair script guards this with namesAnotherProduct(); the parser is
  // what every future ingest runs, so it needs the same refusal. Blank means
  // unknown, and unknown leaves the row where it is — which is the recoverable
  // direction.
  if (
    /\brefractors?\b/i.test(T) &&
    !AUTO_NEGATIVE_RE.test(T) &&
    !isMultiCardLot(T) &&
    !/\bsapphire\b/i.test(T)
  ) {
    return "Refractor";
  }

  // The chrome-auto Refractor default that used to sit here is GONE
  // (Drew, 2026-08-25: "no refractor is a base. Refractor is a parallel or a
  // finish and is out of /499 for autos", then "remove that 7/31 comment").
  //
  // It claimed the base tier of the chrome auto ladder IS Refractor, so any
  // Bowman Chrome or Topps Chrome auto title with no colour rule matched
  // returned "Refractor" instead of "Base". Refractor is a PARALLEL sitting
  // above base, /499 for autos -- so the default inverted the ladder, and
  // three things followed from it:
  //
  //   "2022 Bowman Chrome Prospects #CPA-MG Base"     -> Refractor
  //   "2026 Bowman Chrome ... True Base Auto #CPA-MG" -> Refractor
  //   "Marconi German 2026 Bowman #CPA-MG Chrome Auto" -> Refractor
  //
  // The first two say Base in the title and were overridden. The third is a
  // plain base auto. All three landed in refractor pools, so a real Gold /50
  // priced off base comps: $7.49 against $187 paid, -96%.
  //
  // It also split one card in two. A 2026 Topps Chrome #RA-JC auto went to
  // the Base pool ($175 median) when the seller typed the word "Base" and to
  // a Refractor pool when they did not -- same card, two prices, decided by
  // seller phrasing.
  //
  // Unrecognised now falls through to "Base", which is what the ladder says.

  // CF-NO-REFRACTOR-AUTO-RELEASED (Drew, 2026-08-15, on 2026 Bowman Eric
  // Hartman #CPA-EHA: "this is marked as a refractor but it is a base - eric
  // does not have a refractor auto" ... "eric hartman is the only one without
  // a refractor auto ... no card was released by topps. There was an issue
  // with his cards. It is an anomoly").
  //
  // The rule below is correct: the base tier of the chrome auto ladder IS
  // Refractor, for Bowman and Topps Chrome alike. Owen Carey's CPA-OC exists
  // in Base AND Refractor exactly as expected. This is not a product-wide
  // naming question and must not be "fixed" by narrowing the rule — doing so
  // would have moved 100,295 rows across bowman and bowman-chrome into a tier
  // they do not belong in.
  //
  // It is a PRODUCTION anomaly, at the level of one card. Topps never
  // released the Refractor auto for Eric Hartman, so 431 sold_comps rows were
  // filed under a parallel that does not physically exist — and several of
  // the titles say so outright ("True Base Auto", "Prospect Base AUTO").
  //
  // Keep this list tiny and keep every entry sourced. An entry is a claim
  // that a specific card was never printed in its ladder's base refractor
  // tier, which only the market can tell us. Do not add one by inference from
  // a thin checklist: our checklist coverage shows no Refractor tier for 151
  // of 190 2026 Bowman CPA-* cards, and that is a coverage gap, not 151
  // anomalies.
  // SCOPED BY YEAR, because card numbers are reused. CPA-EHA identifies Eric
  // Hartman in 2026 Bowman; nothing stops Topps issuing a CPA-EHA to someone
  // else in 2028, and an unscoped entry would silently inherit this anomaly
  // onto that card forever. A title with no year still matches — sellers
  // routinely omit it ("ERIC HARTMAN Bowman 1st Chrome Prospect Auto
  // #CPA-EHA") and today CPA-EHA means this card — but a title naming a
  // DIFFERENT year does not.
  const NO_REFRACTOR_AUTO_RELEASED: Array<{ number: RegExp; years: number[] }> = [
    // 2026 Bowman, Eric Hartman. Never released by Topps (Drew, 2026-08-15).
    { number: /#?\bCPA-EHA\b/i, years: [2026] },
  ];
  const titleYear = (() => {
    const m = T.match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  })();
  for (const entry of NO_REFRACTOR_AUTO_RELEASED) {
    if (!entry.number.test(T)) continue;
    if (titleYear !== null && !entry.years.includes(titleYear)) continue;
    return "Base";
  }

  // CF-SCARCITY-IS-NOT-BASE (Drew, 2026-08-16, on "2018 Topps Ohtani Warm-Up
  // Shirt SSP": "are we handling SSP of players? ... we need to add these
  // things to the catalog and find others in the data like that").
  //
  // We were not. A super-short-print photo variation parsed to parallel="Base"
  // and therefore produced the SAME SLUG as the common base card:
  //
  //   "2018 Topps Shohei Ohtani Warm-Up Shirt SSP #150" -> Base, #150
  //   "2018 Topps Shohei Ohtani #150 Base"              -> Base, #150
  //
  // So an SSP trading at a large multiple averaged into the base pool,
  // inflating the base FMV and deflating its own at the same time. Counting
  // sold_comps titles filed as parallel="Base" on 2026-08-16:
  //
  //     SSP        48,034 of 75,822      SHORT PRINT  6,355 of  7,475
  //     CASE HIT   27,915 of 33,900      PHOTO VAR.     826 of  1,465
  //
  // (IMAGE VARIATION was already handled — 10 of 11,839.)
  //
  // THIS FIRES ONLY AT THE FALLBACK, never over a colour rule. Scarcity and
  // colour are different axes: a "Blue Refractor SSP" is still the Blue
  // Refractor, and every colour/pattern rule above has already returned. What
  // reaches here is a card with no parallel of its own — exactly the set that
  // was collapsing into Base.
  //
  // SP IS A BRAND AS OFTEN AS IT IS A SHORT PRINT. Discovery over 20,000
  // Base-filed titles returned "upper deck sp" as the single most common
  // descriptor preceding an SP marker (1,857), ahead of every genuine scarcity
  // term. "SP Authentic" (11,146 rows) and "Upper Deck SP" (10,808) are
  // PRODUCT LINES; a bare "SP" rule would have mislabelled ~22,000 sales into
  // a tier that does not exist. Only unambiguous forms are matched.
  const isSpBrand = /\b(?:sp\s+authentic|upper\s+deck\s+sp|sp\s+legendary|sp\s+game\s+used|sp\s+signature)\b/i.test(T);
  if (/\bssp\b/i.test(T) && !isSpBrand) return "SSP";
  if (/\bcase\s+hit\b/i.test(T)) return "Case Hit";
  if (/\bshort\s+print\b/i.test(T) && !isSpBrand) return "Short Print";
  if (/\bphoto\s+variation\b/i.test(T)) return "Photo Variation";

  // CF-A-TITLE-THAT-NAMES-A-FINISH-IS-NOT-A-BASE-CARD (I9 triage, 2026-09-06).
  //
  // LAST, AND ONLY HERE. Every named colour, pattern, product and scarcity rule
  // above has already had its turn and returned, so this cannot override one of
  // them -- it reads ONLY the titles that were about to be called "Base".
  //
  // The I9 triage found 190 of 887 TRUE-DISAGREEMENT rows on a `dropped:parallel`
  // axis: the row stores a real parallel, the title states it in words, and this
  // function answered Base. Measured on a live 400-row draw, 260 of 386 non-Base
  // rows re-derived as Base -- "Rainbow Foil", "Black Foil", "Purple Holo Foil",
  // "Holographic", "Crackle Foil", "Canvas Parallel". The classifier's
  // base-eviction guard refuses every one of them, so nothing was mis-filed;
  // they simply sit as permanent disagreements the rematch can never act on.
  //
  // The answer comes from the CHECKLIST, not from a longer list here. Adding
  // rules one finish at a time is what produced the gap: the foil rule enumerated
  // nine colours and omitted black, and `holo` had no rule at all while being
  // attested 6,120 times in our own checklist corpus. `statedFinishFromChecklist`
  // asks `data/checklist-parallel-names.json` which parallels THIS product has
  // and answers with the checklist's own spelling, so the reader cannot mint a
  // rung the product lacks -- and where the destination is genuinely unbacked the
  // classifier's checklistBacked gate holds the row as NEEDS-CHECKLIST, which is
  // the honest state (#1796).
  //
  // A LOT STATES NO ONE CARD'S FINISH. `isMultiCardLot` is the same refusal the
  // bare-Refractor fallback above carries, for the same reason.
  if (!isMultiCardLot(T)) {
    const stated = statedFinishFromChecklist(T, { year: ctx?.year ?? null, setKey: ctx?.setKey ?? null });
    if (stated) return stated;
  }

  return "Base";
}

function capFirst(s: string): string {
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * CF-A-BARE-PRODUCT-WORD-NEVER-OUTRANKS-A-NAMED-BRAND (Drew, 2026-09-03).
 *
 * The V6 coverage ruling added bare-word aliases for products whose names are
 * NOT unique to one manufacturer: "Certified", "Prestige", "Origins",
 * "Studio", "Hoops", "Zenith", "Recon", "Finest". Unlike Prizm / Optic /
 * Select — which only Panini has ever printed, and which is why the older
 * Panini block may match them bare — these words appear inside the product
 * names of half a dozen other brands:
 *
 *   "1998 Upper Deck Eminent Prestige"          -> panini-prestige
 *   "2005 Upper Deck Origins"                   -> panini-origins
 *   "1998 Bowman Certified Blue Autographs"     -> panini-certified
 *   "1998 Bowman's Best ... Certified Auto"     -> panini-certified
 *
 * Measured read-only over 1,623 real sold_comps titles that name exactly one
 * manufacturer and contain one of these words (the population the defect
 * touches): 23.6% came back under a brand the title never names -- 84.8%
 * (178/210) of the Upper Deck rows, 66.2% of Bowman, 15.9% of Fleer. With the
 * guard, 0.2% and zero on Upper Deck. That is the SAME defect class as the
 * /sapphire/ bug this PR fixed one screen up: not a generic key that failed
 * to specialize, but a confidently WRONG one, which is worse, because a wrong
 * key still passes the slug guard and files a real sale into another brand's
 * pool.
 *
 * The rule: a bare product word may only claim a title that names NO other
 * manufacturer. When the seller wrote the brand, the brand wins — the
 * brand-explicit rules further down (Upper Deck, Skybox, Pinnacle, Score,
 * Bowman) are reached instead, and a genuinely unbranded "2025 Finest #168"
 * still matches. `noRivalBrand` is the guard; every bare alias below carries
 * it, and a mutation test proves each one is load-bearing.
 */
const RIVAL_BRAND_WORDS = /\b(?:upper\s*deck|bowman'?s?|topps|fleer|donruss|score|skybox|pinnacle|leaf|panini|pacific|flair|ultra|playoff|sage|press\s+pass)\b/i;

/** True when `t` names no manufacturer other than the ones in `own`. */
function noRivalBrand(t: string, own: RegExp | null = null): boolean {
  const hits = t.match(new RegExp(RIVAL_BRAND_WORDS.source, "gi")) ?? [];
  if (hits.length === 0) return true;
  if (!own) return false;
  return hits.every((h) => own.test(h));
}

/** Infer setKey from a title. Best-effort — recognizes the common
 *  Bowman/Topps/Panini product lines. When nothing matches, returns
 *  a generic "Bowman" fallback (callers should override when they
 *  have more specific knowledge).
 *
 *  CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). "bpa = bowman paper" —
 *  BPA-XX / BDA-XX cardNumbers indicate the paper-stock autograph
 *  subset of Bowman flagship / Bowman Draft, which is a DISTINCT
 *  product from the paper base cards and from Bowman Chrome autos.
 *  Historically these collapsed into the generic "Bowman" setKey,
 *  blending paper-auto FMV with paper-base FMV. Now derive
 *  "Bowman Paper" whenever the title carries explicit Paper Prospect
 *  Auto tokens. The card-number-driven form (BPA-XX with a bare
 *  "2026 Bowman" title that omits "Paper") is handled by the
 *  cardNumber-aware overload below. */
/** CF-THE-POKEMON-VOCABULARY-WAS-NEVER-REACHABLE-FROM-THE-TITLE (2026-09-04).
 *
 *  Find the English Pokemon set a TITLE names, using the alias table
 *  card_catalog is already keyed by. Returns the tcgdex set id (`sv08-5`,
 *  `me01`) -- which `normalizeSetKey` holds as a fixed point -- or null.
 *
 *  Japanese titles are refused outright: their codes are a separate ruled
 *  vocabulary (JAPANESE_POKEMON_SET_ALIASES) and the two collide on real set
 *  names such as `151`.
 *
 *  Matching runs over a slugified title with the year and the word "pokemon"
 *  removed, so "2025 Pokemon Prismatic Evolutions Umbreon ex 161/131" and
 *  "Prismatic Evolutions Umbreon ex" both find `prismatic-evolutions`. An
 *  alias must land on SEGMENT boundaries -- a bare substring match would let
 *  a card number claim a set -- and the LONGEST alias wins, so a specialized
 *  product is never collapsed into its flagship (CF-PRODUCT-FAMILY-COLLAPSE-
 *  IS-FORBIDDEN, the same rule `normalizeSetKey` states).
 *
 *  Aliases shorter than 4 characters are dropped: keys like `151` are real
 *  set names but far likelier to be a card number inside a sales title, and a
 *  wrong key that passes the slug guard is worse than no key at all.
 */
const POKEMON_ALIASES_LONGEST_FIRST: ReadonlyArray<readonly [string, string]> = Object.freeze(
  Object.entries(POKEMON_SET_ALIASES)
    .filter(([alias]) => alias.length >= 4)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([alias, key]) => Object.freeze([alias, key]) as readonly [string, string]),
);

/** CF-THE-SET-CODE-IS-THE-KEY (2026-09-05).
 *
 *  Sellers write the set CODE at least as often as the set NAME, and the name
 *  table cannot see a code. The unknown-setKey census (#1796) measured the
 *  Pokemon half of the ~500k "needs vocabulary" bucket and it is overwhelmingly
 *  promo and code spellings -- `mep en-me black star` (2,877 rows),
 *  `sv black star promos` (1,884), `swsh black star promo` (1,631),
 *  `sm black star promo` (1,483), `svp en-sv black star` (1,216). Every one of
 *  those is a real tcgdex set id that no alias in POKEMON_SET_ALIASES spells.
 *
 *  THE CODE IS ONLY READ WHERE IT CANNOT BE A CARD NUMBER. That is the whole
 *  risk, and three rules contain it:
 *
 *  1. A code is matched on SEGMENT boundaries of the slugified title, never as
 *     a substring, so `sv08-5` inside a serial cannot claim a set.
 *  2. A code of three characters or fewer is refused unless the title also
 *     carries the word "promo" (which is what `svp`/`smp`/`mep` mean). 146 of
 *     the 378 codes are <=3 chars and several are ordinary English words in a
 *     card title -- `sp` is "Sample", `rc` is "Radiant Collection", `lc` is
 *     "Legendary Collection". A bare `RC` in "Charizard RC 25" is a card
 *     number far more often than it is a set, and a wrong key that passes the
 *     slug guard is worse than no key (CF-UNKNOWN-IS-ALSO-A-GUESS).
 *  3. The 24 AMBIGUOUS_MARKET_CODES are refused outright from a bare code.
 *     `sm1` is "Sun & Moon" in English and "Collection Sun" in Japanese --
 *     different products, different prints, different prices -- so the code
 *     alone cannot say which card the sale is, and the resolver declines
 *     rather than pool one market into the other. This is
 *     CF-THE-JAPANESE-CODE-IS-THE-KEY applied to codes.
 *
 *  Promo codes are matched FIRST because they are the census's population and
 *  because their spelling (`svp`, `mep`) is unambiguous once "promo" or "black
 *  star" is present in the title.
 */
function resolvePokemonSetCodeFromTitle(hay: string, rawTitle: string): string | null {
  const saysPromo = /\b(promo|black\s*star)\b/i.test(rawTitle);
  const seg = (code: string): boolean => hay.includes("-" + code + "-");

  // Promo codes first: they ARE the census population, and "promo"/"black
  // star" in the title is the context that makes a 3-letter code readable.
  if (saysPromo) {
    for (const code of Object.keys(POKEMON_PROMO_SET_CODES)) {
      if (seg(code)) return code;
    }
    // THE SPELLING SELLERS ACTUALLY USE, and it is not the promo code.
    // tcgdex names the set `swshp`, but the census's rows say
    // `swsh black star promo` (1,631) and `sm black star promo` (1,483) --
    // the ERA prefix plus the words, never the code. The era prefix alone is
    // not a set (it is a whole series), so it is only read as the promo set
    // when "black star"/"promo" is present, which is exactly this branch.
    //
    // The mapping is derived from the promo table, not authored: for each
    // promo code ending in `p`, the era is the code minus that `p`.
    for (const code of Object.keys(POKEMON_PROMO_SET_CODES)) {
      if (!code.endsWith("p") || code.length < 3) continue;
      const era = code.slice(0, -1);
      // `-swsh-` in "2022 Pokemon SWSH Black Star Promo". Segment-matched, so
      // a card number "SWSH270" (one token, no hyphen) cannot claim it.
      if (era.length >= 2 && seg(era)) return code;
    }
  }
  // Then the full English vocabulary, longest code first so `sv08-5` is not
  // shadowed by `sv08` -- the same product-family rule the alias table follows.
  for (const code of EN_CODES_LONGEST_FIRST) {
    if (AMBIGUOUS_MARKET_CODES.has(code)) continue;
    if (code.length <= 3 && !saysPromo) continue;
    if (seg(code)) return code;
  }
  return null;
}

/** The English codes, longest first, so a specialized set is never shadowed by
 *  the flagship whose code is its prefix (`sv08-5` vs `sv08`). */
const EN_CODES_LONGEST_FIRST: readonly string[] = Object.freeze(
  [...Object.keys(POKEMON_EN_SET_CODES), ...Object.keys(POKEMON_PROMO_SET_CODES)]
    .sort((a, b) => b.length - a.length),
);

/** The Japanese codes, longest first, for the same reason. */
const JA_CODES_LONGEST_FIRST: readonly string[] = Object.freeze(
  Object.keys(POKEMON_JA_SET_CODES).sort((a, b) => b.length - a.length),
);

/** CF-THE-SET-CODE-IS-THE-KEY, the Japanese half (2026-09-05).
 *
 *  The census's Japanese rows spell the code inside a hyphenated phrase --
 *  `japanese m5-abyss eye special` (1,661 rows), `japanese m3-nullifying zero
 *  art` (1,780), `japanese m2a-mega dream ex` (1,142). The code is the first
 *  token and the romanized set name follows it, so a segment match on the
 *  slugified title finds it.
 *
 *  ONLY REACHED FROM A TITLE THAT SAYS IT IS JAPANESE, and only over the
 *  Japanese-only code table -- the 24 shared ids are absent from that table by
 *  construction (see pokemonSetCodes.ts), so this can never answer with a code
 *  an English set owns. That is the negative CF-THE-JAPANESE-CODE-IS-THE-KEY
 *  pins for `swsh12`: a Japanese reading must never drag an English product
 *  onto a Japanese key, nor the reverse.
 */
export function resolveJapanesePokemonSetCodeFromTitle(title: string): string | null {
  const t = String(title ?? "");
  if (!/\b(pokemon|pok[eé]?mon|pok\s?mon)\b/i.test(t)) return null;
  if (!/\b(japanese|jpn)\b/i.test(t)) return null;
  const hay = "-" + slugify(t.replace(/\b(19|20)\d{2}\b/g, " ")) + "-";
  if (hay === "--") return null;
  for (const code of JA_CODES_LONGEST_FIRST) {
    // Three-character Japanese codes (`s8b`, `sm1`) are as collidable as the
    // English ones and there is no "promo" context to license them here, so
    // the floor is 4 characters with one exception: a code that is followed by
    // a hyphen in the ORIGINAL title (`m5-abyss`) was written as a set code by
    // the seller, which is exactly the census's shape.
    const writtenAsCode = new RegExp(`\\b${code}-[a-z]`, "i").test(t);
    if (code.length <= 3 && !writtenAsCode) continue;
    if (hay.includes("-" + code + "-")) return code;
  }
  return null;
}

export function resolveEnglishPokemonSetFromTitle(title: string): string | null {
  const t = String(title ?? "");
  if (!/\b(pokemon|pok[eé]?mon|pok\s?mon)\b/i.test(t)) return null;
  // The Japanese vocabulary owns these titles -- see the caller's note.
  if (/\b(japanese|jpn)\b/i.test(t)) return null;
  const cleaned = t
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/pok[eé]?mon/gi, " ");
  const hay = "-" + slugify(cleaned) + "-";
  if (hay === "--") return null;
  // The NAME answers first: it is the more specific signal, and every name
  // alias was already ruled. The code is the fallback for the titles the name
  // table cannot see, which is the census population.
  for (const [alias, key] of POKEMON_ALIASES_LONGEST_FIRST) {
    if (hay.includes("-" + alias + "-")) return key;
  }
  return resolvePokemonSetCodeFromTitle(hay, t);
}

export function inferSetKeyFromTitle(title: string, cardNumber?: string | null): string {
  // CF-THE-YEAR-DOES-NOT-SPLIT-THE-PRODUCT (Drew, 2026-08-31). Every product
  // rule below is written as adjacent words (/topps\s+chrome/), but sellers —
  // and CardHedge's own slab-derived titles — routinely write the brand, then
  // the year, then the rest of the product:
  //
  //   "2024 Topps Chrome Update ... X-Fractor"  -> Topps Chrome   (correct)
  //   "Topps 2024 Chrome Update ... X-Fractor"  -> Topps          (the SAME card)
  //
  // The interposed year defeated the adjacency and the row collapsed to the
  // bare brand. Measured on the 2026-08-31 setKey-misfile slice: 60 of 153
  // rows, the single largest bucket, including every "Topps 2024 Chrome
  // Update Paul Skenes" spelling. Lifting the year out ONCE fixes every
  // product rule at the same time; adding a year-tolerant variant to each of
  // the forty-odd regexes below is where they would drift apart.
  //
  // Only a 4-digit year in set-year range is lifted, and only when a brand
  // word precedes it, so "Topps 2024" reads as the product it names while a
  // genuine numeric token ("Topps Chrome 1989 Edition") is left alone.
  const raw = String(title ?? "").toLowerCase();
  const t = raw.replace(
    /\b(topps|bowman|panini|leaf|fleer|donruss|upper\s+deck|score|select)\s+((?:19|20)\d{2})\s+/g,
    "$1 ",
  );
  const cn = String(cardNumber ?? "").toUpperCase();

  // Bowman Paper detection — title-first, then cardNumber-prefix fallback.
  // Must run BEFORE the plain /bowman/ rules below so a "2026 Bowman
  // ... 1st Paper Prospect Auto" title doesn't collapse to plain "Bowman".
  const titleSaysPaper =
    /1st\s+paper|paper\s+prospect|paper\s+auto|paper\s+autograph/i.test(t);
  const cardNumSaysPaper = /^BPA-|^BDA-/i.test(cn);
  if (titleSaysPaper || cardNumSaysPaper) {
    if (/draft/i.test(t) || /^BDA-/i.test(cn)) return "Bowman Draft Paper";
    return "Bowman Paper";
  }

  // CF-SAPPHIRE-IS-NOT-ALWAYS-BOWMAN (Drew, 2026-09-03, V6 coverage ruling).
  //
  // This rule read `if (/sapphire/.test(t)) return "Bowman Chrome Sapphire"`,
  // which handed EVERY Sapphire product to Bowman on the strength of one
  // unqualified word. Topps prints Sapphire too, and the census measured the
  // cost: `topps-chrome-sapphire` is the 7th largest UNDERIVABLE setKey in the
  // pool at ~77,119 rows and `topps-chrome-update-sapphire` another ~18,138 --
  // every one of them a Topps card the parser called Bowman.
  //
  // Verified against the live parser before the fix: the title
  // "A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES" -- which
  // says TOPPS twice and never says Bowman -- inferred "Bowman Chrome
  // Sapphire". That is not a generic key that failed to get more specific; it
  // is a confidently WRONG product, which is worse, because a wrong key still
  // passes the slug guard and files a real sale into another brand's pool.
  //
  // Most specific first, and the brand must be NAMED. The bare fallback stays
  // Bowman -- that is the historical behaviour and Bowman Sapphire is by far
  // the commonest -- but it now fires only when nothing says Topps.
  if (/sapphire/.test(t)) {
    if (/topps\s+chrome\s+update|chrome\s+update\s+series/.test(t)) return "Topps Chrome Update Sapphire";
    if (/topps\s+update/.test(t)) return "Topps Update Sapphire";
    if (/\btopps\b/.test(t)) return "Topps Chrome Sapphire";
    if (/bowman\s+draft/.test(t)) return "Bowman Draft Sapphire";
    // CF-BOWMAN-DEFAULT-NOT-EVIDENCE (2026-09-05). This used to return
    // "Bowman Chrome Sapphire" for a title that names NO manufacturer at all,
    // on the reasoning that Bowman Sapphire is the commonest -- a MAKER
    // DEFAULT, i.e. a guess dressed as a parse.
    //
    // Why that is not a small wrong answer. `setKey` becomes the slug, the
    // slug becomes `cardId`, and `cardId` is the sold_comps PARTITION KEY.
    // The id is `${source}::${externalId}` and is stable, but the partition
    // is a pure function of this parse -- so the same eBay sale ingested
    // once while this line guessed `bowman` and again after it stopped
    // guessing lands as TWO documents under two partition keys. The
    // pre-write dedup cannot see the first one: it matches on
    // `hobbyiqCardId` + `contentHash`, and `contentHash` is hashed over the
    // slug, so BOTH clauses move together with the guess. One sale, two
    // addresses: a split pool and a double count.
    //
    // A brand-less "Sapphire" title states a FINISH, not a product. Blank
    // means unknown, never a default (CF-EVERY-INGEST-USES-THE-ONE-CHECKLIST-
    // FORMAT), and absent beats wrong: "Unknown" parks the row for review
    // instead of filing a Panini or Topps sale into the Bowman pool. The
    // named-brand branches above are untouched -- they read evidence.
    //
    // A title that names another manufacturer still FALLS THROUGH to that
    // brand's own rules below, exactly as before.
    if (noRivalBrand(t, /bowman/i) && /\bbowman\b/.test(t)) return "Bowman Chrome Sapphire";
  }
  if (/topps\s+update/.test(t)) return "Topps Update";
  // CF-TRADED-TIFFANY-IS-A-PRODUCT (2026-09-04). Topps Traded (1974-2005),
  // Topps Tiffany (the glossy factory set, 1984-1991) and Topps Traded
  // Tiffany (both at once) are three DISTINCT products. `normalizeSetKey`
  // has ruled on all three since 2026-08-04 -- they are fixed points there,
  // and productSetKeys.ts carries them with their parent ladder -- but this
  // parser had no rule for either word, so every such title fell past the
  // ~30 `topps <product>` rules below to the bare `/topps/` catch-all and
  // came back as flagship "Topps". Both words were lost at that one line:
  // it returns a constant and never reads the rest of the title.
  //
  // Two services disagreeing about a product is the defect setKeyReconcil-
  // iation.ts:340 already names for eTopps, in the mirror direction, and
  // the one that ruled deliberately wins. Measured cost of the silence:
  // 6,299 sold_comps rows whose title says Tiffany carry a slug that does
  // not, and 27,538 rows whose title says Traded sit under flagship
  // `:topps:`. The 1987 #70T Greg Maddux pool is the worked example --
  // 2,418 sales of several different cards in one pool, where PSA 10
  // Tiffany sales ($910-$1,560) are outnumbered ~5:1 by PSA 10 non-Tiffany
  // Traded sales (~$150), so the Tiffany card prices as the common one.
  //
  // Order is most-specific-first, mirroring the same ordering doctrine in
  // hobbyIqCardId.service.ts:454 ("Order: 3-word variants first"). All
  // three destinations already exist in productSetKeys.ts:140-142, so no
  // new vocabulary is invented here -- the parser is only being taught to
  // reach the keys the vocabulary already ruled on.
  if (/topps\s+traded\s+tiffany/.test(t)) return "Topps Traded Tiffany";
  if (/topps\s+traded/.test(t)) return "Topps Traded";
  if (/topps\s+tiffany/.test(t)) return "Topps Tiffany";
  // Bowman Tiffany (1989-1991) is the same factory-glossy idea on Bowman
  // stock and is likewise a ruled key (setkey-reconciliation.json marks it
  // `distinct`, 453 checklist rows) with no parser rule.
  if (/bowman\s+tiffany/.test(t)) return "Bowman Tiffany";
  if (/topps\s+heritage/.test(t)) return "Topps Heritage";
  if (/topps\s+heavy\s+lumber|heavy\s+lumber/.test(t)) return "Topps Heavy Lumber";
  // CF-TOPPS-PRODUCT-LINES (Drew, 2026-07-29). Complete Topps taxonomy so
  // rows for these distinct product lines stop collapsing to bare "topps"
  // (which pollutes pricing pools and misroutes the family ladder). All
  // must match BEFORE /topps\s+chrome/ where possible; Finest/Pristine/
  // Stadium Club/Allen-Ginter are their own products, not chrome variants.
  // D36 (Drew, 2026-08-30): the product is topps-finest, and collectors write
  // it "Finest" -- "2025 Finest #168 Xavier Worthy Purple Refractor" names no
  // brand at all. The rule required the brand word, so ~192,725 UNDERIVABLE
  // rows (the LARGEST single reclassifiable key in the census) fell to
  // "Unknown". The bare word is unambiguous: Topps is the only manufacturer
  // that prints a product called Finest, and the regex vocabulary already
  // carries the same bare alias (/(^|-)finest(-|$)/ -> topps-finest).
  if (/topps\s+finest/i.test(t) || (/\bfinest\b/i.test(t) && noRivalBrand(t, /topps/i))) return "Topps Finest";
  if (/topps\s+pristine/i.test(t)) return "Topps Pristine";
  if (/topps\s+transcendent/i.test(t)) return "Topps Transcendent";
  if (/topps\s+dynasty/i.test(t)) return "Topps Dynasty";
  if (/topps\s+tribute/i.test(t)) return "Topps Tribute";
  if (/topps\s+inception/i.test(t)) return "Topps Inception";
  if (/topps\s+definitive/i.test(t)) return "Topps Definitive";
  if (/topps\s+five[-\s]?star|five[-\s]?star/i.test(t)) return "Topps Five Star";
  // The bare "Museum Collection" is not Topps-exclusive -- Donruss Zenith
  // printed one too ("2005 Donruss Zenith Museum Collection"), and the bare
  // arm claimed it. Same guard, same reason as the bare product words below.
  if (/topps\s+museum/i.test(t) || (/museum\s+collection/i.test(t) && noRivalBrand(t, /topps/i))) return "Topps Museum Collection";
  if (/topps\s+stadium\s+club|stadium\s+club/i.test(t)) return "Topps Stadium Club";
  if (/topps\s+allen[-\s]?(and\s+)?ginter|allen[-\s]?(and\s+)?ginter/i.test(t)) return "Topps Allen Ginter";
  if (/topps\s+gypsy\s+queen|gypsy\s+queen/i.test(t)) return "Topps Gypsy Queen";
  if (/topps\s+archives/i.test(t)) return "Topps Archives";
  if (/topps\s+big\s+league|big\s+league/i.test(t)) return "Topps Big League";
  if (/topps\s+bunt/i.test(t)) return "Topps Bunt";
  // CF-SUBPRODUCT-SETKEY (Drew, 2026-08-15). These product lines existed in
  // card_catalog but had no parser rule, so every sale of them collapsed to
  // the parent brand ("topps"/"bowman"/"fleer") and then failed to match a
  // catalog row that was sitting right there.
  //
  // Measured over 30,000 awaiting-catalog staging rows: 19,900 (66%)
  // inferred a GENERIC setKey. All 17 product lines below were confirmed
  // present in card_catalog FIRST — the point is to route to rows we
  // already hold, not to invent new ones:
  //
  //   leaf-metal 108,608 · topps-tier-one 92,677 · bowman-platinum 87,074
  //   topps-triple-threads 83,910 · topps-pro-debut 65,989
  //   topps-cosmic-chrome 34,144 · bowman-inception 18,029
  //   topps-now 14,221 · topps-shoebox-treasures 4,038 · fleer-update 2,504
  //   topps-signature-class 1,191 · fleer-ultra 598 · etopps 304
  //   panini-totally-certified 284 · topps-resurgence 86 · panini-noir 76
  //   fleer-metal 17
  //
  // Two were not merely generic but WRONG: "Panini Totally Certified" and
  // "Panini Noir" both returned "Bowman".
  //
  // ORDER MATTERS. Each must precede its parent brand's bare rule, and
  // eTopps must precede /topps/ since the brand name is a substring of it.
  if (/\betopps\b/i.test(t)) return "eTopps";
  if (/topps\s+pro\s+debut/i.test(t)) return "Topps Pro Debut";
  if (/topps\s+signature\s+class/i.test(t)) return "Topps Signature Class";
  if (/topps\s+cosmic\s+chrome|cosmic\s+chrome/i.test(t)) return "Topps Cosmic Chrome";
  if (/topps\s+triple\s+threads|triple\s+threads/i.test(t)) return "Topps Triple Threads";
  if (/topps\s+tier\s+one|tier\s+one/i.test(t)) return "Topps Tier One";
  if (/topps\s+shoebox\s+treasures|shoebox\s+treasures/i.test(t)) return "Topps Shoebox Treasures";
  if (/topps\s+resurgence/i.test(t)) return "Topps Resurgence";
  // "Topps Now" is a dated print-to-order line. Anchor on the brand so a
  // stray "now" elsewhere in a title cannot claim it.
  if (/topps\s+now\b/i.test(t)) return "Topps Now";
  // Panini sub-products — both of these previously returned "Bowman".
  if (/panini\s+totally\s+certified|totally\s+certified/i.test(t)) return "Panini Totally Certified";
  if (/panini\s+noir\b/i.test(t)) return "Panini Noir";
  if (/leaf\s+metal/i.test(t)) return "Leaf Metal";

  if (/topps\s+chrome/.test(t)) return "Topps Chrome";
  // CF-FLEER-STICKERS (Drew, 2026-07-29). 1986 Fleer Stickers (basketball)
  // is a distinct product from base 1986 Fleer — Michael Jordan #8 Sticker
  // rookie is separate from Fleer #57 Jordan base rookie. Recognize as
  // its own setKey. Must match BEFORE bare /topps/ / default Bowman
  // fallback. Applies to any year — Fleer produced sticker inserts across
  // multiple sports/years, all distinct products.
  if (/fleer\s+stickers?/i.test(t)) return "Fleer Stickers";
  if (/fleer\s+ultra|\bultra\s+fleer\b/i.test(t)) return "Fleer Ultra";
  if (/fleer\s+metal|metal\s+universe/i.test(t)) return "Fleer Metal";
  if (/fleer\s+update/i.test(t)) return "Fleer Update";
  if (/\bfleer\b/i.test(t)) return "Fleer";
  if (/bowman\s+platinum/i.test(t)) return "Bowman Platinum";
  if (/bowman\s+inception/i.test(t)) return "Bowman Inception";
  if (/bowman\s+draft\s+chrome/.test(t)) return "Bowman Draft Chrome";
  if (/bowman\s+draft/.test(t)) return "Bowman Draft";
  if (/bowman\s+chrome\s+prospects?/.test(t)) return "Bowman Chrome";
  if (/bowman\s+chrome/.test(t)) return "Bowman Chrome";
  if (/bowman\s+mega\s+box/.test(t)) return "Bowman Chrome Mega Box";
  // CF-CHROME-IMPLIED (Drew, 2026-07-29). Some parallels are Chrome-
  // exclusive (they don't exist on Bowman Paper): Speckle, Shimmer,
  // Lava, Wave, Ray Wave, Grass, X-Fractor, Mojo, Prism, Mini Diamond,
  // and any bare "Refractor". When a title says "Bowman" but omits
  // "Chrome" AND carries one of these chrome-only signals, upgrade to
  // Bowman Chrome. Ordered AFTER bowman-draft/chrome/sapphire so
  // explicit product-line phrases still win.
  //
  // OBSERVED: "2026 Bowman Speckle Refractor" (title omits "Chrome")
  // landed at setKey=bowman. Speckle is chrome-only; this is bowman-chrome.
  //
  // CF-CHROME-IMPLIED-EDITION-GUARD (Drew, 2026-07-30). Framework rule:
  // edition tokens (Sapphire, Mega Box, 1st Edition, Sonic, Cosmic,
  // Lite) reroute the whole comp pool. If the title carries an edition
  // token, DO NOT collapse to base "Bowman Chrome" — the edition-
  // specific handler (Sapphire → Bowman Chrome Sapphire; Mega Box →
  // Bowman Chrome Mega Box) should already have matched above, but if
  // it didn't, DEFER rather than pool with base. Also skip when the
  // cardNumber prefix implies a Sapphire subset (BSPA-XX).
  if (/bowman/.test(t) && /speckle|shimmer\s+refractor|\blava\s+refractor|wave\s+refractor|grass\s+refractor|x-?fractor|mojo\s+refractor|mega\s+refractor|prism\s+refractor|mini\s+diamond|\brefractor\b/i.test(t)) {
    // Edition guard: any explicit edition token → don't collapse to base
    if (/\b(sapphire|mega\s?box|1st\s+edition|first\s+edition|sonic|cosmic\s+chrome|\blite\b)/i.test(t)) {
      // Fall through — an edition-specific rule above should have
      // matched, or the caller will treat as base with an edition flag.
    } else if (/^BSPA-/i.test(cn)) {
      // cardNumber says this is Sapphire Prospect Autographs subset.
      return "Bowman Chrome Sapphire";
    } else {
      return "Bowman Chrome";
    }
  }
  // CF-PANINI-PRODUCT-LINES (Drew, 2026-07-29). Full Panini taxonomy so
  // rows for these distinct products stop collapsing to bare "panini".
  // Match on either "Panini <Product>" OR the bare product name when the
  // product IS uniquely Panini (Prizm, Optic, Select, etc. are all
  // Panini-exclusive brand names). Order most-specific first.
  if (/panini\s+national\s+treasures|national\s+treasures/i.test(t)) return "Panini National Treasures";
  if (/panini\s+immaculate|immaculate/i.test(t)) return "Panini Immaculate";
  if (/panini\s+flawless|\bflawless\b/i.test(t)) return "Panini Flawless";
  if (/panini\s+one[-\s]?one|\bone\s+one\b/i.test(t)) return "Panini One One";
  if (/panini\s+contenders|\bcontenders\b/i.test(t)) return "Panini Contenders";
  if (/panini\s+absolute|\babsolute\b/i.test(t)) return "Panini Absolute";
  if (/panini\s+chronicles|\bchronicles\b/i.test(t)) return "Panini Chronicles";
  if (/panini\s+phoenix|\bphoenix\b/i.test(t)) return "Panini Phoenix";
  if (/panini\s+illusions|\billusions\b/i.test(t)) return "Panini Illusions";
  if (/panini\s+obsidian|\bobsidian\b/i.test(t)) return "Panini Obsidian";
  if (/panini\s+spectra|\bspectra\b/i.test(t)) return "Panini Spectra";
  if (/panini\s+revolution|\brevolution\b/i.test(t)) return "Panini Revolution";
  if (/panini\s+crown\s+royale|crown\s+royale/i.test(t)) return "Panini Crown Royale";
  if (/panini\s+select|\bselect\b/i.test(t)) return "Panini Select";
  if (/panini\s+mosaic|\bmosaic\b/i.test(t)) return "Panini Mosaic";
  if (/panini\s+optic|donruss\s+optic/i.test(t) || (/\boptic\b/i.test(t) && noRivalBrand(t, /panini|donruss/i))) return "Panini Optic";
  if (/panini\s+donruss|\bdonruss\b/i.test(t)) return "Panini Donruss";
  if (/panini\s+prizm|\bprizm\b/i.test(t)) return "Panini Prizm";
  if (/topps/.test(t)) return "Topps";
  // CF-INFER-SET-POKEMON-GUARD (Drew, 2026-08-03). Bowman is the
  // baseball default for unmatched sports titles, but TCA firehose
  // pipes Pokemon/TCG in the same pool. Returning "Bowman" for
  // "Terrakion White Promo Japanese" mis-tags the row's setName.
  // For obviously non-sports contexts, return a truthful placeholder
  // so the LLM-provided setName wins downstream (persistVendorSalesToPool
  // uses `?? inferSetKeyFromTitle` for the fallback).
  if (/\b(pokemon|pok[eé]?mon|pok\s?mon|yugioh|yu-?gi-?oh|magic\s+the\s+gathering|\bmtg\b|dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|star\s+wars|halo|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|hearthstone|lorcana|flesh\s+and\s+blood)\b/.test(t)) {
    // CF-THE-POKEMON-VOCABULARY-WAS-NEVER-REACHABLE-FROM-THE-TITLE
    // (2026-09-04, follow-on to V6 / #1624).
    //
    // The `return "Unknown"` below is truthful ONLY when nothing in the title
    // names a set we already know. For English Pokemon it was not: the whole
    // vocabulary -- 1,497 aliases over 214 sets, generated from tcgdex and
    // already the spelling card_catalog uses -- lives in POKEMON_SET_ALIASES,
    // and this function never consulted it. The table was reachable only from
    // `resolveSetKeyForSlug`, which is called with a setName the CALLER
    // already holds; a re-derivation carrying nothing but the TITLE could
    // never get there.
    //
    // Measured on the live pool (read-only, 2026-09-04), sport=pokemon /
    // cardYear=2025: 60,767 of 60,911 rows (99.8%) UNDERIVABLE, every one of
    // them on `setkey-unknown-unsupported` -- NOT the bowman default, because
    // this guard intercepts first. The seven largest are sets whose aliases
    // and whose tcgdex-scraped checklists BOTH already exist:
    //
    //     Prismatic Evolutions  14,631 -> sv08-5   (600 catalog rows)
    //     Journey Together       9,162 -> sv09     (484)
    //     Destined Rivals        7,751 -> sv10   (1,074)
    //     Black Bolt             7,550 -> sv10-5b  (479)
    //     White Flare            6,664 -> sv10-5w  (449)
    //     Mega Evolution         4,128 -> me01     (505)
    //     Phantasmal Flames      2,674 -> me02     (314)
    //
    // So this is not a vocabulary to author -- CF-NO-SYNTHETIC-PARALLELS is
    // not in play and no set name is invented here. It is one table made
    // reachable from the one input a re-derivation actually has.
    //
    // JAPANESE IS EXCLUDED, deliberately and for the reason
    // `resolveSetKeyForSlug` already states: "2023 Pokemon Japanese Scarlet &
    // Violet 151" must reach the Japanese code (sv2a), and the English alias
    // for `151` (sv03-5) would pool a Japanese print into the English card --
    // a different print with a different market. A Japanese title keeps
    // returning "Unknown" here and is resolved by the Japanese branch, which
    // owns that vocabulary.
    const en = resolveEnglishPokemonSetFromTitle(raw);
    if (en) return en;
    // CF-THE-SET-CODE-IS-THE-KEY, the Japanese half (2026-09-05). The note
    // above is still right that the English NAME vocabulary must never read a
    // Japanese title -- `151` is sv03-5 in English and sv2a in Japanese. But
    // "Unknown" was not the only alternative: a Japanese title that spells its
    // own set CODE (`Japanese M5-Abyss Eye`, `Japanese M2a-Mega Dream ex` --
    // 1,661 and 1,142 census rows) names its product unambiguously, and the
    // Japanese-only code table cannot answer with a code an English set owns
    // because the 24 shared ids are absent from it by construction.
    const ja = resolveJapanesePokemonSetCodeFromTitle(raw);
    if (ja) return ja;
    return "Unknown";
  }
  // CF-BRANDS-BEFORE-THE-FALLBACK (Drew, 2026-08-16: "do it").
  //
  // These manufacturers had NO rule at all — "score", "skybox" and "o-pee-chee"
  // appeared zero times in this file — so their cards fell to the Bowman
  // default below, which fired on any title containing "baseball" or "rookie".
  // A 1994 Upper Deck baseball rookie therefore came back as Bowman.
  //
  // Measured across 9,765,902 comps by comparing each slug's product against
  // its own title:
  //
  //     147,700  upper-deck  parsed as "unknown"
  //      90,732  upper-deck  parsed as "bowman"
  //      34,428  o-pee-chee  parsed as "unknown"
  //      27,013  score       parsed as "bowman"
  //      26,441  skybox      parsed as "unknown"
  //      21,826  panini      parsed as "bowman"
  //      18,615  leaf        parsed as "bowman"
  //
  // ~432,000 comps where the SLUG was right and the PARSER was wrong. That
  // matters twice: it blocks the null-slug backfill, and it made the
  // title-vs-slug audit unusable — a fifth of the "disagreements" were this
  // fallback rather than real mis-slugging.
  //
  // Longest name first within a family, so "Upper Deck SP Authentic" is not
  // eaten by the bare "Upper Deck" rule.
  // ── CF-SUPPORTED-SETKEYS-BY-ROW-COUNT (Drew, 2026-09-03, ruling V6) ───────
  //
  // 4.2M rows in the Great Rematch census are UNDERIVABLE for one reason:
  // `setkey-unknown-unsupported`. They are not unreadable titles -- they are
  // titles naming a product THIS FUNCTION HAS NO RULE FOR, so it returns
  // "Unknown", normalizeSetKey turns that into `unknown`, and the derivation
  // refuses the row rather than mint a guess.
  //
  // Drew ruled the keys are added BY ROW COUNT, largest first. Each line below
  // carries the estimated UNDERIVABLE rows it reclassifies, scaled from the 32
  // census artifacts (sampled UNDERIVABLE lines per shard, weighted by that
  // shard`s own `setkey-unknown-unsupported` + `setkey-bowman-default-
  // unsupported` population; 8,526,430 rows total), and whether card_catalog
  // holds CHECKLIST-BACKED rows for it -- read-only counts taken 2026-09-03.
  //
  // WHAT "SUPPORTED" MEANS, AND WHAT IT DOES NOT. Adding a key here means the
  // derivation can MINT it and normalizeSetKey holds it as a fixed point. It
  // does NOT mean the row becomes writable: the checklist-backed gate is a
  // separate and later test, and a key whose product has no checklist rows in
  // the parallel corpus stays not-checklist-backed until real checklists land.
  // That is CF-NO-SYNTHETIC-PARALLELS applied to coverage -- recognizing a
  // product is not the same as claiming to know its parallels, and no product
  // row is hand-written into data/checklist-parallel-names.json here.
  //
  //   key                          est rows   catalog   checklist-backed
  //   topps-finest                  192,725   223,575    197,799  (rule existed)
  //   panini-hoops                  127,431     2,680          0
  //   leaf                          102,007    15,787     11,442
  //   panini-origins                100,501    25,114     23,958
  //   flair                          90,966     8,280      5,475
  //   topps-chrome-sapphire          77,119    48,576     43,120  (sapphire fix)
  //   panini-prestige                61,248    15,187     13,569
  //   panini-zenith                  59,635     6,288      4,862
  //   ultra                          49,763    19,002     14,455  (rule existed)
  //   pacific                        43,744    10,054      9,108
  //   panini-certified               43,446    17,476     17,363
  //   panini-rookies-and-stars       42,375       211          0
  //   panini-diamond-kings           36,019    16,577     16,448
  //   leaf-rookies-and-stars         35,257     1,744      1,508
  //   donruss-studio                 33,321     1,191          0
  //   panini-photogenic              32,681    16,501     16,501
  //   panini-court-kings             27,438    13,996     13,464
  //   panini-recon                   19,028     6,413      6,413
  //   leaf-limited                   18,712     4,926      4,620
  //   topps-chrome-update-sapphire   18,138    19,729     18,901  (sapphire fix)
  //   leaf-certified                 19,063       192          0
  //   leaf-signature-series          15,935     9,394      9,394
  //   leaf-certified-materials       14,717     3,027      2,943
  //   parkhurst                      19,105     6,897      6,887
  //   post-cereal                    19,895       491          0
  //   goudey                         19,818       229          0
  //   t206                           19,092        26          0
  //
  // ORDER MATTERS, exactly as it does for the Topps and Panini blocks above:
  // longest / most specific name first within a family, and every one of these
  // must precede the bare brand rules below it -- `leaf-certified-materials`
  // before `leaf-certified` before `leaf`, or the shorter name eats the longer.
  //
  // Panini specialized lines. Placed before the bare Panini rules further up
  // is not possible (they run earlier in the function), so each is anchored on
  // its own product word, which no earlier rule claims.
  if (/panini\s+rookies?\s*(?:&|and)\s*stars/i.test(t) || (/rookies?\s*(?:&|and)\s*stars/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Rookies and Stars";
  if (/panini\s+court\s+kings/i.test(t) || (/court\s+kings/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Court Kings";
  if (/panini\s+diamond\s+kings/i.test(t) || (/diamond\s+kings/i.test(t) && noRivalBrand(t, /panini|donruss/i))) return "Panini Diamond Kings";
  if (/panini\s+photogenic/i.test(t) || (/photogenic/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini PhotoGenic";
  if (/panini\s+origins/i.test(t) || (/\borigins\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Origins";
  if (/panini\s+prestige/i.test(t) || (/\bprestige\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Prestige";
  if (/panini\s+certified/i.test(t) || (/\bcertified\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Certified";
  if (/panini\s+zenith/i.test(t) || (/\bzenith\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Zenith";
  if (/panini\s+recon/i.test(t) || (/\brecon\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Recon";
  if (/panini\s+hoops/i.test(t) || (/\bhoops\b/i.test(t) && noRivalBrand(t, /panini/i))) return "Panini Hoops";
  // Leaf specialized lines. `leaf-metal` already had a rule further up; these
  // are the rest, longest first, ahead of the bare `leaf`.
  if (/leaf\s+certified\s+materials/i.test(t)) return "Leaf Certified Materials";
  if (/leaf\s+signature\s+series/i.test(t)) return "Leaf Signature Series";
  if (/leaf\s+rookies?\s*(?:&|and)\s*stars/i.test(t)) return "Leaf Rookies and Stars";
  if (/leaf\s+certified/i.test(t)) return "Leaf Certified";
  if (/leaf\s+limited/i.test(t)) return "Leaf Limited";
  if (/\bleaf\b/i.test(t)) return "Leaf";
  // Fleer family. "Flair" and "Ultra" are their OWN products, not Fleer
  // variants -- CF-ULTRA-IS-NOT-FLEER (Drew, 2026-08-17) already ruled Ultra,
  // and Flair is the same shape. Both must precede the bare /fleer/ rule,
  // which runs earlier in this function, so they are anchored on their own
  // brand word and reached only when no Fleer rule matched.
  if (/\bflair\b/i.test(t) && noRivalBrand(t, /fleer|flair/i)) return "Flair";
  if (/\bultra\b/i.test(t) && !/ultra\s*-?\s*pro|ultra\s+rare|ultraman/i.test(t) && noRivalBrand(t, /fleer|ultra/i)) return "Ultra";
  // Donruss Studio -- the product is "Studio"; `donruss-studio` is our
  // spelling of it (the regex vocabulary already maps both).
  if (/donruss\s+studio/i.test(t) || (/\bstudio\b/i.test(t) && noRivalBrand(t, /donruss|leaf/i))) return "Donruss Studio";
  // Vintage manufacturers and issues. None of these had any rule, so every
  // one of their sales fell through to "Unknown".
  if (/\bt206\b/i.test(t) && noRivalBrand(t)) return "T206";
  if (/\bgoudey\b/i.test(t) && noRivalBrand(t, /upper\s*deck/i)) return "Goudey";
  if (/\bparkhurst\b/i.test(t) && noRivalBrand(t, /upper\s*deck/i)) return "Parkhurst";
  if (/post\s+cereal/i.test(t) && noRivalBrand(t)) return "Post Cereal";
  if (/\bpacific\b/i.test(t) && !/pacific\s+(?:coast|ocean|northwest)/i.test(t) && noRivalBrand(t, /pacific/i)) return "Pacific";

  if (/\bo-?pee-?chee\b/.test(t)) return "O-Pee-Chee";
  if (/\bcollector'?s\s+choice\b/.test(t)) return "Collectors Choice";
  if (/\bsp\s+authentic\b/.test(t)) return "SP Authentic";
  if (/\bsp\s+game\s+used\b/.test(t)) return "SP Game Used";
  if (/\bspx\b/.test(t)) return "SPx";
  if (/\bupper\s+deck\b/.test(t)) return "Upper Deck";
  if (/\bskybox\b/.test(t)) return "Skybox";
  if (/\bpinnacle\b/.test(t)) return "Pinnacle";
  if (/\bstadium\s+club\b/.test(t)) return "Topps Stadium Club";
  if (/\bscore\b/.test(t)) return "Score";

  // Only default to Bowman when the title actually says something Bowman-ish.
  // It used to be enough to contain "baseball" or "rookie", which is how every
  // unrecognised brand became a Bowman card.
  if (/\b(1st\s+bowman|bowman)\b/.test(t)) {
    return "Bowman";
  }
  return "Unknown";
}

/** Infer sport from a title. Falls back to a caller-supplied default. */
/**
 * @deprecated Use `resolveVertical()` from resolveVertical.service.ts.
 *
 * CF-VERTICAL-NOT-SPORT (Drew, 2026-08-13: "so maybe calling it sport is
 * wrong?"). Two problems, both caused by the name:
 *
 *   1. It resolves a VERTICAL, not a sport. Pokemon, Yu-Gi-Oh and One Piece are
 *      not sports, and modelling them as one is why they had nowhere to go.
 *   2. `fallback = "baseball"` means an unidentifiable card silently BECOMES a
 *      baseball card, and the return type cannot express the difference between
 *      "this is baseball" and "I could not tell". That produced slugs like
 *      hiq:baseball:2003:ex-sandstorm:87100 which can never match anything, and
 *      left card_catalog 93.6% sport=baseball.
 *
 * Kept as-is because 800 references read this field; resolveVertical() wraps it
 * and reports confidence. Do not add new callers.
 */
export function inferSportFromTitle(title: string, fallback = "baseball"): string {
  const t = String(title ?? "").toLowerCase();
  // CF-SOCCER-NEVER-DETECTED (Drew, 2026-08-15). There was no soccer
  // branch at all, so every soccer card fell through to the `baseball`
  // fallback and landed in the pool that feeds baseball FMV and
  // calibration. Measured in sold_comps: 14,826 baseball-slugged rows
  // whose title says "WORLD CUP", 13,678 "FIFA", 8,293 "UEFA", 3,139
  // "PREMIER LEAGUE", 2,486 "UCC" — against only 7,034 rows correctly
  // tagged sport='soccer'. The mislabelled population is several times
  // the correctly-labelled one.
  //
  // Placed ABOVE the football check on purpose. Outside the US "football"
  // MEANS soccer, so "2024 Topps Merlin Football UEFA" would otherwise
  // match /football/ and return NFL. A named competition is a far
  // stronger signal than the bare word, so competitions win.
  //
  // Competition and league names only — no bare club names here. "Arsenal",
  // "City", "United", "Inter" and "Milan" are ordinary words or personal
  // names, and CF-SPORT-TEAM-OVERMATCH is the standing lesson about what
  // happens when an ordinary word is treated as a team.
  if (/\b(soccer|f[uú]tbol|fifa|uefa|champions\s+league|europa\s+league|premier\s+league|la\s+liga|serie\s+a|bundesliga|ligue\s+1|eredivisie|copa\s+(?:america|libertadores|del\s+rey)|world\s+cup|\bucl\b|\bucc\b|\bmls\b|euro\s+20\d\d|concacaf|conmebol)\b/.test(t)) {
    return "soccer";
  }
  // CF-WWE-UFC-NEVER-DETECTED (Drew, 2026-08-15: "This is marvel wwe cards").
  // Neither wrestling nor MMA had any detection, so both fell through to the
  // `baseball` fallback and polluted the pool that feeds baseball FMV and
  // calibration — the same failure soccer had.
  //
  // Measured in sold_comps: of 7,071 titles containing "WWE", 6,134 (87%)
  // were tagged baseball; of 5,573 containing "UFC", 4,715 (85%) were. The
  // backlog holds another 22,602 pending WWE rows.
  //
  // "wrestling" and "mma" are already in CANONICAL_SPORTS in slugGuard, and
  // ufc->mma is already an alias there, so nothing downstream needs teaching.
  //
  // NOTE the deliberate absence of "raw": it is the ungraded marker ending
  // thousands of titles in every sport ("... #CPA-BG - Raw"), and matching it
  // would drag the entire pool into wrestling. WWE's brand is "NXT"; "RAW" is
  // unusable as a signal here.
  if (/\b(wwe|wwf|aew|njpw|wrestlemania|smackdown|royal\s+rumble|nxt|wrestling)\b/.test(t)) {
    return "wrestling";
  }
  if (/\b(ufc|mma|bellator|octagon)\b/.test(t)) return "mma";
  if (/\bboxing\b/.test(t)) return "boxing";
  if (/football|nfl\b/.test(t)) return "football";
  if (/basketball|nba\b/.test(t)) return "basketball";
  if (/hockey|nhl\b/.test(t)) return "hockey";
  // CF-BASEBALL-KEYWORD-MISSING (Drew, 2026-08-14). There was no
  // baseball keyword check at all — baseball was reachable ONLY via the
  // `fallback` parameter. So a title that says "Baseball" in plain text
  // fell through every explicit check and landed on the team-name
  // heuristics below, where the NHL alternation contains "stars"
  // (Dallas Stars):
  //
  //   "1978 Kellogg's 3-D Super Stars Baseball #8"  -> "hockey"
  //   "2025 Topps Stars of MLB #SMLB10 Ohtani"      -> "hockey"
  //
  // "Stars" is everywhere in baseball product names (Super Stars, Stars
  // of MLB, All-Stars), so this quietly mis-sported a large slice of the
  // pool — sport='hockey' in sold_comps was dominated by baseball rows.
  // Placed AFTER the other three so an explicitly multi-sport title
  // keeps its existing precedence, and BEFORE the team-name fallbacks so
  // a stated sport always beats a guessed one. "basketball" does not
  // contain "baseball", so there is no overlap with the check above.
  if (/baseball|mlb\b/.test(t)) return "baseball";
  // CF-BASKETBALL-BY-PRODUCT (Drew, 2026-07-29). Some famous basketball
  // products don't carry "basketball"/"nba" in the title but their
  // product line is basketball-exclusive:
  //   - 1986 Fleer Stickers (basketball only — that's the debut product)
  //   - Any Fleer Sticker across years is basketball-first
  // OBSERVED: "MICHAEL JORDAN 1986 FLEER STICKER #8 ROOKIE PSA MINT 9"
  // — no basketball keyword, defaulted to baseball. Fleer Sticker is
  // a strong basketball signal by product convention.
  if (/fleer\s+sticker/i.test(t)) return "basketball";

  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). TCG/non-sport detection
  // used to sit BELOW the team-name heuristics. A title literally
  // reading "2025 Pokemon Mega Evolution Phantasmal Flames" therefore
  // reached the NHL alternation, matched "flames" (Calgary), and was
  // stamped sport=hockey — 3,436 Pokemon rows in a single month's slug
  // sweep. The check was never missing; it was merely unreachable.
  // A named product line is a STATED vertical, not a guessed one, so it
  // belongs with the other keyword checks above the team fallbacks.
  const nonSport = inferNonSportVertical(t);
  if (nonSport) return nonSport;

  // CF-PLAYER-SPORT-HINTS (Drew, 2026-07-29). Some Herbert / Mahomes /
  // Wembanyama-style titles carry ONLY the player name — no team, no
  // league, no product-line hint. Player→sport is the last-resort
  // disambiguator. Curated: unambiguous FULL-NAME matches only
  // (single-token last names like "Herbert" collide across sports;
  // "Justin Herbert" doesn't). Two-sport players (Bo Jackson, Deion
  // Sanders) are DELIBERATELY EXCLUDED — no correct default there.
  //
  // OBSERVED: Justin Herbert 2020 Panini Prizm / Mosaic rows landed at
  // sport=baseball because the title carries neither team nor "NFL";
  // full-name "Justin Herbert" is the only signal.
  //
  // CF-SPORT-TEAM-OVERMATCH moved this ABOVE the team checks. An
  // unambiguous full name is strictly more specific than a bare team
  // word, and the table already excludes two-sport players. "Shohei
  // Ohtani 2025 Bowman Chrome - HS4 Sho-Time Showcase Hobby Stars"
  // resolves on "shohei ohtani" instead of colliding with "Stars".
  const playerSport = inferSportFromPlayer(t);
  if (playerSport) return playerSport;

  // CF-TEAM-NAME-SPORT-HINTS (Drew, 2026-07-29). When the title carries
  // no explicit sport keyword, look for UNAMBIGUOUS team names as a
  // fallback signal. NFL/NBA/NHL each have some names that also exist
  // in another league (Panthers/Kings/Jets); those are excluded to
  // avoid false positives.
  //
  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). The single alternation
  // per league was too blunt: it mixed distinctive franchise nouns
  // ("Blackhawks", "Canadiens") with ordinary English words that are
  // ALSO team names ("Stars", "Flames", "Wild", "Blues", "Heat",
  // "Magic", "Bills"). Card titles are dense with product, insert and
  // parallel names, so the plain words collided constantly and a
  // GUESSED team outranked the product name sitting in the same title:
  //
  //   "...Sho-Time Showcase Hobby Stars #SLAD"     -> Dallas Stars
  //   "2025 Pokemon ... Phantasmal Flames #102"    -> Calgary Flames
  //   "...Scarlet & Violet Wild Force #53"         -> Minnesota Wild
  //   "2024-25 Hoops #1 Lillard Frequent Flyers"   -> Philadelphia Flyers
  //   "1940 Play Ball #22 Sammy West - Senators"   -> Ottawa Senators
  //                                                  (it's the MLB Senators)
  //   "1990 Pro Set #352 Bruce Matthews PB Oilers" -> Edmonton Oilers
  //                                                  (it's the NFL Oilers)
  //
  // So the tokens are split into two tiers. STRONG names are
  // distinctive enough to stand alone. WEAK names are ordinary words
  // and only count when the franchise's CITY sits next to them. That
  // discriminator was not invented — of the 4,589 damaged rows, every
  // genuinely-hockey one carried its city ("San Jose Sharks", "Anaheim
  // Ducks", "Carolina Hurricanes", "Boston Bruins", "Toronto Maple
  // Leafs") while none of the product-name collisions did.
  //
  // Team names are now a TRUE last resort: stated sport, named product
  // line and full player name all outrank them. Consistent with
  // slugGuard's doctrine that refusing beats defaulting, an unqualified
  // weak word yields NOTHING rather than a guess.
  if (NFL_TEAMS_STRONG.test(t) || NFL_TEAMS_CITY_QUALIFIED.test(t)) return "football";
  if (NBA_TEAMS_STRONG.test(t) || NBA_TEAMS_CITY_QUALIFIED.test(t)) return "basketball";
  // "Bolts" overlaps NFL Chargers and NHL Lightning. If the football
  // check above already fired, we won't reach here.
  if (NHL_TEAMS_STRONG.test(t) || NHL_TEAMS_CITY_QUALIFIED.test(t)) return "hockey";

  // CF-SOCCER-NEVER-DETECTED, last resort. Some soccer titles name only a
  // club or a player — "Julian Alvarez ... Atletico Madrid" carries no
  // competition word. Runs AFTER the US-league team checks so a shared
  // city never steals a card from them, and every entry is a full club
  // name or an unambiguous player. Bare "Arsenal", "City", "United",
  // "Inter" and "Milan" are deliberately absent: they are ordinary words
  // or personal names, which is exactly what made "Stars" and "Flames"
  // mis-sport 4,589 rows.
  if (SOCCER_CLUBS_AND_PLAYERS.test(t)) return "soccer";

  return fallback;
}

/** Full club names and unambiguous players — never bare one-word clubs. */
const SOCCER_CLUBS_AND_PLAYERS =
  /\b(real\s+madrid|barcelona|fc\s+barcelona|manchester\s+(?:united|city)|man\s+(?:utd|city)|liverpool\s+fc|chelsea\s+fc|arsenal\s+fc|tottenham|bayern\s+munich|borussia\s+dortmund|paris\s+saint-?germain|\bpsg\b|juventus|ac\s+milan|inter\s+milan|atl[eé]tico\s+madrid|napoli|ajax\s+amsterdam|benfica|boca\s+juniors|river\s+plate|flamengo|lionel\s+messi|cristiano\s+ronaldo|kylian\s+mbapp[eé]|erling\s+haaland|neymar|vin[ií]cius\s+j[uú]nior|jude\s+bellingham|lamine\s+yamal|mohamed\s+salah|kevin\s+de\s+bruyne|robert\s+lewandowski|luka\s+modri[cć]|antoine\s+griezmann|julian\s+[aá]lvarez)\b/i;

/**
 * CF-TCA-NON-SPORT-DETECT (Drew, 2026-08-02). TCA firehose pushes TCG +
 * non-sport (Pokemon, MTG, Star Wars, etc.) alongside sports. Rather
 * than default to "baseball" (which pollutes FMV/calibration pools),
 * tag these with their real category so downstream filters on sport IN
 * (baseball/basketball/football/hockey/soccer) exclude them naturally.
 * Rows stay queryable for later dedicated categorization.
 *
 * Extracted from inferSportFromTitle by CF-SPORT-TEAM-OVERMATCH so the
 * check can run above the team-name fallbacks. Returns null when the
 * title names no known non-sport product line.
 */
export function inferNonSportVertical(title: string): string | null {
  const t = String(title ?? "").toLowerCase();
  if (/\b(pokemon|pok[eé]?mon)\b/i.test(t)) return "pokemon";
  if (/\b(yugioh|yu-?gi-?oh)\b/i.test(t)) return "yugioh";
  if (/\b(magic\s+the\s+gathering|\bmtg\b|hearthstone|lorcana|flesh\s+and\s+blood)\b/i.test(t)) return "tcg-other";
  if (/\b(dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|hunter\s*x\s*hunter|jujutsu\s+kaisen|attack\s+on\s+titan|naruto|my\s+hero\s+academia|demon\s+slayer)\b/i.test(t)) return "anime-tcg";
  // CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). "halo" and "wow" were
  // dropped from this alternation. Both are ordinary card-title words,
  // not product signals, and promoting this check above the team
  // fallbacks would have made them fire far more often. Measured over
  // 2026-07: all 13 "halo" hits are foil/parallel treatments ("Halo
  // Foil", "Star Power Halo Photo", "Light Blue Halo /49") and all 61
  // "wow" hits are seller hype on real sports cards ("RARE ICONIC
  // PARALLEL WOW", "PSA 10 gem mint WOW !!"). Neither had a single
  // genuine Halo / World of Warcraft row. The spelled-out "world of
  // warcraft" still matches, which is what actually identifies those.
  // "marvel" is KEPT: its 948 hits are Donruss "Diamond Marvels", and
  // the trailing \b means the plural never matches.
  if (/\b(star\s+wars|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|dungeons|d\s*&\s*d|d&d|world\s+of\s+warcraft)\b/i.test(t)) return "non-sport";
  return null;
}

/**
 * CF-SPORT-TEAM-OVERMATCH (Drew, 2026-08-15). Build a pattern that
 * matches a weak team word ONLY when its franchise city sits directly
 * in front of it — "calgary flames" counts, a bare "Flames" does not.
 */
function cityQualifiedTeams(pairs: Array<[city: string, team: string]>): RegExp {
  return new RegExp(
    pairs.map(([city, team]) => `\\b(?:${city})\\s+(?:${team})\\b`).join("|"),
    "i",
  );
}

// NFL — dropping names shared with another league: Cardinals[MLB],
// Rangers[NHL], Panthers[NHL], Jets[NHL], Giants[MLB].
const NFL_TEAMS_STRONG =
  /\b(chargers|bolts|steelers|packers|ravens|49ers|niners|seahawks|buccaneers|redskins|bengals|broncos)\b/i;
const NFL_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["dallas", "cowboys"],
  ["philadelphia|philly", "eagles"],
  ["chicago", "bears"],
  ["detroit", "lions"],
  ["los\\s+angeles|la|st\\.?\\s+louis", "rams"],
  ["kansas\\s+city|kc", "chiefs"],
  ["buffalo", "bills"],
  ["new\\s+england", "patriots|pats"],
  ["las\\s+vegas|oakland|los\\s+angeles|la", "raiders"],
  ["minnesota", "vikings"],
  ["atlanta", "falcons"],
  ["tampa\\s+bay|tampa", "bucs"],
  ["new\\s+orleans|nola", "saints"],
  ["tennessee|houston", "titans"],
  ["indianapolis|indy|baltimore", "colts"],
  ["houston", "texans"],
  ["jacksonville", "jaguars|jags"],
  ["miami", "dolphins"],
  ["washington", "commanders"],
]);

// NBA — dropping Kings[NHL].
const NBA_TEAMS_STRONG =
  /\b(lakers|celtics|warriors|knicks|nuggets|mavericks|mavs|pelicans|pels|grizzlies|timberwolves|clippers|cavaliers|cavs|76ers|sixers|raptors|trail\s+blazers|okc)\b/i;
const NBA_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["miami", "heat"],
  ["orlando", "magic"],
  ["oklahoma\\s+city|okc", "thunder"],
  ["washington", "wizards"],
  ["houston", "rockets"],
  ["brooklyn|new\\s+jersey", "nets"],
  ["milwaukee", "bucks"],
  ["phoenix", "suns"],
  ["utah", "jazz"],
  ["minnesota", "wolves"],
  ["san\\s+antonio", "spurs"],
  ["charlotte|new\\s+orleans", "hornets"],
  ["detroit", "pistons"],
  ["indiana", "pacers"],
  ["portland", "blazers"],
  ["atlanta", "hawks"],
  ["golden\\s+state", "dubs"],
]);

// NHL — dropping names shared with another league: Kings[NBA],
// Jets[NFL], Panthers[NFL], Rangers[MLB].
const NHL_TEAMS_STRONG =
  /\b(bruins|islanders|blackhawks|blue\s+jackets|red\s+wings|canadiens|habs|maple\s+leafs|canucks|kraken|golden\s+knights|coyotes|sabres|penguins|capitals)\b/i;
const NHL_TEAMS_CITY_QUALIFIED = cityQualifiedTeams([
  ["calgary", "flames"],
  ["dallas|minnesota\\s+north|north", "stars"],
  ["minnesota", "wild"],
  ["tampa\\s+bay|tampa", "lightning"],
  ["philadelphia|philly", "flyers"],
  ["ottawa", "senators|sens"],
  ["edmonton", "oilers"],
  ["san\\s+jose", "sharks"],
  ["anaheim|mighty", "ducks"],
  ["carolina", "hurricanes|canes"],
  ["st\\.?\\s+louis|saint\\s+louis", "blues"],
  ["colorado", "avalanche|avs"],
  ["nashville", "predators|preds"],
  ["new\\s+jersey|jersey", "devils"],
  ["washington", "caps"],
  ["toronto", "leafs"],
  ["pittsburgh", "pens"],
  ["new\\s+york|ny", "isles"],
  ["chicago", "hawks"],
]);

// CF-PLAYER-SPORT-HINTS (Drew, 2026-07-29). Full-name → sport table,
// grouped by sport for maintainability. Only include names that are
// UNAMBIGUOUS across sports at the full-name level. New additions
// should be sanity-checked against Wikipedia's disambiguation page.
const PLAYER_SPORT_HINTS: Array<{ sport: string; pattern: RegExp }> = [
  {
    sport: "football",
    // TWO-SPORT PLAYERS EXCLUDED (no correct default):
    //   deion sanders — NFL + MLB (Yankees/Braves/Reds/Giants)
    //   bo jackson    — NFL + MLB (Royals/White Sox/Angels)
    //   drew henson   — NFL + MLB (Yankees minor leagues)
    //   jim thorpe    — NFL + MLB (Braves/Reds)
    //   tom brady     — NFL + MLB draft (Expos '95); Bowman Draft has
    //                    Brady baseball cards in the Expos era. 4 rows
    //                    surfaced in dry-run 2.
    pattern: /\b(?:justin\s+herbert|patrick\s+mahomes|joe\s+burrow|josh\s+allen|lamar\s+jackson|jalen\s+hurts|dak\s+prescott|kyler\s+murray|trevor\s+lawrence|tua\s+tagovailoa|justin\s+fields|c\.?j\.?\s+stroud|caleb\s+williams|jayden\s+daniels|drake\s+maye|bo\s+nix|michael\s+penix|anthony\s+richardson|brock\s+purdy|jordan\s+love|aaron\s+rodgers|peyton\s+manning|eli\s+manning|drew\s+brees|ben\s+roethlisberger|philip\s+rivers|russell\s+wilson|joe\s+montana|dan\s+marino|brett\s+favre|john\s+elway|steve\s+young|troy\s+aikman|kurt\s+warner|ja[’']?marr\s+chase|justin\s+jefferson|ceedee\s+lamb|tyreek\s+hill|puka\s+nacua|rome\s+odunze|marvin\s+harrison(?:\s+jr)?|malik\s+nabers|xavier\s+worthy|garrett\s+wilson|chris\s+olave|drake\s+london|deebo\s+samuel|amon-?ra\s+st\.?\s+brown|devonta\s+smith|jaylen\s+waddle|davante\s+adams|stefon\s+diggs|cooper\s+kupp|deandre\s+hopkins|jerry\s+rice|randy\s+moss|calvin\s+johnson|travis\s+kelce|sam\s+laporta|george\s+kittle|brock\s+bowers|dallas\s+goedert|mark\s+andrews|t\.?j\.?\s+hockenson|christian\s+mccaffrey|saquon\s+barkley|bijan\s+robinson|jonathan\s+taylor|derrick\s+henry|nick\s+chubb|kenneth\s+walker|breece\s+hall|jahmyr\s+gibbs|de[’']?von\s+achane|jonathan\s+brooks|kaleb\s+johnson|omarion\s+hampton|ashton\s+jeanty|barry\s+sanders|walter\s+payton|emmitt\s+smith|jim\s+brown|adrian\s+peterson|ladainian\s+tomlinson|micah\s+parsons|nick\s+bosa|myles\s+garrett|t\.?j\.?\s+watt|aidan\s+hutchinson|maxx\s+crosby|khalil\s+mack|von\s+miller|lawrence\s+taylor|reggie\s+white|bruce\s+smith|sauce\s+gardner|patrick\s+surtain|jalen\s+ramsey|charles\s+woodson|ed\s+reed|troy\s+polamalu|ray\s+lewis|brian\s+urlacher|dick\s+butkus|derrick\s+brooks|ladd\s+mcconkey)\b/i,
  },
  {
    sport: "basketball",
    // TWO-SPORT / AMBIGUOUS EXCLUDED:
    //   bill russell   — NBA Celtics dominant, but MLB Bill Russell
    //                    (Dodgers 70s) exists; some era-baseball cards
    //                    would flip incorrectly.
    //   michael jordan — NBA dominant, but 1994-95 Upper Deck Minor
    //                    League Birmingham Barons cards exist; those
    //                    are actually baseball-category rows. Skip.
    pattern: /\b(?:lebron\s+james|steph(?:en)?\s+curry|kevin\s+durant|giannis\s+antetokounmpo|nikola\s+jokic|luka\s+doncic|jayson\s+tatum|jaylen\s+brown|devin\s+booker|anthony\s+edwards|ja\s+morant|trae\s+young|zion\s+williamson|victor\s+wembanyama|wemby|chet\s+holmgren|paolo\s+banchero|scoot\s+henderson|cade\s+cunningham|jalen\s+brunson|karl-?anthony\s+towns|shai\s+gilgeous-?alexander|de[’']?aaron\s+fox|alperen\s+sengun|bam\s+adebayo|domantas\s+sabonis|tyrese\s+haliburton|tyrese\s+maxey|anthony\s+davis|joel\s+embiid|jimmy\s+butler|kawhi\s+leonard|paul\s+george|damian\s+lillard|james\s+harden|russell\s+westbrook|chris\s+paul|dwyane\s+wade|klay\s+thompson|draymond\s+green|kyrie\s+irving|zach\s+lavine|donovan\s+mitchell|jamal\s+murray|michael\s+porter|amen\s+thompson|ausar\s+thompson|jabari\s+smith|jaden\s+ivey|dyson\s+daniels|bennedict\s+mathurin|jeremy\s+sochan|walker\s+kessler|jalen\s+williams|jalen\s+duren|franz\s+wagner|reed\s+sheppard|alex\s+sarr|zaccharie\s+risacher|donovan\s+clingan|matas\s+buzelis|stephon\s+castle|zach\s+edey|dalton\s+knecht|rob\s+dillingham|nikola\s+topic|ron\s+holland|cody\s+williams|isaiah\s+collier|carlton\s+carrington|jared\s+mccain|kobe\s+bryant|magic\s+johnson|larry\s+bird|kareem\s+abdul-?jabbar|wilt\s+chamberlain|shaquille\s+o[’']?neal|hakeem\s+olajuwon|tim\s+duncan|dirk\s+nowitzki|allen\s+iverson|charles\s+barkley|karl\s+malone|john\s+stockton|scottie\s+pippen|isiah\s+thomas|david\s+robinson|patrick\s+ewing|reggie\s+miller|julius\s+erving|oscar\s+robertson|elgin\s+baylor|jerry\s+west|rui\s+hachimura)\b/i,
  },
  {
    sport: "hockey",
    pattern: /\b(?:connor\s+mcdavid|auston\s+matthews|sidney\s+crosby|alex(?:ander)?\s+ovechkin|leon\s+draisaitl|nathan\s+mackinnon|cale\s+makar|jack\s+hughes|quinn\s+hughes|luke\s+hughes|connor\s+bedard|matvei\s+michkov|macklin\s+celebrini|kirill\s+kaprizov|igor\s+shesterkin|andrei\s+vasilevskiy|nikita\s+kucherov|artemi\s+panarin|david\s+pastrnak|mikko\s+rantanen|elias\s+pettersson|aleksander\s+barkov|sebastian\s+aho|mitch\s+marner|william\s+nylander|brady\s+tkachuk|matthew\s+tkachuk|trevor\s+zegras|juraj\s+slafkovsky|owen\s+power|adam\s+fantilli|jesper\s+bratt|wayne\s+gretzky|mario\s+lemieux|bobby\s+orr|gordie\s+howe|mark\s+messier|patrick\s+roy|steve\s+yzerman|jaromir\s+jagr|joe\s+sakic|nicklas\s+lidstrom|martin\s+brodeur|dominik\s+hasek|teemu\s+selanne|jarome\s+iginla|pavel\s+bure|brett\s+hull|paul\s+kariya)\b/i,
  },
  {
    sport: "baseball",
    pattern: /\b(?:aaron\s+judge|shohei\s+ohtani|mike\s+trout|bryce\s+harper|mookie\s+betts|freddie\s+freeman|ronald\s+acuna|juan\s+soto|fernando\s+tatis|julio\s+rodriguez|adley\s+rutschman|corbin\s+carroll|elly\s+de\s+la\s+cruz|jackson\s+chourio|wyatt\s+langford|jackson\s+merrill|jackson\s+holliday|paul\s+skenes|roman\s+anthony|ethan\s+salas|sebastian\s+walcott|kevin\s+mcgonigle|bryce\s+eldridge|josue\s+de\s+paula|konnor\s+griffin|termarr\s+johnson|druw\s+jones|jasson\s+dominguez|anthony\s+volpe|jose\s+altuve|clayton\s+kershaw|justin\s+verlander|max\s+scherzer|derek\s+jeter|albert\s+pujols|miguel\s+cabrera|ken\s+griffey|barry\s+bonds|hank\s+aaron|willie\s+mays|babe\s+ruth|mickey\s+mantle|ted\s+williams|jackie\s+robinson|nolan\s+ryan|cal\s+ripken|greg\s+maddux|randy\s+johnson|pedro\s+martinez|chipper\s+jones|frank\s+thomas|eric\s+hartman|ethan\s+conrad|owen\s+carey|gage\s+wood)\b/i,
  },
];

export function inferSportFromPlayer(title: string): string | null {
  const t = String(title ?? "").toLowerCase();
  for (const { sport, pattern } of PLAYER_SPORT_HINTS) {
    if (pattern.test(t)) return sport;
  }
  return null;
}
