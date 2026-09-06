// ---------------------------------------------------------------------------
// statedFinishFromChecklist.ts
//
// CF-A-TITLE-THAT-NAMES-A-FINISH-IS-NOT-A-BASE-CARD (I9 triage, 2026-09-06).
//
// The I9 SHADOW-REDERIVATION triage (run 34029662735) classified 1,764 sampled
// sold_comps rows and found `dropped:parallel` on 96 of them outright, and on
// another 94 in combination with a second axis -- 190 of 887 TRUE-DISAGREEMENT
// rows, the third largest axis in the artifact. The shape is always the same:
// the row STORES a real parallel, the TITLE states it in words, and
// `parseListingIdentity` answers "Base".
//
// Measured on 400 live sold_comps rows whose title carries `foil`, `holo` or
// `parallel` (read-only draw, 2026-09-06): 260 of 386 rows with a non-Base
// stored parallel re-derived as Base. Grouped by what the row actually is:
//
//     87  Holographic          "2025 Topps Heritage Baseball #76R-15 Holographic"
//     49  Rainbow Foil         "2023 Topps Baseball #648 Rainbow Foil"
//     14  Black Foil           "2024 Topps Stadium Club Baseball #1 Black Foil"
//     10  Aqua Rainbow Foil    "2026 Topps Baseball #1 Aqua Rainbow Foil"
//     10  Diamante Foilboard   "2025 Topps Baseball #400 Diamante Foilboard"
//     10  Crackle Foil         "2026 Topps Baseball #T91-74 Crackle Foil"
//      6  Purple Holo Foil     "2025 Topps Update Baseball #US283 Purple Holo Foil"
//      4  Holofoil             "2003 Donruss Champions Baseball #WSC-12 Holofoil"
//      1  Canvas Parallel      "2025 Topps Update Baseball #US178 Canvas Parallel"
//
// NOTHING WAS DAMAGED, AND THAT IS THE PROBLEM. The classifier's base-eviction
// guard (`storedParallelNamesAFinish` + `titleNamesAFinish`, rematch-classify)
// correctly REFUSES to move any of these onto a base slug -- so no sale was
// mis-filed. But a refusal is not a repair. Every one of these rows sits in the
// corpus as a permanent TRUE-DISAGREEMENT: the rematch can never act on it, the
// auditor counts it as a breach forever, and the real defect -- a reader that
// cannot see a finish the title spells out -- is masked by the guard that
// contains it.
//
// WHY THE READER MISSED THEM, RULE BY RULE
//
//   1. THE FOIL RULE'S COLOUR LIST. `extractParallel` matched
//      `(blue|red|green|orange|purple|gold|yellow|aqua|pink|sky blue)\s+foil`
//      -- which omits black, silver, bronze, white, fuchsia, teal and sepia.
//      This is the SAME defect PATTERN_COLOUR was created to fix for the
//      Shimmer/Lava/Wave/Grass families (CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD,
//      2026-09-03), arriving in the one family that pass did not touch. "Black
//      Foil" is on the 2024 Stadium Club checklist 525 times; it read as Base.
//
//   2. ADJACENCY. The rule required the colour and `foil` to be adjacent, so
//      "PINK HOLO FOIL" and "Purple Holo Foil" -- where the FAMILY word sits
//      between them -- fell past it. Both are checklist rows (`purple holo foil`
//      is attested 3,815 times).
//
//   3. WHOLE FAMILIES WITH NO RULE AT ALL. `holo`, `holofoil`, `holographic`,
//      `rainbow foil`, `crackle foil`, `foilboard`, `diamante` and the bare
//      word `parallel` had no rule anywhere in `extractParallel`. `holo` alone
//      is attested 6,120 times in the checklist corpus.
//
// WHY THIS IS NOT A LONGER HAND LIST
//
// Because a hand list is what failed. The audit gate of 2026-09-03 established
// the doctrine for exactly this situation -- CF-THE-VOCABULARY-IS-THE-CHECKLIST
// -- when a closed ~90-word list failed all 32 census shards: 52% of sampled
// BASE-EVICTION lines named a REAL parallel the list omitted. The fix then was
// to derive the vocabulary from `data/checklist-parallel-names.json`, and the
// fix here is to read the SAME corpus: 37,849 checklist-sourced parallel
// spellings over 627 (sport, year, setKey) products, built 2026-09-04.
//
// So this module does not enumerate finishes. It asks the checklist which
// parallels THIS product has, and answers with the checklist's own name when
// the title states one. Every name it can return is by construction a name the
// checklist already carries -- it cannot mint a rung a product does not have,
// which is the failure mode `feedback_no_synthetic_parallels_only_actuals`
// names and the reason the classifier's `checklistBacked` gate exists.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   * IT NEVER OVERRIDES A RULE. `extractParallel` returns first; this runs
//     only where that function was about to answer "Base". A colour rule, a
//     pattern rule and the Red Ink ruling all keep their answers untouched.
//   * IT NEVER GUESSES WITHOUT THE PRODUCT. With no (year, setKey) the corpus
//     cannot say which parallels exist, so the GLOBAL name index is used and
//     is required to match a MULTI-WORD phrase or an unambiguous single-word
//     finish -- see `MIN_GLOBAL_TOKEN_LEN` and the stopword pass. A bare
//     colour with no product context stays Base: "Blue Jays" is a team.
//   * IT NEVER READS A PRODUCT WORD AS A FINISH. `chrome` on `topps-chrome`
//     names the set. The product's own setKey words are suppressed, exactly as
//     `isProductWord` does in the rematch vocabulary.
//   * IT NEVER READS A LOT. A multi-card listing states no single card's
//     finish; the caller's `isMultiCardLot` already refuses those and this
//     module is reached only after that refusal.
//
// DIRECTION OF SAFETY. Unlike the classifier's vocabulary -- which is a
// DISQUALIFYING test where over-breadth is free -- this module WRITES an
// identity, so its errors are not free. It is therefore deliberately narrower
// than that vocabulary: a match must be a whole checklist parallel NAME for
// this product (or a multi-word global phrase), never a loose token. When it
// cannot be sure it returns null, and the caller keeps "Base" -- which is
// where the row already is, and is recoverable.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ParallelCorpus {
  products?: Record<string, { parallels?: { name?: string }[] }>;
}

