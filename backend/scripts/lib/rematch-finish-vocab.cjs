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

/**
 * STOPWORDS ELIGIBLE FOR A PER-PRODUCT EXCEPTION (first audit gate, leak 4).
 *
 * `america` is in CORPUS_STOPWORDS, added alongside usa/world/american on the
 * sound reasoning that a sport or a country names WHICH CHECKLIST a card
 * belongs to and never how it is printed. But "2023 Donruss America #240" is a
 * real Donruss insert/parallel, and Panini Stars & Stripes USA lists `America`
 * as a parallel NAME outright (2024 and 2025, verified in the corpus). An
 * unconditional stop reads a genuine parallel as silence and evicts the card
 * into base -- the same one-card-two-rows defect from the other direction.
 *
 * So a stopword the corpus proves is a PARALLEL NAME for a (year, setKey) is
 * un-stopped FOR THAT PRODUCT. The rule is per-product by construction: the
 * word keeps its stop everywhere else.
 *
 * WHY THIS IS A LIST AND NOT "ANY STOPWORD THE CORPUS NAMES"
 *
 * Measured on the committed corpus, the unrestricted rule un-stops 121
 * products on 22 words -- `signature` (46 products), `auto` (28), `dual` (18),
 * `rookie` (13), `patch`, `jersey`, `gem`, `cards`. Every one of those is a
 * word the stopword list exists to stop, and each is stopped for a reason that
 * a checklist row does NOT overturn: they describe the CARD or the SLAB (a
 * rookie auto patch, a gem-mint grade), not how the card is printed, and a
 * checklist that heads a section "Rookie Signatures" is naming a SUBSET. Letting
 * the corpus lift those stops would disqualify every rookie-auto title in the
 * pool from eviction -- exactly the 353-phrase defect the phrase filter closed.
 *
 * The eligible words are the ones whose stop rests on "this word names a
 * COUNTRY, A SPORT or A CHECKLIST" -- a claim a product's own checklist can
 * genuinely rebut by listing the word as a parallel of that product. Nothing
 * whose stop rests on "this describes the card or the slab" is eligible.
 */
const STOPWORD_EXCEPTION_ELIGIBLE = new Set([
  "america", "american", "usa", "world", "national",
  "baseball", "basketball", "football", "hockey", "soccer",
]);

/**
 * HAND-LISTED STOPWORD EXCEPTIONS -- the products whose checklist names an
 * eligible stopword as a parallel, but whose CORPUS SLICE cannot say so.
 *
 * The corpus-driven exception above is the mechanism; this is the same
 * mechanism's HAND_SPELLINGS, and it exists for the same reason that list
 * does: a product the corpus covers badly is not a product without parallels.
 *
 * THE CASE THAT PROVES IT. "2023 Donruss America #240" was the title leak 4
 * was written from, and after leak 4 shipped it STILL evicts -- because the
 * exception is corpus-driven and the corpus's donruss slices carry no parallel
 * NAMES at all. Measured on the committed corpus 2026-09-03:
 *
 *   baseball|2023|donruss   11 rows: "Black 1/1", "80", "77", "76",
 *                           "30 cards.", "10 cards.", "15 cards.",
 *                           "Printing Plates 1/1 ...", "5 cards.",
 *                           "3 cards.", "1 card."
 *   baseball|2022|donruss    7 rows, the same shape
 *
 * Those are pack-size and odds noise from a scrape that never captured the
 * parallel table. `stopwordExceptions` for those products is empty, `america`
 * keeps its global stop, `titleNamesFinish` answers FALSE, and a genuine
 * America /50 evicts onto the base slug -- one card, two rows, a split pool.
 * (Verified in this tree: the predicate returns false for the donruss title
 * and true for the Stars & Stripes one, which the corpus DOES carry.)
 *
 * THE SOURCE, quoted. America is a numbered parallel of the Donruss BASEBALL
 * base set in 2022 and 2023, at a print run of 50:
 *
 *   BaseballCardPedia, "2023 Donruss": "America (serial-numbered to 50
 *     copies)" -- listed with One Hundred /100, On Fire /75, Presidential
 *     Collection /46, Voltage /25, Artist Proof /10, Press Proof /5.
 *   Cardboard Connection, "2023 Donruss Baseball": "America - #/50".
 *   Trading Card Database carries it as its own checklist,
 *     "2023 Donruss - America" (sid 367832).
 *   Cardboard Connection, "2022 Donruss Baseball": the same parallel ladder,
 *     "America #/50".
 *
 * SCOPE IS BASEBALL, 2022-2023, AND NOTHING WIDER. The 2022 and 2023 Donruss
 * FOOTBALL parallel ladders were checked in the same pass (Beckett and
 * Cardboard Connection both) and neither lists an America parallel -- Canvas,
 * Press Proof, Season Stat Line, Jersey Number and the colour Holos, no
 * America. A hand entry that guessed football would un-stop a word on a
 * product whose checklist does not name it, which is the leak this closes,
 * pointed the other way. When the corpus's donruss slice is re-scraped with
 * its parallel table, this entry becomes redundant and should be deleted --
 * the corpus is what needs fixing, not this list.
 *
 * Every key here must be a stopword AND eligible; the tests assert both, so an
 * entry can never reach a word the eligibility gate exists to protect.
 */
const HAND_STOPWORD_EXCEPTIONS = new Map([
  ["2022|donruss", ["america"]],
  ["2023|donruss", ["america"]],
]);

/** The hand exception table is a patch, never a second corpus. Capped by tests. */
const HAND_STOPWORD_EXCEPTION_CEILING = 8;

/** The names a checklist heads its BASE section with. Anything longer names a
 *  PARALLEL of the base card ("Base Refractor"), never the base card. */
const BASE_ROW_NAMES = new Set(["base", "base set", "base card", "base cards"]);

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

