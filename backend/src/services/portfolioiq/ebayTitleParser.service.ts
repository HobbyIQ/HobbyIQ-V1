// CF-EBAY-TITLE-PARSER (2026-07-12, Drew — scope 3 followup PR).
//
// Deterministic token-match extractor for eBay listing titles. Pulls
// year, playerName, setName, parallel, cardNumber, grade, gradeCompany,
// and isRookie; returns a parseConfidence in [0.0, 1.0] the caller uses
// to decide whether to auto-create a holding (≥0.70), mark for review
// (0.40–0.69), or skip (<0.40).
//
// PURE FUNCTION: no network, no LLM. Extends the token dictionaries
// (BRAND_TOKENS, INSERT_TOKENS, FINISH_VOCAB) as new patterns appear
// in Drew's real eBay data. Not for user-typed queries — that's what
// cardQueryParser.ts handles, on a different lexicon.
//
// Design constraint: the scoring must hit the 5 spec test cases in
// tests/ebayTitleParser.test.ts. If you tweak the weights or penalties,
// re-run those tests and verify they still land in the intended tiers.

// ─── Dictionaries ──────────────────────────────────────────────────────────

/** Major card brand tokens. Whole-word match required. */
const BRAND_TOKENS: readonly string[] = [
  "topps",
  "bowman",
  "panini",
  "donruss",
  "fleer",
  "upper deck",
  "leaf",
  "onyx",
  "score",
  "pinnacle",
  "playoff",
  "tristar",
  "sage",
  "skybox",
  "pacific",
];

/** Insert/sub-brand modifiers (Chrome, Prizm, etc.) */
const INSERT_TOKENS: readonly string[] = [
  "chrome",
  "prizm",
  "optic",
  "mosaic",
  "select",
  "heritage",
  "update",
  "finest",
  "tribute",
  "stadium club",
  "immaculate",
  "national treasures",
  "flawless",
  "contenders",
  "origins",
  "absolute",
  "chronicles",
  "diamond kings",
  "playbook",
  "sapphire",
  "sterling",
  "big league",
  "gypsy queen",
  "allen ginter",
  "gallery",
  "opeechee",
  "draft",
  "prospects",
  "elite",
  "certified",
  "revolution",
  "phoenix",
  "encased",
  "opulence",
  "impeccable",
  "spectra",
  "vertex",
  "obsidian",
  "prime",
  "instant",
  "one and one",
  "bowman's best",
  "bowmans best",
];

// CF-THE-TITLE-COMPOSES-ITS-FINISH (2026-08-29). The parallel is the
// composed, most specific finish the title names, in the pool's spelling.
//
// This used to be ONE token from a flat list, taken in LIST order with
// "refractor" listed before every colour, so
//
//   "2026 Bowman Marconi German Chrome Auto Gold Refractor 1st #/50 Nationals"
//
// parsed as bare "Refractor" and the Gold was lost — a different card. The
// ingest seam (titleOutranksVendorTag.ts) and the pool repair
// (scripts/repair-parallel-from-title.cjs) each grew a "refinement" rule to
// tolerate that. Now every finish word in the title is collected and composed:
//
//   modifiers, in the title's own order  +  Sapphire  +  the family word
//
//   "Gold Refractor"              colour + family
//   "Blue Wave Refractor"         colour + pattern + family
//   "Reptilian Green Refractor"   the title's order IS the name; it is kept
//   "Green Sapphire"              a colour in the Sapphire line
//   "Orange Sapphire Refractor"
//   "Printing Plate Black"        the one family the pool spells colour-LAST
//   "Gold"                        a bare colour stays bare — the canonicalizer
//                                 applies Colour ≡ Refractor per product
//   "X-Fractor"                   a family with no colour stays the family
//
// Nothing is implied: a title that names no finish is null (Base), and
// "Blue Wave" is not promoted to "Blue Wave Refractor" here. The two
// exceptions are market shorthand, not inference: "True Blue" IS "Blue
// Refractor" (card-lingo-glossary §1), and "Ref" IS "Refractor".