const lower = (s: string): string => String(s ?? "").toLowerCase();

/**
 * Candidate locations for the corpus, in the order `playerSegmentIsAPerson.ts`
 * and `bowmanParallelsDataset.ts` already use: compiled `dist/services/...` and
 * source `src/services/...` both sit three levels under the package root where
 * `data/` lives, and the cwd-relative forms cover tests and scripts.
 */
const CORPUS_CANDIDATES = (): string[] => [
  join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "data", "checklist-parallel-names.json"),
  join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
];

/**
 * WORDS THAT APPEAR INSIDE PARALLEL NAMES BUT NEVER NAME ONE ALONE.
 *
 * A MIRROR OF `CORPUS_STOPWORDS` in scripts/lib/rematch-finish-vocab.cjs, not a
 * second vocabulary -- `statedFinishMirrorsTheAuditStopwords` in the test file
 * asserts this stays a SUBSET of that list, so the two cannot drift: add a word
 * there first. It is duplicated rather than imported ONLY because that module is
 * a `.cjs` under scripts/ and nothing in src/ depends on scripts/ (the same
 * reasoning `playerSegmentIsAPerson.ts` records for its own mirror).
 *
 * Each entry describes the CARD, the PRODUCT or the SLAB -- never how the card
 * is printed. Admitting one would let an ordinary title state a "finish": every
 * graded listing says "gem mint", every prospect auto says "1st".
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "and", "the", "for", "with", "from",
  "auto", "autos", "autograph", "autographs", "autographed", "signature", "signatures",
  "rookie", "rookies", "prospect", "prospects", "1st", "first", "base",
  "card", "cards", "set", "sets", "series", "insert", "inserts", "edition",
  "hobby", "value", "jumbo", "pack", "packs", "box", "boxes", "case",
  "player", "players", "team", "teams", "league", "national",
  "variation", "variations", "parallel", "parallels", "version", "versions",
  "short", "numbered", "not", "new", "all", "star", "stars",
  "relic", "relics", "patch", "patches", "memorabilia", "jersey",
  "dual", "triple", "quad", "booklet", "booklets", "combo",
  "signed", "letter", "letters", "name", "names", "nameplate",
  "draft", "drafted", "class", "classes", "update", "chase", "futures",
  "topps", "panini", "bowman", "fleer", "donruss", "upper", "deck", "leaf",
  "score", "pinnacle", "skybox", "pacific", "playoff", "sage",
  "chronicles", "contenders", "immaculate", "flawless", "certified",
  "baseball", "basketball", "football", "hockey", "soccer",
  "usa", "world", "american", "america",
  "gem", "mint", "pristine", "psa", "bgs", "sgc", "cgc", "grade", "graded",
]);

/**
 * COLOUR WORDS ARE NEVER SUFFICIENT EVIDENCE ON THEIR OWN.
 *
 * A mirror of `FINISH_COLOR_TOKENS` (rematch-finish-vocab.cjs), used here for
 * the OPPOSITE purpose: that module admits a colour as a finish witness because
 * it is running a disqualifying test where breadth is free. This module WRITES,
 * so a bare colour is refused -- "Red Sox", "Blue Jays" and "Pete Rose" are the
 * false positives that rule exists for. A colour counts only as part of a
 * checklist name that also carries a real finish word ("Black Foil").
 */