/**
 * FINISH-FAMILY TOKENS -- the word that says WHICH member of a colour family
 * a card is (first audit gate, leak 1).
 *
 * CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD. A 2025 Topps Chrome football
 * checklist lists BOTH "Black Wave Refractor" AND "Black Refractor". They are
 * two cards, two print runs, two price curves. The derivation collapsed the
 * first onto the second -- "BLACK WAVE /10" -> Black Refractor -- because the
 * parser's Wave rule enumerates a colour list that omits black, so the title
 * fell through to the bare-colour scan, which reads `black` and stops.
 *
 * Every leak of that shape shares one signature: the TITLE names a family word
 * -- Wave, Vapor, Equinox, Etch, Shimmer, Ray, Mojo, Prism, Atomic, X-Fractor,
 * Sparkle, Lava, Geometric -- and the DERIVED parallel does not carry it. The
 * derived name is not a less specific reading of the same card, it is a
 * SIBLING card in the same family, and writing it splits one pool into two and
 * prices a /10 Black Wave against a /299 Black Refractor.
 *
 * This list is the vocabulary that test reads. It is deliberately NOT the
 * whole finish vocabulary: a family token is a word that MODIFIES a colour or
 * a base finish into a distinct sibling, not every word a parallel name can
 * contain. Colour words are excluded on purpose (a colour the derivation drops
 * is a different defect, and the axis diff already sees it), and so are the
 * generic base finishes -- "refractor" and "prizm" name the family's ROOT, and
 * requiring a title's "refractor" to appear in a derived "Gold Refractor" is
 * satisfied trivially while requiring it in a derived "Gold Prizm" would flag
 * a genuine product difference the setKey already settles.
 *
 * DIRECTION: this is a REFUSING test on the IMPROVE side. A token the title
 * names and the derivation lacks REFUSES the write; it never mints a parallel
 * of its own. Absent beats wrong.
 */
const FINISH_FAMILY_TOKENS = [
  // the pattern families -- each turns "<Colour> Refractor" into a different card
  "wave", "waves", "vapor", "vapour", "equinox", "etch", "etched", "glass",
  "shimmer", "ray", "raywave", "mojo", "prism", "prismatic", "atomic",
  "sparkle", "lava", "geometric", "speckle", "grass", "disco", "pulsar",
  "velocity", "pandora", "zebra", "tiger", "snakeskin", "dragon", "camo",
  "cracked", "marble", "nebula", "galactic", "logofractor",
  "hyperplaid", "dazzle", "scope", "fireworks", "flash", "laser", "canvas",
  "die-cut", "diecut", "sapphire", "superfractor", "x-fractor", "xfractor",
  "aurora", "eclipse", "tectonic", "kaleidoscope", "genesis", "cosmic",
];
const FINISH_FAMILY_SET = new Set(FINISH_FAMILY_TOKENS.map(lower));

/**
 * FAMILY-TOKEN ALIASES. One family is spelled several ways across sellers and
 * checklists, and a title spelling that the derived name spells differently is
 * NOT a dropped family. Each alias group collapses to one canonical token so
 * the comparison below is about the FAMILY, not about the spelling.
 *
 * "Etched In Glass Variation" and "Image Variation" are listed SEPARATELY on
 * the checklist and are two cards, so `etched`/`glass` map to one family and
 * a derived "Image Variation" carrying neither is a genuine drop.
 */
const FAMILY_ALIASES = new Map([
  ["waves", "wave"], ["raywave", "ray"], ["vapour", "vapor"],
  ["etched", "etch"], ["glass", "etch"],
  ["xfractor", "x-fractor"], ["diecut", "die-cut"],
  ["prismatic", "prism"],
]);
const canonFamily = (t) => FAMILY_ALIASES.get(lower(t)) ?? lower(t);

/**
 * The finish-family tokens a TITLE names, canonicalised and de-duplicated.
 *
 * The title's own words only -- no corpus lookup, because the question is not
 * "is this a parallel of this product" (the checklist answers that) but "did
 * the seller write a family word that the derivation threw away". A word the
 * seller wrote is evidence whether or not our corpus carries the product.
 *
 * The product's OWN setKey words are removed, for the same reason they are in
 * `isFinishToken`: "2025 Topps Chrome Sapphire ..." names the SET on a
 * `topps-chrome-sapphire` card, and demanding the derived parallel carry
 * "sapphire" would refuse every write on that product.
 */
function titleFinishFamilyTokens(title, setKey) {
  const own = new Set(setKeyTokens(setKey ?? ""));
  const out = new Set();
  for (const w of titleWords(title)) {
    const cands = w.includes("-") ? [w, ...w.split("-")] : [w];
    for (const c of cands) {
      if (!c || own.has(c)) continue;
      if (FINISH_FAMILY_SET.has(c)) out.add(canonFamily(c));
    }
  }
  return [...out];
}

/** The family tokens a derived PARALLEL NAME carries, canonicalised. */
function parallelFinishFamilyTokens(parallel) {
  const out = new Set();
  for (const w of titleWords(parallel)) {
    const cands = w.includes("-") ? [w, ...w.split("-")] : [w];
    for (const c of cands) if (FINISH_FAMILY_SET.has(c)) out.add(canonFamily(c));
  }
  return [...out];
}

/**
 * The family tokens the TITLE names that the DERIVED PARALLEL does not carry.
 * Empty means the derivation kept every family the title stated -- which is
 * the only shape allowed to write.
 */
function familyTokensDroppedByDerivation(title, parallel, setKey) {
  const have = new Set(parallelFinishFamilyTokens(parallel));
  return titleFinishFamilyTokens(title, setKey).filter((t) => !have.has(t));
}

/**
 * The checklist parallel NAMES this product lists, lowercased and space-
 * normalised. The corpus stores TOKENS per product for the vocabulary; the
 * family test needs whole NAMES, so the corpus build now keeps both and this
 * is the reader.
 */
function checklistParallelNamesFor(year, setKey) {
  const c = corpus();
  return c.namesByProduct.get(productKey(year, setKey)) ?? null;
}

/**
 * Does this product's checklist list a parallel whose name carries EVERY
 * family token the title names? Returns that name (the most specific match)
 * or null.
 *
 * This is the positive half of leak 1's rule: when the checklist lists the
 * title's exact family for this (year, setKey), the derived parallel MUST be
 * that row -- so the classifier can name the row the write should have gone
 * to, not merely refuse.
 */
