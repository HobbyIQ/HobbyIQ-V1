/**
 * rematch-finish-vocab.cjs -- the finish vocabulary the GREAT REMATCH reads a
 * title against, DERIVED FROM THE CHECKLIST CORPUS rather than hand-listed.
 *
 * CF-THE-VOCABULARY-IS-THE-CHECKLIST (audit gate, 2026-09-03). The audit that
 * failed every one of the 32 shards failed them on ONE mechanism: the closed
 * ~90-word list in rematch-classify.cjs was smaller than the hobby. 52% of the
 * sampled BASE-EVICTION lines (200/385) named a REAL parallel the list omitted
 * -- Tiffany, Desert Shield, Rapture, Press Proof, Members Only, International,
 * Embossed, Mahogany, Retro-Future. Slot 29 was 30/30 wrong (1990 Bowman
 * Tiffany); slot 28 was merging 1991 Topps Desert Shield into base. Every one
 * of those is a genuine parallel, and an eviction moves it INTO a base pool --
 * one card, two rows, a split pool, a wrong FMV.
 *
 * The fix is not a longer hand list. It is the corpus we already have:
 * data/checklist-parallel-names.json, 36,699 checklist-sourced parallel rows
 * over 576 (sport, year, setKey) products, built from the Beckett bulk pull
 * 2026-08-27. That file is the same evidence the checklist-backed gate reads,
 * so the vocabulary and the destination test now agree about what a parallel
 * IS.
 *
 * PER (YEAR, SETKEY), NOT GLOBAL -- WHICH IS THE PRODUCT-WORD FIX
 *
 * The old list's own header named the defect and declined to fix it: several
 * entries are PRODUCT words as well as finish words -- chrome, prizm, mosaic,
 * optic, sapphire, diamond. "2024 Topps Chrome Judge #150" names a SET.
 * Suppressing it globally cost real evictions; admitting it globally would let
 * "Chrome" be read as a parallel on a Topps Chrome card, which is exactly the
 * IMPROVE defect the audit found from the other side ("2024 Topps Heritage
 * Chrome #399 Base" deriving parallel=Chrome).
 *
 * Matching per (year, setKey) settles it with evidence instead of a rule:
 *
 *   isProductWord("chrome", "topps-heritage-chrome")  -> true
 *       the token is IN the product's own setKey, so on this card the word
 *       names the set. It is not a finish here.
 *   isProductWord("chrome", "topps")                  -> false
 *       nothing in `topps` is called chrome, so "Chrome" on a Topps card is
 *       either a finish or a mis-parse -- either way not evictable.
 *
 * and the finish side reads the SAME product's checklist. 1990 Bowman Tiffany
 * is not in the 2020+ corpus at all (Beckett's bulk floor), so it comes from
 * HAND_SPELLINGS -- the small list this module keeps for exactly the spellings
 * the corpus lacks, every entry traceable to a counterexample in the findings.
 *
 * THE HAND LIST IS SMALL AND IS NOT A SECOND VOCABULARY
 *
 * The corpus floor is 2020 (plus one 1984 product). Vintage parallels --
 * Tiffany, Desert Shield, Glossy Send-In, Embossed, Pennant, Premier White,
 * Photographers Proof -- are real, adjudicated, and simply outside Beckett's
 * bulk range. Those get hand spellings. Nothing else does: the tests assert
 * the hand list stays under HAND_LIST_CEILING entries so it cannot grow back
 * into the closed list this module replaced.
 *
 * DIRECTIONAL SAFETY IS UNCHANGED
 *
 * Every test in here is DISQUALIFYING: a true answer takes a row OUT of
 * BASE-EVICTION and leaves it exactly where it sits. A false positive costs an
 * eviction we could have made; a false negative writes a parallel row onto a
 * base slug. So the vocabulary stays deliberately over-broad, and the corpus
 * makes it broader in the direction that was hurting us.
 */
"use strict";