const COLOUR_WORDS: ReadonlySet<string> = new Set([
  "gold", "orange", "purple", "blue", "green", "red", "black", "pink", "yellow",
  "teal", "aqua", "bronze", "silver", "platinum", "copper", "sepia", "magenta",
  "cyan", "lime", "indigo", "violet", "rose", "amber", "onyx", "emerald",
  "ruby", "sapphire", "gunmetal", "chartreuse", "fuchsia", "neon", "atomic",
  "white", "hot",
]);

/**
 * A single-word checklist name is admitted from the GLOBAL index only when it
 * is at least this long. Short tokens collide with card text ("ice", "war",
 * "cup"); a long one that is also a whole checklist parallel name is evidence.
 * Multi-word phrases carry their own specificity and are exempt.
 */
const MIN_GLOBAL_TOKEN_LEN = 5;

/**
 * A single-word name must be listed by at least this many distinct products to
 * be admitted GLOBALLY (i.e. with no year/setKey context). One product listing
 * a word is a local coinage; several listing it is hobby vocabulary. Names
 * matched WITH product context skip this entirely -- that product's own
 * checklist is the authority for that product.
 */
const GLOBAL_SINGLE_WORD_PRODUCT_FLOOR = 2;

interface CorpusIndex {
  /** productKey `year|setKey` -> the parallel names that product lists. */
  byProduct: Map<string, string[]>;
  /** Every parallel name in the corpus, lowercased. */
  globalNames: Set<string>;
  /** How many distinct products list this exact (lowercased) name. */
  productsPerName: Map<string, number>;
  /**
   * THE WORDS PARALLEL NAMES ARE BUILT FROM -- the leftover test's vocabulary.
   *
   * Harvested from the corpus rather than listed, and gated by the same
   * frequency floor `playerSegmentIsAPerson.ts` uses for the same hazard: the
   * corpus contains player-named inserts (`Ken Griffey Jr. "The Kid"`), so a
   * naive harvest would put `griffey` into the vocabulary and then refuse every
   * Griffey title as "stating a finish we did not answer". Every real finish
   * word recurs across products; a person's name appears once.
   */
  finishWords: Set<string>;
  /**
   * Every setKey in the corpus, as its word list -- the evidence
   * `productWordsFromTitle` reads when there is no setKey to suppress against.
   */
  setKeyWordSets: string[][];
}