function checklistParallelForFamily(title, year, setKey) {
  const fams = titleFinishFamilyTokens(title, setKey);
  if (!fams.length) return null;
  const names = checklistParallelNamesFor(year, setKey);
  if (!names) return null;
  const words = new Set(titleWords(title));
  const colourSet = new Set(FINISH_COLOR_TOKENS.map(lower));
  let best = null;
  for (const n of names) {
    const nf = new Set(parallelFinishFamilyTokens(n));
    if (!fams.every((f) => nf.has(f))) continue;
    // Every COLOUR the checklist name states must also be in the title, or
    // "Black Wave Refractor" would be offered for a "Pink Wave" title.
    const colours = titleWords(n).filter((w) => colourSet.has(w));
    if (!colours.every((c) => words.has(c))) continue;
    // THE SHORTEST MATCH, NOT THE LONGEST. Corpus names carry pack-size and
    // channel noise ("Wave Refractor 1:14 Hobby, 1:24 Jumbo"), and the longest
    // match is reliably the noisiest one. The row a write should have gone to
    // is the parallel NAME; the shortest name carrying every family the title
    // states is that name, and the noise is always a suffix on it.
    if (!best || n.length < best.length) best = n;
  }
  return best;
}

// -- LOT / RANGE LISTINGS: a multi-card sale never mints a cardNumber ------
//
// CF-A-LOT-IS-NOT-A-CARD, at the classifier (audit gates 1 and 2, leaks 2+6).
//
// 23 IMPROVE lines in shards 0-15 and 117 more in shards 16-31 are one shape:
// a title selling MANY cards, whose card-number RANGE the derivation read as
// the range's FIRST number.
//
//   "Complete Set #1-726"                     -> cardNumber 1
//   "#1-150 Pick Your Cards"                  -> cardNumber 1
//   "Singles #1-251"                          -> cardNumber 1
//   "#8-40 Insert"                            -> cardNumber 8
//   "Lot 110 different #1-125"                -> cardNumber 1
//   "Complete Set of 792 Cards with Frank Thomas #414" -> cardNumber 692
//   "LOT OF THREE (3)"
//
// Each of those writes ONE lot's price into ONE card's pool. The FMV that pool
// projects is then the price of a box, attributed to a single card -- and a
// range's first number is not even a card the sale contained more of than any
// other. Absent beats wrong: a lot title names no card, so it mints none.
//
// The parser's own `isMultiCardLot` is the sibling detector and covers the LOT
// idioms (it is deliberately count-anchored so a surname "Lot" is not a lot).
// It does NOT cover the two shapes that dominate these lines -- a card-number
// RANGE, and the "you pick / pick your / singles" multi-listing vocabulary --
// so this detector adds exactly those and the classifier consults BOTH.

/** A card-number RANGE: `#1-726`, `# 8 - 40`, `#US1-US50`. Two card numbers
 *  joined by a dash after a `#` is a span of cards, never one card. Hyphenated
 *  card numbers are real (`CPA-JG`, `BCP-102`), so a range requires the SECOND
 *  half to be numeric and STRICTLY GREATER than the first -- `BDC-1` and
 *  `1-1` can never satisfy that, and a genuine span always does. */
const CARD_NUMBER_RANGE_RE = /#\s*([a-z]{0,4})\s*(\d{1,4})\s*[-–—]\s*(?:[a-z]{0,4})\s*(\d{1,4})\b/i;

/** A GRADER token is not the far half of a range (GUARD 7, 2026-09-04).
 *
 *  `[a-z]{0,4}` after the dash exists to read `#US1-US50`, where the prefix
 *  repeats. It also matches `PSA`, and the audit found the cost:
 *
 *    "1989 Upper Deck Ken Griffey Jr #1-PSA 9 (RC)"   -> range 1..9
 *    "1989 Upper Deck #1-Ken Griffey JR NM-MT+ BGS 8.5"
 *
 *  Both are ONE card -- the landmark #1 Griffey rookie -- with the grade
 *  written up against the number. Reading them as a 1..9 span made GUARD 5
 *  refuse a genuine, checklist-backed improvement on the most-traded card of
 *  its era. A FALSE lot verdict costs a real repair, so the range must not
 *  fire when the token after the dash is a grading company.
 *
 *  It is a refusal to READ A RANGE, never a licence: the row falls through to
 *  every other lot idiom unchanged, so "Complete Set #1-PSA 9" is still a lot
 *  on `complete set`. */
const RANGE_FAR_HALF_IS_GRADER_RE = /^\s*[-–—]\s*(?:PSA|BGS|BVG|SGC|CGC|CSG|HGA|TAG|ISA|GMA|KSA)\b/i;

function cardNumberRangeFromTitle(title) {
  const t = String(title ?? "");
  const m = t.match(CARD_NUMBER_RANGE_RE);
  if (!m) return null;
  // Re-read the text from the FIRST number's end: if what follows the dash is
  // a grader token, this is "#1-PSA 9", a card number with a grade after it.
  const firstEnd = (m.index ?? 0) + m[0].indexOf(m[2]) + m[2].length;
  if (RANGE_FAR_HALF_IS_GRADER_RE.test(t.slice(firstEnd))) return null;
  const a = Number(m[2]), b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return { from: `${m[1] ?? ""}${a}`, to: b, quoted: m[0].trim() };
}

/** The multi-card VOCABULARY the parser's count-anchored lot lexicon does not
 *  reach. Each idiom means "this listing is more than one card" on its own.
 *
 *  `singles` is here in its LOT sense only -- "Singles #1-251" is a range of
 *  singles to choose from -- so it is required to sit beside a range or a
 *  pick idiom, never counted alone (a "Set Break Single" is one card, and the
 *  parser's detector already says so). */