const path = require("path");
const fs = require("fs");

/** Where the checklist parallel corpus lives. Overridable for tests only. */
const CORPUS_PATH = process.env.REMATCH_PARALLEL_CORPUS
  ? String(process.env.REMATCH_PARALLEL_CORPUS)
  : path.join(__dirname, "..", "..", "data", "checklist-parallel-names.json");

const lower = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Words that appear inside parallel names but never NAME a parallel on their
 * own -- they are grammar, not vocabulary. Admitting these would make the
 * vocabulary match every title in the pool and switch the subclass off, which
 * is the one failure mode a disqualifying test can still have.
 *
 * `auto`, `autograph`, `rc`, `rookie`, `1st`, `prospect` and `base` stay here
 * for the reason the old list stated: they describe the CARD, not how it is
 * printed, and every 1st Bowman Auto title carries one.
 */
const CORPUS_STOPWORDS = new Set([
  "and", "the", "for", "with", "from",
  "auto", "autos", "autograph", "autographs", "autographed", "signature", "signatures",
  "rookie", "rookies", "prospect", "prospects", "1st", "first", "base",
  "card", "cards", "set", "sets", "series", "insert", "inserts", "edition",
  "hobby", "value", "jumbo", "pack", "packs", "box", "boxes", "case", "packs)",
  "player", "players", "team", "teams", "league", "national",
  "variation", "variations", "parallel", "parallels", "version", "versions",
  "short", "numbered", "not", "new", "all", "star", "stars",
  "relic", "relics", "patch", "patches", "memorabilia", "jersey",
  "dual", "triple", "quad", "booklet", "booklets", "combo",
  "signed", "letter", "letters", "name", "names", "nameplate",
  // SUBSET words, not finish words. `draft` reaches 29 products purely through
  // "Draft Signatures" and "Draft Class" -- subset names -- while colliding
  // head-on with the Bowman Draft PRODUCT family, where a title saying "Draft"
  // names the set. A subset is not a parallel (CF-SUBSET-STRIP R4a-d), and
  // admitting one here makes every Bowman Draft card un-evictable.
  "draft", "drafted", "class", "classes", "update", "chase", "futures",
  // BRAND AND MANUFACTURER names. These leak into the corpus through long
  // checklist names that quote the whole product ("2023 Panini Chronicles
  // America's Pastime ... Red"), so `topps` clears the 2-product support floor
  // on 13 products -- and then "2024 Topps #131 Aaron Judge PSA 10" reads as
  // naming a finish and no Topps card is ever evictable again. A brand names
  // the manufacturer; the product-word suppression only removes THIS card's
  // own setKey words, so the brand of some OTHER product has to be stopped
  // here.
  // Brands ONLY. Words that are a brand somewhere and a genuine parallel
  // elsewhere -- `onyx` and `obsidian` are colours, `sapphire` a finish, and
  // `select`/`elite`/`spectra` name real parallels -- are deliberately NOT
  // here: silencing them is a FALSE NEGATIVE, which is the direction that
  // writes. A brand that is only ever a brand costs nothing to stop.
  "topps", "panini", "bowman", "fleer", "donruss", "upper", "deck", "leaf",
  "score", "pinnacle", "skybox", "pacific", "playoff", "sage",
  "chronicles", "contenders", "immaculate", "flawless", "certified",
  // SPORT names. These reach the corpus the same way the brands do -- through
  // checklist names that quote a whole product or a sport-themed insert ("USA
  // Baseball", "Football Stars") -- and they clear the support floor
  // comfortably: basketball 22 products, football 17, usa 11, baseball 8,
  // american 5, world 4, hockey 2. A sport names WHICH CHECKLIST the card
  // belongs to, never how the card is printed, so admitting one disqualifies
  // an entire sport from eviction: "2025 Topps Chrome Football Colston
  // Loveland Rookie Auto" is refused on the word `football` alone, and no
  // football card is evictable again.
  "baseball", "basketball", "football", "hockey", "soccer",
  "usa", "world", "american", "america",
  // GRADE words. `gem` clears the floor on 10 products through "Gem Mint"
  // insert and parallel names, and a graded title is the pool's most common
  // shape: "... PSA 10 GEM MINT" is then refused on `gem`. A grade describes
  // the SLAB, not the print -- and the grade already lives on the identity as
  // gradeCompany/gradeValue, where the classifier reads it properly. The
  // grader initialisms (psa/bgs/sgc/cgc) and `mint` do not clear the floor
  // today, but they are stopped for the same reason so a corpus rebuild
  // cannot quietly admit them.
  "gem", "mint", "pristine", "psa", "bgs", "sgc", "cgc", "grade", "graded",
]);