/**
 * A token must be seen in parallel names across at least this many distinct
 * products to count as finish vocabulary. Mirrors `CORPUS_FREQUENCY_FLOOR` in
 * `playerSegmentIsAPerson.ts`, which measured the same corpus for the same
 * contaminants.
 */
const FINISH_WORD_PRODUCT_FLOOR = 2;

let _index: CorpusIndex | null = null;
let _loadFailed = false;

/**
 * A CHECKLIST NAME CARRIES PACK ODDS, AND THE ODDS ARE NOT PART OF THE NAME.
 *
 * Beckett prints the insertion rate inside the parallel name, so the corpus
 * stores rows like
 *
 *   "Black Foil - 1:9 Hobby; 1:8 Compact Hobby; 1:8 Value Blaster;"
 *   "Green Refractor - 1:16 Hobby; 1:17 Compact Hobby; 1:32 Value Blaster;"
 *
 * The card is called "Black Foil". `checklistParallelForFamily` in the rematch
 * vocabulary meets the same noise and works around it by preferring the
 * SHORTEST matching name; this module needs the name itself, because it
 * requires every word of the name to appear in the title -- and no seller
 * writes "1:8 Value Blaster" in a listing, so an unstripped name can never
 * match and the whole product's vocabulary is silently unusable.
 *
 * The odds tail is cut at the first ` - <digit>:` or the first `;`, which is
 * where Beckett's own formatting puts it. A name with no such tail is
 * untouched.
 */
function stripOddsTail(s: string): string {
  return String(s ?? "")
    .replace(/\s[-–—]\s*\d+\s*:.*$/s, "")
    .replace(/;.*$/s, "")
    .trim();
}

/**
 * Normalise for phrase comparison. `stripOdds` is set only for CHECKLIST NAMES:
 * a title may legitimately contain a semicolon or a "1:9", and truncating one
 * there would silently discard the half of the title that names the finish.
 */