const LOT_VOCAB_RE = new RegExp([
  String.raw`\bcomplete\s+set\b(?!\s*break\b)`,
  String.raw`\bcomplete\s+base\s+set\b`,
  String.raw`\bfull\s+set\b`,
  String.raw`\byou\s+pick\b`,
  String.raw`\bu\s+pick\b`,
  String.raw`\bpick\s+your\b`,
  String.raw`\bpick\s+a\s+card\b`,
  String.raw`\byour\s+choice\b`,
  String.raw`\bset\s+break\b(?!\s*single\b)`,
  String.raw`\blot\s+of\s+\w+`,
  String.raw`\blot\s+\d+`,
  String.raw`\b\d+\s+different\b`,
  String.raw`\bteam\s+set\b`,
  // -- idioms the shard-31 IMPROVE audit found still writable (2026-09-04) --
  // Each of these sold MANY cards and was about to be improved onto ONE
  // card's pool. They are quoted verbatim from the census run log.
  //
  //   "1975 Topps Set w/ 9 Graded cards Bench, Jackson, Schmidt, Carl Yas."
  //   "1975 Topps HIGH GRADE Lot (122 ) w/ 2 SGC MINT 9 - VENDING - VSCARDS"
  //   "1995 Fleer Ultra Baseball - Golden Prospect Complete Insert Set #1-1"
  //   "1989 Topps Teenage Mutant Ninja Turtles Cards # 1-88 + 11 Stickers"
  //
  // `set w/` and `lot (` are the count-carrying shapes the parser's own
  // lexicon anchors on a NUMBER and therefore missed when the number sits
  // after the token rather than before it. `vending` is a box of cards by
  // definition. `complete <word> set` generalizes the existing
  // `complete set` / `complete base set` pair to the insert and subset
  // spellings without matching a bare "set".
  String.raw`\bset\s+w\/`,
  String.raw`\blot\s*\(`,
  String.raw`\bvending\b`,
  String.raw`\bcomplete\s+\w+\s+set\b(?!\s*break\b)`,
  String.raw`\bcards?\s*#\s*\d{1,4}\s*[-–—]\s*\d{1,4}\b`,
  // -- GUARD 7 (slot-19 / slot-31 IMPROVE audit, 2026-09-04) ---------------
  //
  // CF-A-LOT-IS-NOT-A-CARD, read onto the two shapes the audit found STILL
  // WRITABLE after every idiom above. Both are quoted verbatim from the
  // committed census evidence.
  //
  //   "Ja'Marr Chase 2022 Panini Prizm Prizm Break #2 Raw 10"
  //       A BREAK is a sealed box opened live and sold by slot. The "#2" is
  //       the slot, the team or the spot in the break -- never this card's
  //       number. Measured on slot 19 this was the ONE lot-shaped row that
  //       reached the IMPROVE gate ARMED, because no idiom here named a
  //       break: filed on card #2, a whole break's price would land in one
  //       card's pool.
  //
  //       THE BREAK WORD IS NAMED BY ITS PRODUCT, NEVER ON ITS OWN, and the
  //       measurement is why. A bare `\bbreak\b` also matches the "Set-Break"
  //       idiom, and a SET BREAK IS THE OPPOSITE SHAPE: a seller breaking a
  //       set to sell its cards ONE AT A TIME, so "1987 Topps Tiffany
  //       Set-Break #749 Ozzie Smith" states exactly one card and its real
  //       number. Measured read-only over the slot-19 evidence, a bare word
  //       disarmed ~50 GMCARDS set-break singles that classify correctly
  //       today -- trading one leak for fifty regressions.
  //
  //       So the idiom is the BOX-BREAK one: a break named by the product
  //       whose box is being opened ("Prizm Break", "Case Break", "Razz
  //       Break", "Live Break", "Box Break"), where the "#2" is a slot and
  //       not a card. `set break` keeps its own entry above, with its own
  //       `(?!\s*single\b)` escape, and is deliberately excluded here.
  //
  //   "2022 Topps Heritage Minor League - #1-220 - You Choose"
  //       `you pick`, `u pick`, `pick your`, `pick a card` and `your choice`
  //       were each already here; `you choose` is the same idiom in the one
  //       spelling the list missed. Naming it means a title offering a menu
  //       of 220 cards is a lot ON ITS VOCABULARY, not merely on the range
  //       that happens to sit beside it -- so the same listing without the
  //       "#1-220" is caught too.
  String.raw`\byou\s+choose\b`,
  String.raw`\b(?:box|case|live|razz|personal|group|prizm|mojo)\s*[-–—]?\s*break\b(?!\s*single\b)`,
].join("|"), "i");

/** The "singles" lot sense -- only beside a range or a pick idiom. */
const SINGLES_RE = /\bsingles\b/i;

/**
 * Is this title a LOT or a RANGE listing -- a sale of more than one card?
 *
 * Returns { lot, reasons, range } so the classifier can quote WHY, and the
 * report can carry a candidate for excludedFromFmv.
 *
 * `parserSaysLot` is the parser's own `isMultiCardLot` verdict, passed in
 * rather than required here: this module is pure and must not depend on
 * dist/. Two detectors, one decision, and neither is allowed to be the only
 * one -- the count-anchored idioms live there, the range and pick vocabulary
 * live here.
 */
function isLotOrRangeListing(title, parserSaysLot) {
  const t = String(title ?? "");
  const reasons = [];
  // ONE CARD, SAID EXPLICITLY, SETTLES IT FIRST -- the same escape hatch the
  // parser's detector opens, for the same reason: "Set Break Single" and
  // "Single Card" name exactly one card whatever else the title says.
  const singleSaid = /\bbreak\s+single\b|\bsingle\s+card\b/i.test(t);
  const range = singleSaid ? null : cardNumberRangeFromTitle(t);
  if (range) reasons.push(`card-number-range:${range.quoted}`);
  if (!singleSaid) {
    const m = t.match(LOT_VOCAB_RE);
    if (m) reasons.push(`lot-vocabulary:${String(m[0]).trim().toLowerCase()}`);
    if (SINGLES_RE.test(t) && (range || /\bpick\b/i.test(t))) reasons.push("lot-vocabulary:singles");
    if (parserSaysLot === true) reasons.push("parser-isMultiCardLot");
  }
  return { lot: reasons.length > 0, reasons, range };
}