/** A corpus token is worth keeping only if it is a word, not a fragment. */
const MIN_TOKEN_LEN = 3;

/**
 * A corpus token must appear in at least this many DISTINCT products before it
 * counts as vocabulary.
 *
 * Measured on the corpus 2026-09-03, counting AFTER the stopword pass: 2,024
 * distinct tokens appear in at least one product, 1,377 in at least two. The
 * 647 the floor removes are player surnames and typos that leaked in from long
 * checklist names -- "ohtani" (1 product), "mckenzie", "smoltz", "rivera",
 * "fuschia", "ornage". Real finish words clear it comfortably: refractor 80
 * products, gold 485, prizm 32, chrome 4.
 *
 * This is the ONE narrowing in a module whose every other choice is broadening,
 * and it is justified by what the excluded tokens are: a surname as a finish
 * word makes every card of that player permanently un-evictable, which is not
 * caution, it is the vocabulary failing to be a vocabulary. A word that
 * genuinely names a finish on exactly one product is reachable through
 * HAND_SPELLINGS.
 *
 * WHAT THE FLOOR DOES NOT REMOVE -- AND WHY THE STOPWORDS EXIST
 *
 * The floor is a frequency test, not a meaning test, so it removes only what
 * is RARE. A word that is common in the corpus and still never names a
 * parallel sails through it, and the audit found two whole families in that
 * state: BRANDS (topps, 13 products) and -- the same defect, found later --
 * SPORTS (basketball 22, football 17, usa 11, baseball 8) and GRADE words
 * (gem 10). Raising the floor cannot reach them without cutting genuine
 * finishes that are legitimately rare, and the product-word suppression only
 * removes THIS card's own setKey words, so it cannot reach a sport either.
 * They are stopped by name in CORPUS_STOPWORDS instead, on the same rationale
 * as topps and draft: the word names the manufacturer, the checklist or the
 * slab, never how the card is printed.
 */
const MIN_PRODUCT_SUPPORT = 2;

/**
 * The spellings the corpus lacks. EVERY entry traces to a counterexample the
 * 2026-09-03 audit surfaced, or to a product family whose year predates the
 * corpus floor (2020). This list is deliberately tiny and the tests cap it:
 * if it starts growing, the corpus is what needs rebuilding, not this.
 */
const HAND_SPELLINGS = [
  // vintage parallels below the corpus's 2020 floor, each an audit counterexample
  "tiffany",          // slot 29: 30/30 sampled lines were 1990 Bowman Tiffany
  "embossed",         // 1992 Topps Embossed
  "glossy",           // Topps Glossy Send-In / All-Star
  "pennant",          // Pennant Edition
  "premier",          // Premier White
  "photographers",    // Photographers Proof (Leaf/Studio)
  "mahogany",         // corpus has it only inside longer memorabilia names
  "rapture",          // Panini Rapture -- absent from the corpus entirely
  "peel",             // Peel and Reveal
  "reveal",
  "crusade",
  "unparalleled",
  "vector",
  "astral",
  "marvels",
  "unleashed",
  "proof",            // the proof families the corpus carries only in compounds
  "proofs",
  "shield",           // Desert Shield, also matched as a phrase
];