function normalise(s: string, stripOdds = false): string {
  return lower(stripOdds ? stripOddsTail(s) : s)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A checklist parallel name, normalised with its pack-odds tail removed. */
function normaliseName(s: string): string {
  return normalise(s, true);
}

function words(s: string): string[] {
  const n = normalise(s);
  return n ? n.split(" ") : [];
}

/**
 * Is this checklist name usable as a finish witness at all?
 *
 * A name qualifies when, after stopwords and colours are removed, something
 * remains -- that remainder is the FINISH. "Black Foil" keeps `foil`; "Rookie
 * Autographs" keeps nothing and is refused; "Gold" keeps nothing and is
 * refused (a bare colour is not evidence -- see COLOUR_WORDS).
 *
 * Names that are pure numbers ("40", "22" -- the 1984 Topps corpus rows are
 * literally print runs) carry no finish and are refused here too.
 */
function nameStatesAFinish(name: string): boolean {
  const ws = words(name);
  if (!ws.length) return false;
  const residue = ws.filter(
    (w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !COLOUR_WORDS.has(w),
  );
  return residue.length > 0;
}

function loadCorpus(): void {
  if (_index || _loadFailed) return;
  const byProduct = new Map<string, string[]>();
  const globalNames = new Set<string>();
  const productsPerName = new Map<string, number>();
  try {
    let text: string | null = null;
    for (const candidate of CORPUS_CANDIDATES()) {
      try { text = readFileSync(candidate, "utf8"); break; } catch { /* try the next */ }
    }
    if (text == null) throw new Error("checklist-parallel-names.json not found");
    const raw = JSON.parse(text) as ParallelCorpus;
    // Pass 1: how many distinct PRODUCTS is each word seen in? The floor below
    // is what separates finish vocabulary from a player-named insert.
    const wordProducts = new Map<string, Set<string>>();
    for (const [key, product] of Object.entries(raw.products ?? {})) {
      for (const parallel of product.parallels ?? []) {
        for (const w of new Set(normaliseName(parallel.name ?? "").split(" ").filter(Boolean))) {
          if (w.length < 3 || /^\d+$/.test(w)) continue;
          let s = wordProducts.get(w);
          if (!s) { s = new Set<string>(); wordProducts.set(w, s); }
          s.add(key);
        }
      }
    }
    const finishWords = new Set<string>();
    for (const [w, prods] of wordProducts) {
      if (prods.size < FINISH_WORD_PRODUCT_FLOOR) continue;
      if (STOPWORDS.has(w)) continue;
      finishWords.add(w);
    }

    // The corpus's setKeys, as word lists. A setKey of one word is skipped:
    // suppressing a single common word globally (`topps`) would silence names
    // on every other product, and the STOPWORDS list already covers the brands.
    const setKeyWordSetsSeen = new Set<string>();
    const setKeyWordSets: string[][] = [];
    for (const key of Object.keys(raw.products ?? {})) {
      const sk = lower(key.split("|")[2] ?? "");
      if (!sk || setKeyWordSetsSeen.has(sk)) continue;
      setKeyWordSetsSeen.add(sk);
      const tokens = sk.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      if (tokens.length >= 2) setKeyWordSets.push(tokens);
    }

    // Pass 2: the per-product and global name indexes.
    for (const [key, product] of Object.entries(raw.products ?? {})) {
      // key is `sport|year|setKey`; the product index is keyed (year, setKey)
      // because the same product is the same product in every sport bucket.
      const parts = key.split("|");
      const productKey = `${parts[1] ?? ""}|${lower(parts[2] ?? "")}`;
      const seenHere = new Set<string>();
      for (const parallel of product.parallels ?? []) {
        const name = normaliseName(parallel.name ?? "");
        if (!name || !nameStatesAFinish(name)) continue;
        let bucket = byProduct.get(productKey);
        if (!bucket) { bucket = []; byProduct.set(productKey, bucket); }
        if (!seenHere.has(name)) {
          seenHere.add(name);
          bucket.push(name);
          productsPerName.set(name, (productsPerName.get(name) ?? 0) + 1);
        }
        globalNames.add(name);
      }
    }
    _index = { byProduct, globalNames, productsPerName, finishWords, setKeyWordSets };
  } catch {
    // The corpus is a build artifact copied into dist/. If it is absent this
    // module answers null for everything and the caller keeps "Base" -- the
    // pre-existing behaviour. Degrade, never throw.
    _loadFailed = true;
    _index = { byProduct: new Map(), globalNames: new Set(), productsPerName: new Map(), finishWords: new Set(), setKeyWordSets: [] };
  }
}

/** Test seam: force a corpus reload. */
export function _resetStatedFinishCorpus(): void {
  _index = null;
  _loadFailed = false;
}

/** The words of this product's own setKey -- on this product they name the SET. */
function productWords(setKey: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of lower(setKey ?? "").split(/[^a-z0-9]+/)) {
    if (w.length >= 3) out.add(w);
  }
  return out;
}

/**
 * The words in THIS TITLE that name a product, read off the corpus's own
 * setKeys rather than a hand list of brands.
 *
 * Used only on the no-context path, where there is no setKey to suppress
 * against. A word counts when the corpus has a setKey built from it AND the
 * title states that setKey's words together -- so "Flair Showcase" in a title
 * marks `showcase` as a product word, while a title that merely says
 * "Showcase" without the rest of a real setKey does not.
 */
function productWordsFromTitle(title: string): Set<string> {
  loadCorpus();
  const out = new Set<string>();
  const index = _index;
  if (!index) return out;
  const tw = new Set(words(title));
  for (const tokens of index.setKeyWordSets) {
    if (tokens.length && tokens.every((w) => tw.has(w))) for (const w of tokens) out.add(w);
  }
  return out;
}

/**
 * Does the title state this checklist name, in full and in order-free fashion?
 *
 * EVERY word of the name must appear in the title. Requiring all of them is
 * what keeps "Gold Rainbow Foil" from matching a title that says only "Rainbow
 * Foil", and keeps a lone shared colour from carrying a match on its own --
 * the same rule `titleEchoesSlugParallel` uses in the classifier.
 */
function titleStatesName(titleWordSet: Set<string>, name: string): boolean {
  const ws = words(name);
  if (!ws.length) return false;
  return ws.every((w) => titleWordSet.has(w));
}

export interface StatedFinishContext {
  /** The card's year, when the caller knows it. */
  year?: number | null;
  /** The card's setKey, when the caller knows it. */
  setKey?: string | null;
}

/**
 * THE STATED FINISH THIS TITLE NAMES, AS THE CHECKLIST SPELLS IT -- or null.
 *
 * Returns a checklist parallel NAME (title-cased for the slug layer, which
 * lowercases it again) when the title states one, and null when it does not.
 * Null means "nothing stated", and the caller keeps "Base".
 *
 * PRECEDENCE. The LONGEST matching checklist name wins, because a longer name
 * is strictly more specific and every word of it was found in the title:
 * "Purple Holo Foil" beats "Holo Foil" beats "Holo" on a title that says all
 * three. This is the opposite of `checklistParallelForFamily`'s shortest-match
 * rule, and deliberately so: that function picks a row to SUGGEST from names
 * carrying pack-odds noise, while this one reports what the title actually
 * SAYS, and every word it reports was witnessed in the title.
 *
 * WITH PRODUCT CONTEXT the product's own checklist is the authority and any of
 * its names may match. WITHOUT IT, only the global index is consulted, and a
 * single-word name must clear both `MIN_GLOBAL_TOKEN_LEN` and
 * `GLOBAL_SINGLE_WORD_PRODUCT_FLOOR` -- so an unqualified title cannot mint a
 * finish off one product's local coinage.
 */
export function statedFinishFromChecklist(
  title: string,
  ctx: StatedFinishContext = {},
): string | null {
  const t = String(title ?? "");
  if (!t.trim()) return null;
  loadCorpus();
  const index = _index;
  if (!index) return null;

  const titleWordSet = new Set(words(t));
  if (!titleWordSet.size) return null;

  // A TITLE THAT SAYS "BASE" HAS ALREADY ANSWERED.
  //
  // CF-NO-REFRACTOR-IS-A-BASE's other half (Drew, 2026-08-25): the chrome-auto
  // Refractor default was removed precisely because it overrode sellers who
  // typed the word "Base", splitting one card across two pools on phrasing
  // alone. This reader must not reintroduce that from the other direction.
  //
  //   "2022 Bowman Chrome Prospects Baseball #CPA-MG Base"  ->  Base Chrome
  //
  // `Base Chrome` is a real corpus name, and the title states both its words --
  // "Base" from the seller and "Chrome" from the PRODUCT. Pinned by
  // parseTitleIdentity.test.ts's "an explicit Base in the title is never
  // overridden", which caught this.
  if (/\bbase\b/i.test(t)) return null;

  const own = productWords(ctx.setKey);
  const year = ctx.year == null ? "" : String(ctx.year);
  const setKey = lower(ctx.setKey ?? "");

  const candidates: string[] = [];
  const productNames = setKey ? index.byProduct.get(`${year}|${setKey}`) : undefined;
  if (productNames && productNames.length) {
    // THIS PRODUCT'S CHECKLIST IS THE AUTHORITY FOR THIS PRODUCT. Any name it
    // lists may match -- including a single short word, because the checklist
    // saying so IS the evidence.
    for (const name of productNames) candidates.push(name);
  } else {
    // NO PRODUCT CONTEXT (or a product the corpus does not carry). Fall back to
    // the global index under the stricter floors.
    //
    // A SINGLE-WORD NAME THAT IS ALSO A PRODUCT WORD IN THIS TITLE IS REFUSED.
    // Without a setKey the product-word suppression above has nothing to read,
    // so the title itself is the only evidence of which product this is:
    //
    //   "1999 Flair Showcase Baseball #120 Row 2"  ->  Showcase
    //
    // `Showcase` IS a parallel name on other products, and with no setKey there
    // was nothing to say that here it names the SET. The card is the "Row 2",
    // which is a subset this module does not read -- so the honest answer is
    // none. A multi-word name is left alone: it carries its own specificity and
    // is not satisfied by a bare brand token.
    const titleProductWords = productWordsFromTitle(t);
    for (const name of index.globalNames) {
      const ws = words(name);
      if (ws.length === 1) {
        if (ws[0].length < MIN_GLOBAL_TOKEN_LEN) continue;
        if ((index.productsPerName.get(name) ?? 0) < GLOBAL_SINGLE_WORD_PRODUCT_FLOOR) continue;
        if (titleProductWords.has(ws[0])) continue;
      }
      candidates.push(name);
    }
  }

  let best: string | null = null;
  for (const name of candidates) {
    if (!titleStatesName(titleWordSet, name)) continue;
    // A PRODUCT WORD IS NOT A FINISH ON ITS OWN PRODUCT. "Chrome" on
    // `topps-heritage-chrome` names the set; on `topps` it is a finish. Only a
    // name made ENTIRELY of this product's own words is refused -- "Chrome
    // Refractor" on topps-chrome still states a finish via `refractor`.
    if (own.size) {
      const ws = words(name);
      if (ws.every((w) => own.has(w))) continue;
    }
    // The longest name that the title fully states is the most specific one.
    if (!best || name.length > best.length) best = name;
  }
  if (!best) return null;

  // CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD, AT THE READER (2026-09-06).
  //
  // A LONGEST-MATCH IS STILL NOT NECESSARILY THE WHOLE ANSWER, and matching a
  // SHORTER checklist name than the title states is not a less specific reading
  // of the same card -- it is a SIBLING card. Measured on the 400-row draw
  // before this guard existed:
  //
  //   "2024 Topps Baseball #427 Aqua Crackle Foil"     -> Aqua Foil
  //   "2025 Topps Archives Baseball #82 Pink Foilboard"-> Pink Foil
  //   "2025 Topps A&G #47 Orange Foil Filagree"        -> Orange Foil
  //
  // Aqua Crackle Foil and Aqua Foil are two rows, two print runs, two price
  // curves; writing the second for the first splits a pool exactly as the
  // Black Wave / Black Refractor collapse did. The corpus lists BOTH names, so
  // longest-match alone cannot tell them apart when only the shorter one is
  // product-scoped.
  //
  // The rule is the one the classifier's GUARD 4 already enforces from the
  // other side (`familyTokensDroppedByDerivation`): AN ANSWER MAY NOT DROP A
  // FINISH WORD THE TITLE STATES. Any leftover finish word means this reading
  // is a sibling, not this card, so the reader refuses and the caller keeps
  // "Base" -- absent beats wrong, and the row stays exactly where it is.
  //
  // Leftovers are measured against the finish vocabulary the corpus itself
  // supplies (`_index.finishWords`), so this stays checklist-derived: a word is
  // a finish word here only because some checklist parallel name is built from
  // it.
  const answered = new Set(words(best));
  for (const w of titleWordSet) {
    if (answered.has(w)) continue;
    if (!index.finishWords.has(w)) continue;
    if (own.has(w)) continue;            // names the SET on this product
    if (COLOUR_WORDS.has(w)) continue;   // a colour is an axis the diff already sees
    return null;
  }

  // A NAME THE TITLE EXTENDS IS A TRUNCATION, NOT AN ANSWER.
  //
  // The leftover test above reads the corpus's FINISH vocabulary, and a word can
  // qualify a finish without being one itself. "Desert Shield" is the card;
  // `shield` is in the vocabulary and `desert` is not, so the guard above saw no
  // leftover finish word and let the reader answer "Shield" -- a name that is
  // not this card and not any card. Measured on the 200-row draw: 1 of 14.
  //
  // So the ANSWER must not be a strict suffix or prefix of a longer phrase the
  // title states. Read directly off the title's word sequence, which needs no
  // vocabulary at all: if the words immediately around the matched phrase extend
  // it into a longer phrase the corpus ALSO lists, the longer one was the card
  // and this reading is a truncation of it. Refuse; the caller keeps "Base".
  const titleSeq = words(t);
  const bestSeq = words(best);
  for (let i = 0; i + bestSeq.length <= titleSeq.length; i++) {
    let hit = true;
    for (let j = 0; j < bestSeq.length; j++) {
      if (titleSeq[i + j] !== bestSeq[j]) { hit = false; break; }
    }
    if (!hit) continue;
    const before = i > 0 ? titleSeq[i - 1] : null;
    const after = i + bestSeq.length < titleSeq.length ? titleSeq[i + bestSeq.length] : null;
    for (const ext of [
      before ? [before, ...bestSeq].join(" ") : null,
      after ? [...bestSeq, after].join(" ") : null,
    ]) {
      if (ext && index.globalNames.has(ext)) return null;
    }
    // A ONE-WORD ANSWER WITH A QUALIFIER IN FRONT OF IT IS A TRUNCATION EVEN
    // WHEN THE CORPUS HAS NEVER HEARD OF THE LONGER PHRASE.
    //
    // The corpus is not the whole hobby -- its Beckett floor is 2020, so every
    // vintage parallel is outside it, and the extension test above can only
    // refuse what the corpus lists. "Desert Shield" is precisely that gap: it is
    // adjudicated vocabulary in rematch-finish-vocab.cjs's HAND_PHRASES and is
    // absent from the corpus, so the reader answered "Shield" -- half of a card
    // name, and a card that does not exist. Measured: 1 of 14 recoveries on the
    // 200-row draw, "1991 Topps Baseball #580 Desert Shield".
    //
    // The shape is detectable without knowing the phrase: a SINGLE-word answer
    // that the title immediately precedes with another content word is
    // ambiguous, because that word may be qualifying it into a different card.
    // Multi-word answers are exempt -- they carry their own specificity, and
    // requiring their neighbourhood to be empty would refuse "Independence Day"
    // in any title with a word before it.
    //
    // A refusal here costs a recovery we could have made; admitting it writes
    // half a name onto a real sale. Absent beats wrong.
    // THE PRODUCT-WORD EXEMPTION DOES NOT APPLY HERE. Elsewhere a word that
    // names this product is ignored because it cannot be a finish; in FRONT of
    // a one-word answer it is the strongest truncation signal there is, because
    // it means the answer is the tail of the PRODUCT'S OWN NAME:
    //
    //   "1999 Flair Showcase Baseball #120 Row 2"  ->  Showcase
    //
    // The slug's setKey is `flair`, so `flair` is a product word and exempting
    // it let the reader answer with the second half of "Flair Showcase" -- the
    // set's name, offered as this card's finish. The card is the "Row 2".
    if (bestSeq.length === 1 && before
        && before.length >= 3
        && !/^\d+$/.test(before)
        && !STOPWORDS.has(before)) {
      return null;
    }
  }

  return best
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The stopword mirror, exposed for `statedFinishIsNotABaseCard.test.ts`'s
 * subset assertion against `CORPUS_STOPWORDS` in the rematch vocabulary. Test
 * seam only -- nothing in the request path reads it.
 */
export const __STOPWORDS_FOR_TEST: string[] = [...STOPWORDS];