// -- NEAR-MISS FINISH SPELLINGS: a typo is still a finish ------------
//
// CF-ABSENT-BEATS-WRONG at the lexer (first audit gate, leak 3). Seven
// BASE-EVICTION lines say "Refactor", "Refracor", "Refractpr". Each is a
// GENUINE refractor whose title our vocabulary could not read, so
// `titleNamesFinish` returned false, the eviction qualified, and the row was
// written onto the BASE slug -- one card, two rows, a split pool.
//
// The fix is edit-distance tolerance, applied ON THE DISQUALIFYING SIDE ONLY.
// A near-miss makes a title "name a finish" for the purpose of REFUSING an
// eviction. It never mints a parallel, never names WHICH finish, and never
// reaches the IMPROVE positive path -- a typo is evidence that we cannot read
// the title, and the answer to that is to leave the row alone.
//
// The 7-character floor is what keeps it safe. Every 1-edit neighbourhood of a
// short word is full of real other words ("gold"/"bold", "wave"/"cave"), and a
// vocabulary that matched those would disqualify half the pool. At 7+ chars
// the neighbourhoods are empty of English: refractor, superfractor, x-fractor,
// prismatic, holofoil, sapphire.

/** Finish words long enough that a 1-edit neighbour is a typo, not a word. */
const NEAR_MISS_MIN_LEN = 7;

/**
 * Is the edit distance between `a` and `b` at most 1 -- counting an adjacent
 * TRANSPOSITION as one edit? Sellers make all three ("refractpr" is a
 * substitution, "refracor" a deletion, "refratcor" a transposition).
 */