/** The hand list is a patch, never a second vocabulary. Asserted by tests. */
const HAND_LIST_CEILING = 32;

/**
 * Multi-word finish phrases. Matched with flexible separators so a title may
 * spell them with a space, a hyphen or an ampersand.
 */
const HAND_PHRASES = [
  "desert shield", "press proof", "artist proof", "artists proof",
  "photographers proof", "members only", "first day issue", "independence day",
  "vintage stock", "stat line", "premier white", "pennant edition",
  "peel and reveal", "retro future", "cracked ice", "stained glass",
  "ray wave", "tie dye", "mini diamond", "printing plate", "short print",
  "gold rush", "black label", "image variation",
];

/**
 * Colour words that name a parallel on their own across modern products.
 * Kept from the old vocabulary verbatim -- these were never the defect.
 */
const FINISH_COLOR_TOKENS = [
  "gold", "orange", "purple", "blue", "green", "red", "black", "pink", "yellow",
  "teal", "aqua", "bronze", "silver", "platinum", "copper", "sepia", "magenta",
  "cyan", "lime", "indigo", "violet", "rose", "amber", "onyx", "emerald",
  "ruby", "sapphire", "gunmetal", "chartreuse", "fuchsia", "neon", "atomic",
];

/**
 * The finish/format words the corpus proves out but which a stopword pass or a
 * thin product slice could drop. These are the old vocabulary's uncontested
 * core -- they stay because a disqualifying test must never get NARROWER than
 * it was, and the audit's complaint was that it was too narrow.
 */
const CORE_FINISH_TOKENS = [
  "refractor", "refractors", "x-fractor", "xfractor", "fractor", "superfractor",
  "prizm", "prizms", "shimmer", "wave", "holo", "holofoil", "foil", "sparkle",
  "pulsar", "mojo", "atomic", "disco", "lava", "speckle", "canvas",
  "velocity", "hyper", "optic", "mosaic", "sapphire", "laser", "pandora",
  "flash", "aqua", "vapor", "scope", "tiger", "zebra", "snakeskin", "dragon",
  "fireworks", "diamond", "crystal", "prismatic", "reactive", "pearl", "marble",
  "camo", "genesis", "chrome", "ice", "glass", "cosmic", "nebula", "galactic",
  "logofractor", "raywave", "shock", "hyperplaid", "choice", "dazzle",
  "plate", "plates", "die-cut", "diecut", "tiffany", "international",
  "retro", "sterling", "inception", "heritage", "finest", "mini",
];

// ── the corpus, loaded once ────────────────────────────────────────────────

let _corpus = null;

const productKey = (year, setKey) =>
  `${year === null || year === undefined || year === "" ? "" : Number(year)}|${lower(setKey)}`;

/** The tokens a setKey is made of. `topps-heritage-chrome` -> topps, heritage,
 *  chrome -- each of which, ON THAT PRODUCT, names the set and not a finish. */
function setKeyTokens(setKey) {
  return lower(setKey)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w.length >= MIN_TOKEN_LEN);
}