type FinishKind = "colour" | "pattern" | "sapphire" | "family";

interface FinishToken {
  /** The pool's spelling. Null = spelled from the match (the open-ended
   *  *fractor family: Logofractor, Packfractor, ...). */
  display: string | null;
  kind: FinishKind;
  /** Regex source; the scanner word-bounds it. Earlier entries claim their
   *  span first, so multi-word tokens precede the words they contain and the
   *  named fractors precede the open-ended one. */
  re: string;
}

const FINISH_VOCAB: readonly FinishToken[] = [
  // Multi-word colours, before the colour they contain.
  { display: "Sky Blue", kind: "colour", re: "sky\\s+blue" },
  { display: "Neon Green", kind: "colour", re: "neon\\s+green" },
  { display: "Rose Gold", kind: "colour", re: "rose\\s+gold" },
  { display: "Hot Pink", kind: "colour", re: "hot\\s+pink" },
  { display: "Royal Blue", kind: "colour", re: "royal\\s+blue" },
  // Multi-word patterns, before the words they contain.
  { display: "Cracked Ice", kind: "pattern", re: "cracked\\s+ice" },
  { display: "RayWave", kind: "pattern", re: "ray[\\s-]?wave" },
  { display: "Tie-Dye", kind: "pattern", re: "tie[\\s-]?dye" },
  // Families. The named fractors first; anything else ending in "fractor"
  // names itself (Topps keeps minting them: Logofractor, Packfractor).
  { display: "SuperFractor", kind: "family", re: "super\\s?fractors?" },
  { display: "X-Fractor", kind: "family", re: "x[\\s-]?fractors?" },
  { display: "Refractor", kind: "family", re: "refractors?|ref\\.?" },
  { display: null, kind: "family", re: "[a-z]+fractors?" },
  { display: "Printing Plate", kind: "family", re: "printing\\s+plates?" },
  { display: "Prizm", kind: "family", re: "prizms?" },
  { display: "Foil", kind: "family", re: "foils?" },
  // The Sapphire line's own family word — "Green Sapphire", "Padparadscha
  // Sapphire", "Orange Sapphire Refractor". Bare, it is the product.
  { display: "Sapphire", kind: "sapphire", re: "sapphire" },
  // Colours.
  { display: "Gold", kind: "colour", re: "gold" },
  { display: "Silver", kind: "colour", re: "silver" },
  { display: "Black", kind: "colour", re: "black" },
  { display: "Red", kind: "colour", re: "red" },
  { display: "Blue", kind: "colour", re: "blue" },
  { display: "Green", kind: "colour", re: "green" },
  { display: "Purple", kind: "colour", re: "purple" },
  { display: "Orange", kind: "colour", re: "orange" },
  { display: "Pink", kind: "colour", re: "pink" },
  { display: "Yellow", kind: "colour", re: "yellow" },
  { display: "Aqua", kind: "colour", re: "aqua" },
  { display: "Teal", kind: "colour", re: "teal" },
  { display: "White", kind: "colour", re: "white" },
  { display: "Sepia", kind: "colour", re: "sepia" },
  { display: "Fuchsia", kind: "colour", re: "fuchsia" },
  { display: "Cyan", kind: "colour", re: "cyan" },
  { display: "Magenta", kind: "colour", re: "magenta" },
  { display: "Padparadscha", kind: "colour", re: "padparadscha" },
  // Patterns / textures (glossary §1: "a visible pattern in the chrome").
  { display: "Wave", kind: "pattern", re: "wave" },
  { display: "Shimmer", kind: "pattern", re: "shimmer" },
  { display: "Speckle", kind: "pattern", re: "speckle" },
  { display: "Lava", kind: "pattern", re: "lava" },
  { display: "Mojo", kind: "pattern", re: "mojo" },
  { display: "Atomic", kind: "pattern", re: "atomic" },
  { display: "Ice", kind: "pattern", re: "ice" },
  { display: "Hyper", kind: "pattern", re: "hyper" },
  { display: "Shock", kind: "pattern", re: "shock" },
  { display: "Fusion", kind: "pattern", re: "fusion" },
  { display: "Prizmatic", kind: "pattern", re: "prizmatic" },
  { display: "Camo", kind: "pattern", re: "camo" },
  { display: "Rainbow", kind: "pattern", re: "rainbow" },
  { display: "Reptilian", kind: "pattern", re: "reptilian" },
  { display: "Lazer", kind: "pattern", re: "lazer|laser" },
  { display: "Pulsar", kind: "pattern", re: "pulsar" },
  { display: "Geometric", kind: "pattern", re: "geometric" },
  { display: "Velocity", kind: "pattern", re: "velocity" },
  { display: "Disco", kind: "pattern", re: "disco" },
  { display: "Sparkle", kind: "pattern", re: "sparkle" },
  { display: "Snakeskin", kind: "pattern", re: "snakeskin" },
  { display: "Zebra", kind: "pattern", re: "zebra" },
  { display: "Holo", kind: "pattern", re: "holo" },
];