function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] === b[i]) continue;
      if (diff >= 0) {
        // a second mismatch is allowed ONLY as the far half of an adjacent
        // transposition, and nothing may differ after it.
        return diff === i - 1 && a[diff] === b[i] && a[i] === b[diff]
          && a.slice(i + 1) === b.slice(i + 1);
      }
      diff = i;
    }
    return true;
  }
  // one insertion / deletion
  const s1 = la < lb ? a : b, s2 = la < lb ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < s1.length && j < s2.length) {
    if (s1[i] === s2[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/** The long finish words a near-miss is measured against. Built once. */
let _nearMissWords = null;
function nearMissVocabulary() {
  if (_nearMissWords) return _nearMissWords;
  const out = new Set();
  for (const w of [...CORE_FINISH_TOKENS, ...HAND_SPELLINGS, ...FINISH_FAMILY_TOKENS]) {
    const t = lower(w);
    if (t.length >= NEAR_MISS_MIN_LEN) out.add(t);
  }
  _nearMissWords = [...out];
  return _nearMissWords;
}

/**
 * Does this title carry a NEAR-MISS spelling of a long finish word?
 *
 * DISQUALIFYING ONLY. Returns the {word, matched} it found so the refusal can
 * quote it; the caller must never use `matched` as a parallel name.
 */
function titleNearMissesFinish(title, setKey) {
  const own = new Set(setKeyTokens(setKey ?? ""));
  const vocab = nearMissVocabulary();
  const view = vocabularyFor(null, setKey ?? "");
  for (const w of titleWords(title)) {
    const cands = w.includes("-") ? [w, ...w.split("-")] : [w];
    for (const c of cands) {
      if (!c || c.length < NEAR_MISS_MIN_LEN || own.has(c)) continue;
      // A WORD THE ORDINARY VOCABULARY ALREADY READS IS NOT A NEAR MISS.
      // "Refractor" is one edit from "refractors", so without this a correct
      // spelling reports as a typo -- harmless to the verdict (both mean the
      // title names a finish) but a lie in the reason, and the pins read the
      // reason. This predicate answers only "we could NOT read this word, and
      // it is one edit from a word we could".
      if (view.isFinishToken(c)) continue;
      for (const v of vocab) {
        // an EXACT hit is the ordinary vocabulary's job, not this one
        if (c === v) continue;
        // A WORD THAT MERELY EXTENDS OR TRUNCATES THE FINISH WORD IS NOT A
        // TYPO (found by re-classifying slot 13, 2026-09-03).
        //
        //   "2025 Bowman Chrome Draft ... Auto #CPA-KC Diamondb"
        //
        // is "Diamondbacks", the TEAM, cut off by the census sample's 68-char
        // title truncation -- and "diamondb" is one insertion from "diamond",
        // which IS a finish word. Read as a typo it disqualified a genuine
        // eviction: the guard would have refused to move a base auto off a
        // refractor slug because the seller named the team.
        //
        // A real typo DIVERGES INSIDE the word -- refactor, refracor,
        // refractpr, refrqctor all break in the middle and none of them is a
        // prefix of "refractor" or has it as a prefix. A word that contains
        // the vocabulary word as a leading or trailing run is a longer word
        // that STARTS with it (Diamondbacks, Refractors' own plural) or a
        // truncation of one, and neither is evidence of a misspelling.
        //
        // Directionally this is the SAFE narrowing: it can only cost a
        // refusal we would have made, never admit an eviction the ordinary
        // vocabulary already disqualifies -- "refractors" is read exactly by
        // `isFinishToken` above and never reaches here.
        if (c.startsWith(v) || v.startsWith(c)) continue;
        if (editDistanceAtMost1(c, v)) return { word: c, matched: v };
      }
    }
  }
  return null;
}

// ── the corpus, loaded once ────────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Per-(year,setKey) vocabulary views, memoised for the process lifetime. */
const _vocabCache = new Map();

let _corpus = null;
/** Set only by `_reset(path)` -- see the note there. null = the committed corpus. */
let _corpusPathOverride = null;

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
  /**
   * The whole parallel NAMES per product, beside the tokens.
   *
   * `byProduct` holds TOKENS, which is what a word-at-a-time vocabulary test
   * needs. The finish-family rule needs whole names -- "when the checklist
   * lists the title's exact family for this (year, setKey), the derived
   * parallel must be THAT row" -- and a set of tokens cannot say which row.
   * Built in the same pass so the corpus is still read once.
   */
  const namesByProduct = new Map();
  /**
   * The PRINT RUNS this product's checklist gives its BASE row, if any.
   *
   * CF-NUMBERED-BASE-IS-CHECKLIST-DEFINED (Drew's ruling) is a claim about the
   * CARD, and a card is a (name, print run) pair. `checklistListsParallel`
   * cannot answer it -- it is a token-membership test, and "base" is a token of
   * every product -- so the corpus's own `printRun` field is read here and the
   * numbered-base guard asks THIS instead.
   *
   * Measured on the committed corpus 2026-09-03: 36,699 parallel rows, 27,009
   * carrying a print run, and exactly ZERO whose NAME is bare "Base". Five rows
   * begin with the word (Base Refractor /499, Base Chrome /699, Base Gold
   * Sparkle Mosaic /24 ...) and every one of them is a NAMED PARALLEL of the
   * base card, not a numbered base. So the honest answer today is that no
   * product in the corpus defines a numbered base, and the guard refuses every
   * one -- which is the ruling, applied. A future checklist that does list one
   * lands here and the guard admits it without a code change.
   */
  const baseRunsByProduct = new Map();
  /**
   * THE PER-PRODUCT STOPWORD EXCEPTION (first audit gate, leak 4).
   *
   * CORPUS_STOPWORDS suppresses `america` UNCONDITIONALLY -- it was added with
   * usa/world/american as a SPORT word ("USA Baseball", "Football Stars"), on
   * the sound reasoning that a sport names which checklist a card belongs to
   * and never how it is printed. But "2023 Donruss America #240" is a real
   * Donruss insert/parallel: on THAT product the checklist itself lists
   * `America` as a parallel name, and an unconditional stop reads a genuine
   * parallel as silence and evicts the card into base.
   *
   * A stopword is a statement about a word's meaning IN GENERAL. The corpus is
   * a statement about this product in particular, and the particular wins: any
   * stopword that a (year, setKey)'s own checklist lists as a parallel NAME is
   * un-stopped FOR THAT PRODUCT ONLY. `america` stays stopped on the 575 other
   * products, and the same exception covers every other stopword the corpus
   * proves out somewhere -- `national`, `series`, `star` -- without either list
   * having to be edited again.
   *
   * The exception reads the checklist NAME, not the token stream: a word that
   * merely appears INSIDE a longer name ("America's Pastime Red") is not the
   * parallel, and admitting it would re-open the leak the stopword closed. The
   * name must BE the word, alone.
   */
  const stopwordExceptions = new Map();
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
        if (norm && norm.length <= 60) {
          let names = namesByProduct.get(pk);
          if (!names) { names = new Set(); namesByProduct.set(pk, names); }
          names.add(norm);
          // A SINGLE-WORD checklist parallel that the global stopword list
          // suppresses is un-stopped for THIS product -- see the note above.
          if (!norm.includes(" ") && CORPUS_STOPWORDS.has(norm) && STOPWORD_EXCEPTION_ELIGIBLE.has(norm)) {
            let ex = stopwordExceptions.get(pk);
            if (!ex) { ex = new Set(); stopwordExceptions.set(pk, ex); }
            ex.add(norm);
          }
        }
        for (const t of nameTokens(sp)) { bucket.add(t); seenHere.add(t); }
      }
      // The print run belongs to the PARALLEL ROW, not to a spelling of it.
      // Only a row whose name IS "Base" (or "Base Set" / "Base Card" -- the
      // three ways a checklist heads the same section) can define a numbered
      // base; "Base Refractor /499" is a Refractor.
      {
        const nm = lower(par?.name).replace(/[^a-z0-9]+/g, " ").trim();
        const run = Number(par?.printRun);
        if (BASE_ROW_NAMES.has(nm) && Number.isFinite(run) && run > 0) {
          let runs = baseRunsByProduct.get(pk);
          if (!runs) { runs = new Set(); baseRunsByProduct.set(pk, runs); }
          runs.add(run);
        }
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

  // THE HAND-LISTED STOPWORD EXCEPTIONS join the corpus-driven ones, in the
  // SAME map and the same shape -- so every reader downstream (`vocabularyFor`,
  // `isFinishToken`) is unchanged, and a hand entry can do nothing a corpus
  // entry could not. See HAND_STOPWORD_EXCEPTIONS for why the donruss slice
  // needs one. Merged, never overwritten: a product the corpus DOES cover
  // keeps everything the corpus proved.
  for (const [pk, words] of HAND_STOPWORD_EXCEPTIONS) {
    let ex = stopwordExceptions.get(pk);
    if (!ex) { ex = new Set(); stopwordExceptions.set(pk, ex); }
    for (const w of words) {
      const t = lower(w);
      // The eligibility gate applies to a hand entry exactly as it does to a
      // corpus one. A hand list that could reach `signature` or `gem` would be
      // a way around the gate, not an exception to it.
      if (CORPUS_STOPWORDS.has(t) && STOPWORD_EXCEPTION_ELIGIBLE.has(t)) ex.add(t);
    }
  }

  return {
    global, byProduct, namesByProduct, stopwordExceptions, baseRunsByProduct,
    phrases, support, adjudicated, productCount, nameCount,
    phraseIndex: buildPhraseIndex(phrases),
  };
}

/**
 * THE PHRASE INDEX -- why it exists, and why it cannot change a verdict.
 *
 * CF-CENSUS-THROUGHPUT (2026-09-03). The corpus carries 16,187 phrases, and
 * `titleNamesFinish` was COMPILING A FRESH RegExp FOR EVERY ONE OF THEM, on
 * every call, for every row -- with two calls per row on the IMPROVE path that
 * is ~32,000 regex compilations per comp. Measured on 20,000 real slot-0 rows,
 * classifyRow alone: 15-27 ms/row (37-66 rows/s) against the pre-#1667
 * classifier's ~0.02-0.04 ms/row -- a three-orders-of-magnitude classifier
 * slowdown that showed up in the field as slot 0 reading 328k rows in 140
 * minutes where the old one walked 524k in 6.
 *
 * With the index, the same 20,000 rows classify at 0.12-0.28 ms/row
 * (3,500-8,500 rows/s), against a runner-class target of ~700 rows/s -- and
 * with ZERO verdict differences over all 20,000.
 *
 * The index is a pure lookup reordering, not a new test. A phrase can only
 * match a title if EVERY one of its words appears there -- the phrase regex is
 * `\bw1[\s\-&/]+w2...\b`, so each wI must be present at a word boundary. So:
 * bucket every phrase under ONE of its words (see the anchor note below), and
 * at match time test only the buckets the title's own words open. Every phrase
 * the linear scan would have matched is still tested, and the regexes are
 * compiled ONCE at corpus-build time rather than per call.
 *
 * The one subtlety is the separator class: `[\s\-&/]+` means a phrase's words
 * may be spelled in the title joined by a hyphen ("tie-dye"), and `titleWords`
 * keeps hyphenated compounds whole. So the candidate key set for a title is
 * its words PLUS the hyphen-split parts of each -- which is exactly the same
 * superset `isFinishToken` already walks below. Verdict equality over 20,000
 * real rows is asserted by the pins.
 *
 * THE ANCHOR IS THE PHRASE'S RAREST WORD, NOT ITS FIRST
 *
 * ANY word of a phrase is a sound anchor -- all of them must appear for the
 * phrase to match -- so the index is free to choose, and the choice is worth
 * a lot. Anchoring on the first word buries 701 phrases under `rookie` and
 * 466 under `2023`, and a title carrying either word then pays hundreds of
 * regex tests anyway: measured 0.166 ms/row, most of what was left. Anchoring
 * each phrase on its LEAST COMMON word spreads the same phrases over buckets
 * that a title rarely opens, and the ones it does open are small.
 *
 * Rarity is counted over the phrase set itself, which is available here and
 * needs no outside evidence. The match set is unchanged either way: a title
 * matches a phrase iff it contains every word of it, so whichever word we
 * anchor on, a matching title opens that bucket.
 */
function buildPhraseIndex(phrases) {
  // Pass 1: split each phrase, and count how many phrases use each word.
  const split = [];
  const wordFreq = new Map();
  for (const p of phrases) {
    const parts = String(p).split(" ").filter(Boolean);
    if (parts.length < 2) continue;   // same guard the linear scan applied
    split.push(parts);
    for (const w of new Set(parts)) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
  }
  // Pass 2: anchor each phrase on its rarest word.
  const byAnchor = new Map();
  for (const parts of split) {
    let anchor = parts[0], best = Infinity;
    for (const w of parts) {
      const n = wordFreq.get(w) ?? 0;
      if (n < best) { best = n; anchor = w; }
    }
    const re = new RegExp(`\\b${parts.map(escapeRe).join("[\\s\\-&/]+")}\\b`);
    let bucket = byAnchor.get(anchor);
    if (!bucket) { bucket = []; byAnchor.set(anchor, bucket); }
    bucket.push(re);
  }
  return byAnchor;
}

/**
 * Does any corpus phrase match this title? Equivalent to the linear scan over
 * `vocab.phrases`, reached through the rarest-word anchor index.
 */
function phraseIndexMatches(index, lowerTitle, words) {
  for (const w of words) {
    const bucket = index.get(w);
    if (bucket) { for (const re of bucket) if (re.test(lowerTitle)) return true; }
  }
  return false;
}

function corpus() {
  if (!_corpus) _corpus = buildVocabulary(_corpusPathOverride ?? CORPUS_PATH);
  return _corpus;
}

/**
 * Reset the memoised corpus AND the per-product vocabulary cache. Tests only.
 *
 * `corpusPath` swaps in an alternate corpus file for the reads that follow.
 * This exists so a guard whose behaviour depends on WHAT THE CHECKLIST SAYS
 * can be pinned against a checklist that says it. `checklistDefinesNumberedBase`
 * is that guard: the committed corpus defines no numbered base on any of its
 * 576 products, so on that corpus the new predicate and the old
 * `checklistListsParallel("Base", ...)` both answer false everywhere and a
 * mutation that reverts one to the other changes nothing observable. The two
 * are only distinguishable on a product whose checklist DOES list one -- so
 * the pin supplies that product, and the mutation goes red.
 *
 * Pass no argument to go back to the committed corpus.
 */
function _reset(corpusPath) {
  _corpus = null; _vocabCache.clear(); _nearMissWords = null;
  _corpusPathOverride = corpusPath ? String(corpusPath) : null;
}

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
  // MEMOISED PER (year, setKey) FOR THE PROCESS LIFETIME.
  //
  // The view is a pure function of (year, setKey) and the immutable corpus:
  // `own` is a corpus lookup and `setWords` is derived from the setKey string
  // alone, so two calls with the same key are indistinguishable. A census
  // shard is thousands of rows over a few hundred products, and the classifier
  // asks for this view several times per row -- rebuilding a Set and a closure
  // each time cost 0.33 ms/row measured over 20,000 slot-0 rows. `_reset()`
  // clears this alongside the corpus so tests that swap the corpus file still
  // see a rebuilt view.
  const pk = productKey(year, setKey);
  const hit = _vocabCache.get(pk);
  if (hit) return hit;
  const c = corpus();
  const own = c.byProduct.get(pk) ?? null;
  const setWords = new Set(setKeyTokens(setKey));
  // The stopwords THIS product's own checklist lists as parallel names, and so
  // does not stop here (leak 4). Empty for all but a handful of products.
  const unstopped = c.stopwordExceptions.get(pk) ?? null;
  const view = {
    productListed: !!own,
    productTokens: own ?? new Set(),
    stopwordExceptions: unstopped ?? new Set(),
    isFinishToken(tok) {
      const t = lower(tok);
      if (!t || t.length < MIN_TOKEN_LEN) return false;
      // A STOPWORD THIS PRODUCT'S CHECKLIST NAMES AS A PARALLEL IS NOT STOPPED
      // HERE (leak 4). "2023 Donruss America #240" is a real Donruss parallel
      // and `america` is a global stopword; the corpus for THAT product settles
      // it, and every other product keeps the stop. Checked before the stopword
      // test so the exception can actually reach it, and AFTER nothing else --
      // the product-word suppression below still outranks it, because a word
      // that is this product's own set name is its set name whatever else it is.
      if (unstopped && unstopped.has(t)) return !setWords.has(t);
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
    phraseIndex: c.phraseIndex,
  };
  _vocabCache.set(pk, view);
  return view;
}


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
 * THE SERIAL TAIL ACCEPTS ANY NON-DIGIT BOUNDARY (second audit gate, leak 5).
 *
 * The tail used to be `(?=$|[\s)\],.])` -- end of string, whitespace, or one of
 * four punctuation marks. eBay titles do not end there. Measured over the
 * shards 16-31 IMPROVE sample, 168 of the 298 dirty lines are this ONE gap:
 *
 *   "... Blue Disco 1/25!"            the "!" rejects the match  -> serial null
 *   "... Bowman Chrome #/99<fire><fire>"  an emoji rejects it    -> serial null
 *   "... 100/100***BOOK"              the "*" rejects it         -> serial null
 *
 * A null serial defeats GUARD 2 entirely: the guard's whole job is "the title
 * states a print run AND names a parallel the derivation dropped, so the run
 * belongs to that parallel and not to a base card", and it never fires when
 * the serial reads null. So a title that named a parallel AND a serial minted
 * a NUMBERED BASE row -- the exact defect CF-NUMBERED-BASE-IS-CHECKLIST-DEFINED
 * exists to stop, arriving through the lexer instead of the rule.
 *
 * The correct boundary is not a list of punctuation, it is "not another digit".
 * `/250` followed by `0` would be `/2500` and a different number; `/250`
 * followed by ANYTHING else -- a bang, a star, an emoji, a bracket, a letter --
 * is still the serial 250. `\D` would reject a serial at end-of-string, so the
 * class is spelled as end-or-non-digit. It cannot widen the MATCH SET in the
 * dangerous direction: a longer digit run still binds greedily to \d{1,5}
 * first, and the year guard (19xx/20xx denominators are dates, not runs) is
 * unchanged and still applied by both callers.
 */
const SERIAL_TAIL = String.raw`(?=$|\D)`;

/**
 * The print run the title states, or null. Used by the IMPROVE guard to tell a
 * fill the title SUPPORTS from one it does not.
 */
function serialFromTitle(title) {
  const t = lower(title);
  const YEARISH = /^(19|20)\d{2}$/;
  const numbered = t.match(new RegExp(String.raw`(?:^|[\s(\[#])(\d{1,5})\s*\/\s*(\d{1,5})` + SERIAL_TAIL));
  if (numbered && !YEARISH.test(numbered[2])) return Number(numbered[2]);
  // bare `/N` and the `#/N` spelling -- `#` is a lead-in, not a digit holder.
  const bare = t.match(new RegExp(String.raw`(?:^|[\s(\[]|#)\s*\/\s*(\d{1,5})` + SERIAL_TAIL));
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

  // The title's words, plus the hyphen-split parts of any compound. This is
  // the candidate key set for the phrase index AND the token walk below --
  // computed once instead of twice.
  const words = titleWords(t);
  const keys = [];
  for (const w of words) {
    keys.push(w);
    if (w.includes("-")) for (const part of w.split("-")) if (part) keys.push(part);
  }

  // PHRASES, through the rarest-word index rather than 16,187 fresh regexes.
  // A phrase matches only where EVERY one of its words is present, so a title
  // that matches necessarily opens its anchor bucket -- the same phrases the
  // linear scan would have matched, and no others. See buildPhraseIndex.
  if (phraseIndexMatches(vocab.phraseIndex, t, keys)) return true;

  for (const w of words) {
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

/**
 * DOES THIS PRODUCT'S CHECKLIST DEFINE A NUMBERED BASE CARD AT THIS PRINT RUN?
 *
 * CF-NUMBERED-BASE-IS-CHECKLIST-DEFINED (Drew's ruling), asked the way the
 * ruling states it (second audit gate, leak 7). The guard it replaces asked
 * `checklistListsParallel("Base", year, setKey)`, which is a TOKEN-membership
 * test -- and `base` is a token of every product's checklist, so it answered
 * true for every product and the refusal never fired. 13 IMPROVE lines in
 * shards 16-31 minted a numbered base through that hole.
 *
 * A numbered base is a CARD: a Base row WITH that print run on it. The corpus
 * carries `printRun` per parallel row, so the question is answerable directly.
 * Absent the evidence, blank stays blank -- absent beats wrong.
 */
function checklistDefinesNumberedBase(year, setKey, printRun) {
  const run = Number(printRun);
  if (!Number.isFinite(run) || run <= 0) return false;
  const c = corpus();
  const runs = c.baseRunsByProduct.get(productKey(year, setKey));
  return !!runs && runs.has(run);
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
  STOPWORD_EXCEPTION_ELIGIBLE,
  HAND_STOPWORD_EXCEPTIONS, HAND_STOPWORD_EXCEPTION_CEILING,
  buildVocabulary, vocabularyFor, vocabularyStats, isProductWord, setKeyTokens,
  buildPhraseIndex, phraseIndexMatches,
  titleNamesFinish, titleStatesSerial, serialFromTitle, checklistListsParallel,
  productKey, nameTokens, titleWords, _reset,
  // ---- the audit-gate leak fixes (2026-09-03) ----
  // leak 1: the derived parallel must carry every finish family the title names
  FINISH_FAMILY_TOKENS, FAMILY_ALIASES, SERIAL_TAIL,
  titleFinishFamilyTokens, parallelFinishFamilyTokens,
  familyTokensDroppedByDerivation, checklistParallelNamesFor,
  checklistParallelForFamily,
  // leaks 2 + 6: a lot or a range never mints a cardNumber
  isLotOrRangeListing, cardNumberRangeFromTitle,
  // leak 7: a numbered base is checklist-defined AT ITS PRINT RUN
  BASE_ROW_NAMES, checklistDefinesNumberedBase,
  // leak 3: a misspelled long finish word still DISQUALIFIES an eviction
  NEAR_MISS_MIN_LEN, editDistanceAtMost1, titleNearMissesFinish, nearMissVocabulary,
};