/** Split a checklist parallel NAME into candidate vocabulary tokens. */
function nameTokens(name) {
  return lower(name)
    .split(/[^a-z0-9-]+/)
    .filter(Boolean)
    .flatMap((w) => (w.includes("-") ? [w, ...w.split("-")] : [w]))
    .filter((w) => w.length >= MIN_TOKEN_LEN && !CORPUS_STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Build the vocabulary from the corpus. Returns
 *   { global, byProduct, productWords, phrases, productCount, nameCount }
 *
 * `global` is the union over every product plus the core list, the hand
 * spellings and the colours -- what a title is tested against when we do not
 * know the product (the safe, over-broad direction).
 *
 * `byProduct` is the per-(year, setKey) slice, used to decide whether a token
 * on THIS card is a finish or the set's own name, and to answer
 * checklistListsParallel for the IMPROVE guard.
 */
function buildVocabulary(corpusPath = CORPUS_PATH) {
  const byProduct = new Map();
  const phrases = new Set(HAND_PHRASES.map(lower));
  const support = new Map();   // token -> how many distinct products use it
  let productCount = 0, nameCount = 0;

  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(corpusPath, "utf8")); }
  catch { doc = null; }

  const products = doc?.products ?? {};
  for (const key of Object.keys(products)) {
    const p = products[key];
    const year = p?.year, setKey = lower(p?.setKey);
    if (!setKey) continue;
    productCount++;
    const pk = productKey(year, setKey);
    if (!byProduct.has(pk)) byProduct.set(pk, new Set());
    const bucket = byProduct.get(pk);
    const seenHere = new Set();
    for (const par of p?.parallels ?? []) {
      const spellings = (par?.spellings ?? []).length ? par.spellings : [par?.name];
      for (const sp of spellings) {
        if (!sp) continue;
        nameCount++;
        // A MULTI-WORD PARALLEL NAME IS ALSO A PHRASE. "Black & White Red Ink"
        // matters as a phrase, not only as the words black/white/red/ink --
        // a title carrying the whole phrase is unambiguously naming it.
        const norm = lower(sp).replace(/[^a-z0-9]+/g, " ").trim();
        // A PHRASE MADE ENTIRELY OF STOPWORDS IS NOT EVIDENCE OF A FINISH.
        //
        // The stopword pass runs on TOKENS, so a corpus name whose every word
        // is stopped still became a phrase and matched titles on its own --
        // defeating the stopword list at the phrase level. Measured 2026-09-03:
        // 353 such phrases, "rookie auto" among them (and pack-size noise like
        // "10 cards"), which disqualified EVERY rookie-auto title in the pool
        // regardless of what it was printed on. `rookie` and `auto` are stopped
        // individually for describing the card rather than the print; joining
        // them changes nothing about that. A phrase earns its place only if at
        // least one word carries finish meaning of its own.
        const phraseWords = norm.split(" ").filter(Boolean);
        const carriesFinishWord = phraseWords.some(
          (w) => w.length >= MIN_TOKEN_LEN && !CORPUS_STOPWORDS.has(w) && !/^\d+$/.test(w),
        );
        if (norm.includes(" ") && norm.length <= 40 && carriesFinishWord) phrases.add(norm);
        for (const t of nameTokens(sp)) { bucket.add(t); seenHere.add(t); }
      }
    }
    // support counts PRODUCTS, not names: a token repeated 300 times inside one
    // product's checklist is one product's worth of evidence, not 300.
    for (const t of seenHere) support.set(t, (support.get(t) ?? 0) + 1);
  }

  const global = new Set();
  for (const [t, n] of support) if (n >= MIN_PRODUCT_SUPPORT) global.add(t);

  /**
   * ADJUDICATED tokens: the hand spellings and the core finish list. These are
   * finishes BY RULING, so the product-word suppression must not silence them.
   * Panini Rapture is the case that proves it -- the setKey `panini-rapture`
   * contains "rapture", so suppression alone would read the parallel family's
   * own name as the set's name and evict a Rapture card into base. A set that
   * shares its name with its parallel family is normal in the hobby (Prizm,
   * Mosaic, Optic, Chrome, Sapphire), and the rule that resolves it is: an
   * adjudicated finish word stays a finish word wherever it appears.
   */
  const adjudicated = new Set();
  for (const h of HAND_SPELLINGS) {
    const n = lower(h);
    if (n.includes(" ")) phrases.add(n); else { global.add(n); adjudicated.add(n); }
  }
  for (const c of FINISH_COLOR_TOKENS) { global.add(lower(c)); adjudicated.add(lower(c)); }
  for (const c of CORE_FINISH_TOKENS) { global.add(lower(c)); adjudicated.add(lower(c)); }

  return { global, byProduct, phrases, support, adjudicated, productCount, nameCount };
}