/**
 * Colour words that are not finishes: team names and colour-named products.
 * Blanked (not removed) before the finish scan so "Blue Jays ... Refractor"
 * cannot compose into a Blue Refractor. Composition made this necessary —
 * the one-token parser happened to pick "refractor" first.
 */
const FINISH_NOISE_RE =
  /\b(blue\s+jays?|red\s+sox|white\s+sox|red\s+wings?|blue\s+jackets?|golden\s+knights?|golden\s+state|red\s+bulls?|green\s+bay|black\s?hawks?|orange\s+bowl|silver\s+slugger|gold\s+glove|gold\s+label|gold\s+standard|black\s+friday|silver\s+pack|topps\s+chrome\s+black|panini\s+black)\b/g;

/** "True Blue" is "Blue Refractor" (glossary §1) — matched anywhere in the
 *  title, since sellers write "True Blue" and "Blue ... True" both. */
const TRUE_RE = /\btrue\b/;

/** Grade-cert regex per company. Case-insensitive. Order matters (longer first). */
const GRADE_PATTERNS: readonly RegExp[] = [
  /\b(psa)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i,
  /\b(bgs)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i,
  /\b(sgc)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i,
  /\b(cgc)\s*(10|9\.5|9|8\.5|8|7|6|5|4|3|2|1)\b/i,
];

/** Rookie signal words. */
const ROOKIE_MARKERS = /\b(rc|rookie|1st\s+bowman|1st|rookie\s+card|first\s+bowman)\b/i;

/**
 * Autograph signal — "AUTO", "AUTOGRAPH(ED)", "SIGNED", "SIGNATURE" as whole
 * words. Deliberately conservative (word-bounded) so we don't match "automatic"
 * or product tokens like "AUTOMATIC" that could show up in stray descriptions.
 * Also matches the common "1st Bowman Auto" / "Rookie Auto" tail patterns.
 */
const AUTO_MARKERS = /\b(autos?|autographs?|autographed|signed|signatures?)\b/i;
/**
 * Card-number code patterns that imply an autograph — the code prefix itself
 * signals the auto insert (CPA-, BCPA-, TCRA-, TRA-, TEK-, USA-, HSA-, etc.).
 * We only trust this when the code was actually extracted upstream.
 */
const AUTO_CARD_NUMBER_PREFIXES = new Set([
  "CPA", "BCPA", "BDPA", "BDA", "CDA", "CPAR", "TCRA", "TRA",
  "FCA", "TEK", "BCA", "HSA", "RRA", "PRV", "USA", "TCA", "BCRA",
]);

/**
 * Card number patterns — try in order:
 *  1. `#` or `No.` prefix followed by any alphanumeric-plus-dash chunk
 *  2. Recognized auto/prospect code prefix WITHOUT `#` (BCP-, CPA-, US###, TEK-, etc.)
 * The scorer treats this as a small confidence bump, not a load-bearing key,
 * so we prefer false-negatives over false-positives (e.g., we do NOT match
 * bare 3-digit numbers or common words that happen to have digits).
 */
const CARD_NUMBER_PREFIXED_RE = /(?:#|\bno\.\s*)([a-z]{0,4}-?\d{1,4}[a-z]?-?[a-z0-9]{0,6})/i;
/**
 * Generic coded card number: 2-5 uppercase letters immediately followed by
 * either (a) 2-5 digits (like HTU89, US175, USC35) or (b) a dash + 1-10
 * alphanumerics (like BCP-16, CPA-CBO, TCRA-DT). Word-bounded to avoid
 * false-positive matches inside longer words.
 */
const CARD_NUMBER_CODED_RE = /\b([A-Z]{2,5}(?:\d{2,5}|-[A-Z0-9]{1,10}))\b/i;

/** Year token. 1950 through 2029 (updated as needed for far-future years). */
const YEAR_RE = /\b(19[5-9]\d|20[0-2]\d)\b/;

/** Serial-number-numbered-parallel marker like /150, /25, 1/1, etc. */
const SERIAL_RE = /\/(\d{1,4})|\b(\d)\/(\d)\b/;

// ─── Print run ─────────────────────────────────────────────────────────────
// "#/50", "/50", "14/50", "#'d /50", "numbered to 50", "1/1", "one of one".
// A grade written as a fraction ("PSA 9/10", "PSA 10/9", "PSA/9") is not a
// print run and is blanked first; both sides must be grade-shaped so that
// "PSA 10 /50" still reads /50. Runs above 5000 are years or noise.
const GRADE_SHAPE = "(?:10|[1-9])(?:\\.5)?";
const GRADE_FRACTION_RE = new RegExp(
  `\\b(?:psa|bgs|sgc|cgc|hga|tag|ace)\\s*\\/?\\s*${GRADE_SHAPE}\\s*\\/\\s*${GRADE_SHAPE}(?![0-9])`, "gi");
const GRADE_SLASH_RE = new RegExp(`\\b(?:psa|bgs|sgc|cgc|hga|tag|ace)\\s*\\/\\s*${GRADE_SHAPE}(?![0-9])`, "gi");
const ONE_OF_ONE_RE = /\b(?:one\s+of\s+one|1\s+of\s+1)\b/i;
const NUMBERED_TO_RE = /(?<![a-z0-9])(?:numbered|#['’]?d|serial(?:ly)?(?:\s+numbered)?)\s*(?:to|out\s+of|\/)\s*#?\s*(\d{1,4})(?![0-9])/i;
const SERIAL_FRACTION_RE = /(?:^|[^0-9])(\d{1,4})\s*\/\s*(\d{1,4})(?![0-9])/;
const SERIAL_SLASH_RE = /\/\s*(\d{1,4})(?![0-9])/;
const MAX_PRINT_RUN = 5000;

/**
 * Marketing garbage / non-name tokens the player-name extractor should
 * ignore even if they'd otherwise pass the proper-noun-shape test.
 */
const IGNORE_TOKENS = new Set([
  "base",
  "lot",
  "must",
  "see",
  "wow",
  "nm",
  "mt",
  "gem",
  "mint",
  "sharp",
  "clean",
  "l@@k",
  "look",
  "rc",
  "rookie",
  "card",
  "1st",
  "first",
  "auto",
  "autograph",
  "autographed",
  "signed",
  "signature",
  "prospect",
  "prospects",
  "rare",
  "hot",
  "hobby",
  "jumbo",
  "random",
  "team",
  "hobbyist",
  "penny",
  "sleeves",
  "top",
  "loaders",
  "loader",
  "of",
  "and",
  "the",
  "a",
  "an",
  "with",
  "for",
  "from",
  "each",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "hundred",
  "thousand",
  "case",
  "box",
  "pack",
  "cards",
  "series",
  "set",
]);

/** Suffixes commonly appended to player names — must not be filtered. */
const NAME_SUFFIX_TOKENS = new Set(["jr", "sr", "ii", "iii", "iv"]);

// ─── Public API ────────────────────────────────────────────────────────────

export interface ParsedListingTitle {
  year: number | null;
  playerName: string | null;
  setName: string | null;
  parallel: string | null;
  cardNumber: string | null;
  grade: string | null;
  gradeCompany: "PSA" | "BGS" | "SGC" | "CGC" | null;
  isRookie: boolean;
  /** CF-EBAY-AUTO-DETECTION (2026-07-12) — true when the listing title
   *  contains AUTO/AUTOGRAPHED/SIGNED/SIGNATURE as a whole word, OR when
   *  the extracted card number's letter prefix is a known auto insert
   *  code (CPA-, BCPA-, TCRA-, TRA-, TEK-, HSA-, RRA-, PRV-, USA-, etc.). */
  isAuto: boolean;
  /** CF-THE-TITLE-COMPOSES-ITS-FINISH (2026-08-29) — the serial print run
   *  the title states ("/50", "14/50", "#'d /50", "numbered to 50", "1/1").
   *  Null when the title states none. Optional so existing callers that
   *  build this shape by hand keep compiling. */
  printRun?: number | null;
  /** [0.0, 1.0]. See scoreParse() for weights. */
  parseConfidence: number;
}

const CURRENT_YEAR = new Date().getUTCFullYear();

export function parseListingTitle(input: string | null | undefined): ParsedListingTitle {
  const raw = String(input ?? "").trim();
  if (!raw) return emptyResult();

  // ─── Year ────────────────────────────────────────────────────────────
  const yearMatch = raw.match(YEAR_RE);
  const yearNum = yearMatch ? Number(yearMatch[1]) : null;
  const year = yearNum !== null && yearNum >= 1950 && yearNum <= CURRENT_YEAR ? yearNum : null;

  // ─── Grade ───────────────────────────────────────────────────────────
  let grade: string | null = null;
  let gradeCompany: ParsedListingTitle["gradeCompany"] = null;
  for (const pattern of GRADE_PATTERNS) {
    const m = raw.match(pattern);
    if (m) {
      gradeCompany = m[1].toUpperCase() as ParsedListingTitle["gradeCompany"];
      grade = `${gradeCompany} ${m[2]}`;
      break;
    }
  }

  // ─── Card number ─────────────────────────────────────────────────────
  const prefixedMatch = raw.match(CARD_NUMBER_PREFIXED_RE);
  const codedMatch = raw.match(CARD_NUMBER_CODED_RE);
  const cardNumber = prefixedMatch
    ? prefixedMatch[1].toUpperCase()
    : codedMatch
    ? codedMatch[1].toUpperCase()
    : null;

  // ─── Set (brand + insert) ────────────────────────────────────────────
  const normalized = raw.toLowerCase();
  const brand = firstMatchFromList(normalized, BRAND_TOKENS);
  const insert = firstMatchFromList(normalized, INSERT_TOKENS);
  const setName = buildSetName(brand, insert);

  // ─── Parallel ────────────────────────────────────────────────────────
  const finish = composeParallel(normalized);
  let parallel: string | null = finish.parallel;
  if (!parallel) {
    // Serial marker without a named parallel → "Numbered"
    if (SERIAL_RE.test(raw)) parallel = "Numbered";
  }

  // ─── Print run ───────────────────────────────────────────────────────
  const printRun = extractPrintRun(raw);

  // ─── Rookie ──────────────────────────────────────────────────────────
  const isRookie = ROOKIE_MARKERS.test(raw);

  // ─── Autograph ───────────────────────────────────────────────────────
  const cardCodePrefix = cardNumber ? cardNumber.split(/[\d-]/, 1)[0].toUpperCase() : "";
  const isAuto =
    AUTO_MARKERS.test(raw) ||
    (cardCodePrefix.length > 0 && AUTO_CARD_NUMBER_PREFIXES.has(cardCodePrefix));

  // ─── Player name ─────────────────────────────────────────────────────
  const playerName = extractPlayerName(raw, {
    year,
    setName: setName ?? "",
    brand,
    insert,
    parallelWords: finish.words,
    grade,
    cardNumber,
  });

  // ─── Score ───────────────────────────────────────────────────────────
  const parseConfidence = scoreParse({
    year,
    playerName,
    brand,
    insert,
    grade,
    cardNumber,
    isRookie,
    isAuto,
    raw,
  });

  return {
    year,
    playerName,
    setName,
    parallel,
    cardNumber,
    grade,
    gradeCompany,
    isRookie,
    isAuto,
    printRun,
    parseConfidence,
  };
}

// ─── Internals ─────────────────────────────────────────────────────────────

function emptyResult(): ParsedListingTitle {
  return {
    year: null,
    playerName: null,
    setName: null,
    parallel: null,
    cardNumber: null,
    grade: null,
    gradeCompany: null,
    isRookie: false,
    isAuto: false,
    printRun: null,
    parseConfidence: 0,
  };
}

interface FinishHit {
  index: number;
  /** The matched title text, lowercased — excluded from player-name candidates. */
  text: string;
  display: string;
  kind: FinishKind;
}

/**
 * Every finish word in the (lowercased) title, in title order. Each vocab
 * entry claims its span in FINISH_VOCAB order, so "cracked ice" is one hit
 * and never also "ice", and "superfractor" is never also the open-ended
 * "*fractor". Team and product colour words are blanked first.
 */
function scanFinishTokens(normalized: string): FinishHit[] {
  const scan = normalized.replace(FINISH_NOISE_RE, (m) => " ".repeat(m.length));
  const taken = new Uint8Array(scan.length);
  const hits: FinishHit[] = [];
  for (const tok of FINISH_VOCAB) {
    const re = new RegExp(`\\b(?:${tok.re})(?![a-z0-9])`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      let free = true;
      for (let i = start; i < end; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      for (let i = start; i < end; i++) taken[i] = 1;
      hits.push({ index: start, text: m[0], display: tok.display ?? spellFractor(m[0]), kind: tok.kind });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** "logofractors" → "Logofractor": the open-ended family names itself. */
function spellFractor(text: string): string {
  const w = text.toLowerCase().replace(/s$/, "");
  return w[0].toUpperCase() + w.slice(1);
}

/**
 * The composition rule (see CF-THE-TITLE-COMPOSES-ITS-FINISH above):
 * modifiers in title order, then Sapphire when a colour accompanies it, then
 * ONE family word. Also returns the title words consumed, so the player-name
 * extractor never reads "Gold" or "Wave" as a name.
 */
function composeParallel(normalized: string): { parallel: string | null; words: string[] } {
  const hits = scanFinishTokens(normalized);
  const modifiers: string[] = [];
  const families: string[] = [];
  let hasColour = false;
  let hasSapphire = false;
  for (const h of hits) {
    if (h.kind === "sapphire") { hasSapphire = true; continue; }
    if (h.kind === "family") { if (!families.includes(h.display)) families.push(h.display); continue; }
    if (h.kind === "colour") hasColour = true;
    if (!modifiers.includes(h.display)) modifiers.push(h.display);
  }
  const words = hits.flatMap((h) => h.text.split(/\s+/));

  // "Prizm" is also the product's name: a finish only with a modifier
  // ("Silver Prizm", "Blue Ice Prizm"), never bare.
  let candidates = modifiers.length > 0 ? families : families.filter((f) => f !== "Prizm");
  // Two family words ("Sapphire X-Fractor Refractor"): the plain Refractor is
  // the generic one and yields to the specific.
  if (candidates.length > 1) candidates = candidates.filter((f) => f !== "Refractor");
  let family: string | null = candidates[0] ?? null;

  // "True Blue" is market shorthand for "Blue Refractor" (glossary §1). Only
  // fills a MISSING family — "True Blue Shimmer Refractor" already has one.
  if (!family && hasColour && TRUE_RE.test(normalized)) {
    family = "Refractor";
    words.push("true");
  }

  const sapphire = hasSapphire && hasColour ? ["Sapphire"] : [];
  const parts = family === "Printing Plate"
    ? ["Printing Plate", ...modifiers]              // "Printing Plate Black"
    : [...modifiers, ...sapphire, ...(family ? [family] : [])];
  return { parallel: parts.length > 0 ? parts.join(" ") : null, words };
}

function extractPrintRun(raw: string): number | null {
  const t = raw.replace(GRADE_FRACTION_RE, " ").replace(GRADE_SLASH_RE, " ");
  if (ONE_OF_ONE_RE.test(t)) return 1;
  const stated = t.match(NUMBERED_TO_RE);
  if (stated) return printRunInRange(Number(stated[1]));
  const fraction = t.match(SERIAL_FRACTION_RE);
  if (fraction) {
    // "14/50" → 50. A copy number above its run ("2024/25") is not a serial.
    const copy = Number(fraction[1]);
    const run = Number(fraction[2]);
    return copy >= 1 && copy <= run ? printRunInRange(run) : null;
  }
  const slash = t.match(SERIAL_SLASH_RE);
  if (slash) return printRunInRange(Number(slash[1]));
  return null;
}

function printRunInRange(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= MAX_PRINT_RUN ? n : null;
}

/**
 * Whole-word / word-boundary match. Multi-word tokens (like "upper deck")
 * are matched as a phrase. Returns the first hit in list order.
 */
function firstMatchFromList(normalized: string, list: readonly string[]): string | null {
  for (const token of list) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundary at start; end allows possessive/plural but tokens here
    // don't need that flexibility so plain \b.
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(normalized)) return token;
  }
  return null;
}

function capitalize(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function buildSetName(brand: string | null, insert: string | null): string | null {
  if (brand && insert) return `${capitalize(brand)} ${capitalize(insert)}`;
  if (brand) return capitalize(brand);
  if (insert) return capitalize(insert);
  return null;
}

interface ExtractContext {
  year: number | null;
  setName: string;
  brand: string | null;
  insert: string | null;
  /** Every title word the finish scan consumed ("gold", "refractor", ...). */
  parallelWords: string[];
  grade: string | null;
  cardNumber: string | null;
}

/**
 * Look for a run of 2-4 consecutive Proper-Noun-shaped tokens that AREN'T
 * in the set / parallel / marketing dictionaries. Handles all-caps too.
 * Suffixes (Jr, Sr, II) are attached to a preceding name.
 */
function extractPlayerName(raw: string, ctx: ExtractContext): string | null {
  // 1. Strip known metadata tokens so what remains is candidate player
  //    tokens + noise.
  let stripped = raw;
  if (ctx.year !== null) stripped = stripped.replace(new RegExp(`\\b${ctx.year}\\b`, "g"), " ");
  if (ctx.grade) stripped = stripped.replace(new RegExp(ctx.grade.replace(/\./g, "\\."), "gi"), " ");
  if (ctx.cardNumber) stripped = stripped.replace(new RegExp(`#?\\b${ctx.cardNumber}\\b`, "gi"), " ");
  // Strip serial patterns like /150, 1/1
  stripped = stripped.replace(/\/\d{1,4}/g, " ").replace(/\b\d\/\d\b/g, " ");
  // Strip parentheticals (uncertain markers like "(RC?)")
  stripped = stripped.replace(/\([^)]*\)/g, " ");
  // Strip emoji + special characters
  stripped = stripped.replace(/[^A-Za-z\s.'-]/g, " ");
  // Collapse whitespace
  stripped = stripped.replace(/\s+/g, " ").trim();

  // 2. Tokenize
  const rawTokens = stripped.split(/\s+/).filter((t) => t.length > 0);

  // 3. Filter to candidate name tokens (Proper Noun shape, not in ignore list,
  //    not a set/parallel/insert token). Preserve suffixes as attach-only.
  const setPartsLower = new Set(
    [ctx.brand, ctx.insert, ...ctx.parallelWords]
      .filter((v): v is string => !!v)
      .flatMap((s) => s.split(" ")),
  );
  const IGNORE_ALL = new Set(IGNORE_TOKENS);

  interface Candidate {
    token: string;
    isSuffix: boolean;
    /** True if token started with a capital letter or was all-caps. */
    properShape: boolean;
    ignored: boolean;
  }
  const candidates: Candidate[] = rawTokens.map((t) => {
    const cleaned = t.replace(/[.']/g, ""); // "Jr." → "Jr", "O'Neill" → "ONeill"
    const lower = cleaned.toLowerCase();
    const isSuffix = NAME_SUFFIX_TOKENS.has(lower);
    // Proper shape: starts uppercase OR entire token all-caps (min 2 chars)
    const properShape =
      /^[A-Z][a-zA-Z]+$/.test(cleaned) || /^[A-Z]{2,}$/.test(cleaned);
    const ignored = IGNORE_ALL.has(lower) || setPartsLower.has(lower);
    return { token: cleaned, isSuffix, properShape, ignored };
  });

  // 4. Find longest run of consecutive (proper-shape AND !ignored) tokens.
  //    Suffix tokens are appended to a run in progress.
  let bestRun: string[] = [];
  let currentRun: string[] = [];
  const flush = () => {
    // Strip trailing single-char tokens (e.g., stray "S" from a set brand)
    while (currentRun.length && currentRun[currentRun.length - 1].length <= 1) {
      currentRun.pop();
    }
    // Bound the run at 4 tokens max — anything longer is likely noise.
    if (currentRun.length > 4) currentRun = currentRun.slice(0, 4);
    if (currentRun.length >= 2 && currentRun.length > bestRun.length) {
      bestRun = [...currentRun];
    }
    currentRun = [];
  };
  for (const c of candidates) {
    if (c.ignored) {
      flush();
      continue;
    }
    if (c.isSuffix && currentRun.length > 0) {
      currentRun.push(c.token);
      continue;
    }
    if (c.properShape) {
      currentRun.push(c.token);
    } else {
      flush();
    }
  }
  flush();

  if (bestRun.length < 2) return null;

  // 5. Title-case the run
  return bestRun.map(titleCaseName).join(" ");
}

function titleCaseName(s: string): string {
  if (s.length === 0) return s;
  if (NAME_SUFFIX_TOKENS.has(s.toLowerCase())) {
    return s.toLowerCase() === "jr" || s.toLowerCase() === "sr"
      ? s[0].toUpperCase() + s.slice(1, 2).toLowerCase() + "."
      : s.toUpperCase();
  }
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Confidence scoring ────────────────────────────────────────────────────

interface ScoreInput {
  year: number | null;
  playerName: string | null;
  brand: string | null;
  insert: string | null;
  grade: string | null;
  cardNumber: string | null;
  isRookie: boolean;
  isAuto: boolean;
  raw: string;
}

/**
 * Base weights per the CF-EBAY-TITLE-PARSER spec:
 *   year:        +0.25
 *   playerName:  +0.30
 *   brand:       +0.10  (part of setName)
 *   insert:      +0.10  (part of setName)
 *   brand+insert combo bonus: +0.05
 *   grade:       +0.15
 *   cardNumber:  +0.10
 *   isRookie:    +0.05
 *
 * Penalties (multiplicative):
 *   `?` anywhere in raw title    → × 0.6 (question mark = uncertainty)
 *   Leading "base" prefix         → × 0.7 (indicates listing uncertainty
 *                                          about tier / variant)
 *
 * Cap at 1.0.
 */
function scoreParse(input: ScoreInput): number {
  let score = 0;
  if (input.year !== null) score += 0.25;
  if (input.playerName) score += 0.3;
  if (input.brand) score += 0.1;
  if (input.insert) score += 0.1;
  if (input.brand && input.insert) score += 0.05;
  if (input.grade) score += 0.15;
  if (input.cardNumber) score += 0.1;
  if (input.isRookie) score += 0.05;
  // CF-EBAY-AUTO-DETECTION (2026-07-12): small bump when autograph
  // detected. Keeps overall score at cap 1.0.
  if (input.isAuto) score += 0.05;

  // Penalties
  if (input.raw.includes("?")) score *= 0.6;
  if (/^\s*base\b/i.test(input.raw)) score *= 0.7;

  score = Math.min(1.0, score);
  return Math.round(score * 100) / 100;
}