function corpus() {
  if (!_corpus) _corpus = buildVocabulary();
  return _corpus;
}

/** Reset the memoised corpus. Tests only. */
function _reset() { _corpus = null; }

/**
 * Is this token the PRODUCT's own name on this card rather than a finish?
 *
 * Read from the setKey itself, so it works for every product in the pool and
 * not only the 576 the corpus lists. `topps-heritage-chrome` + "chrome" is a
 * product word; `topps` + "chrome" is not.
 */
function isProductWord(token, setKey) {
  const t = lower(token);
  if (!t) return false;
  return setKeyTokens(setKey).includes(t);
}

/**
 * The finish vocabulary that applies to ONE card. The product's own setKey
 * words are removed, because on this card they name the set -- that is the
 * whole product-word fix.
 */
function vocabularyFor(year, setKey) {
  const c = corpus();
  const pk = productKey(year, setKey);
  const own = c.byProduct.get(pk) ?? null;
  const setWords = new Set(setKeyTokens(setKey));
  return {
    productListed: !!own,
    productTokens: own ?? new Set(),
    isFinishToken(tok) {
      const t = lower(tok);
      if (!t || t.length < MIN_TOKEN_LEN) return false;
      if (CORPUS_STOPWORDS.has(t)) return false;
      // THE PRODUCT-WORD SUPPRESSION IS THE POINT, AND IT OUTRANKS EVERYTHING.
      //
      // A token that is one of THIS card's own setKey words names the set on
      // this card, whatever it names elsewhere. `bowman-chrome` + "chrome",
      // `panini-rapture` + "rapture", `topps-heritage-chrome` + "heritage".
      // Letting an adjudicated word punch through here was tried and is wrong:
      // it makes every Bowman Chrome title "name a finish", and the genuine
      // base-auto-on-refractor-slug shape (the Gonzalez canary) stops being
      // evictable at all -- the subclass switches itself off on the family it
      // was authorized for.
      //
      // What protects a set that shares its name with its parallel family
      // (Rapture Gold, Prizm Silver, Chrome Refractor) is that the PARALLEL's
      // own distinguishing word -- the colour, the finish noun -- is still in
      // the vocabulary and still fires. A title naming ONLY the set name is a
      // title naming only the set.
      if (setWords.has(t)) return false;
      if (c.adjudicated.has(t)) return true;
      if (c.global.has(t)) return true;
      // a checklist plural ("Refractors" heads a section; the card carries the
      // singular) and the reverse
      if (t.endsWith("s") && c.global.has(t.slice(0, -1))) return true;
      if (c.global.has(`${t}s`)) return true;
      return false;
    },
    phrases: c.phrases,
  };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split a title into comparable words. `/` and `#` are boundaries. */
const titleWords = (t) => lower(t).split(/[^a-z0-9-]+/).filter(Boolean);

/**
 * Does the title state a serial number / print run?
 *
 * THE '#/N' SPELLING (audit finding 3). The old regex matched `N/N` and a bare
 * `/N`, but not `#/25` -- and "2020 Panini Prizm Tie-Dye Prizm #/25" is
 * precisely the numbered-base minting the IMPROVE guard has to refuse. `#` is
 * now an accepted lead-in beside whitespace and the brackets.
 *
 * The DENOMINATOR is excluded when it looks like a year (19xx/20xx): "sold
 * 8/2026" is a date, and no print run is 2,026.
 */
function titleStatesSerial(title) {
  return serialFromTitle(title) !== null;
}

/**
 * The print run the title states, or null. Used by the IMPROVE guard to tell a
 * fill the title SUPPORTS from one it does not.
 */
function serialFromTitle(title) {
  const t = lower(title);
  const YEARISH = /^(19|20)\d{2}$/;
  const numbered = t.match(/(?:^|[\s(\[#])(\d{1,5})\s*\/\s*(\d{1,5})(?=$|[\s)\],.])/);
  if (numbered && !YEARISH.test(numbered[2])) return Number(numbered[2]);
  // bare `/N` and the `#/N` spelling -- `#` is a lead-in, not a digit holder.
  const bare = t.match(/(?:^|[\s(\[]|#)\s*\/\s*(\d{1,5})(?=$|[\s)\],.])/);
  if (bare && !YEARISH.test(bare[1])) return Number(bare[1]);
  return null;
}

/**
 * Does this title name a finish, read against THIS card's product?
 *
 * `ctx` is `{ year, setKey }` -- the derived identity's, because that is what
 * decides which product's checklist applies. Passing nothing falls back to the
 * global union, which is broader and therefore safe.
 */
function titleNamesFinish(title, ctx = {}) {
  const t = lower(title);
  if (!t) return false;
  if (titleStatesSerial(t)) return true;

  const vocab = vocabularyFor(ctx?.year ?? ctx?.cardYear ?? null, ctx?.setKey ?? "");

  for (const p of vocab.phrases) {
    const parts = String(p).split(" ").filter(Boolean);
    if (parts.length < 2) continue;
    if (new RegExp(`\\b${parts.map(escapeRe).join("[\\s\\-&/]+")}\\b`).test(t)) return true;
  }

  for (const w of titleWords(t)) {
    if (vocab.isFinishToken(w)) return true;
    // A hyphenated compound is its parts: "OPTIC-FLEX" tokenises whole and
    // would never match bare "optic".
    if (w.includes("-") && w.split("-").some((part) => part && vocab.isFinishToken(part))) return true;
  }
  return false;
}

/**
 * Does the checklist list this parallel name for this product? The IMPROVE
 * guard's positive evidence: a derived parallel that the product's own
 * checklist names is a real parallel of THIS card, not a product word the
 * parser lifted out of the set name.
 *
 * EVERY token of the derived parallel must be one the product's own checklist
 * uses -- a stricter test than "any", because a single shared colour word is
 * not evidence that the whole name is listed.
 */
function checklistListsParallel(parallel, year, setKey) {
  const p = lower(parallel).replace(/[^a-z0-9]+/g, " ").trim();
  if (!p) return false;
  const c = corpus();
  const own = c.byProduct.get(productKey(year, setKey));
  if (!own) return false;
  const toks = nameTokens(p);
  if (!toks.length) return false;
  // A checklist heads its section in the PLURAL ("Gold Refractors") while the
  // card carries the singular ("Gold Refractor"), so the membership test has
  // to be plural-tolerant in both directions or every real parallel reads as
  // unlisted -- measured: `refractors` appears in 62 products, `refractor` in
  // 80, and the 2021 bowman-chrome slice carries only the plural.
  const inOwn = (t) => own.has(t)
    || (t.endsWith("s") && own.has(t.slice(0, -1)))
    || own.has(`${t}s`);
  return toks.every(inOwn);
}

/** Diagnostics for the census banner and the tests. */
function vocabularyStats() {
  const c = corpus();
  return {
    corpusPath: CORPUS_PATH,
    products: c.productCount,
    parallelNames: c.nameCount,
    globalTokens: c.global.size,
    phrases: c.phrases.size,
    handSpellings: HAND_SPELLINGS.length,
    handPhrases: HAND_PHRASES.length,
  };
}

module.exports = {
  CORPUS_PATH, HAND_SPELLINGS, HAND_PHRASES, HAND_LIST_CEILING,
  FINISH_COLOR_TOKENS, CORE_FINISH_TOKENS, CORPUS_STOPWORDS,
  buildVocabulary, vocabularyFor, vocabularyStats, isProductWord, setKeyTokens,
  titleNamesFinish, titleStatesSerial, serialFromTitle, checklistListsParallel,
  productKey, nameTokens, _reset,
};
