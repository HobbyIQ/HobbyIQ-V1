// CF-EBAY-TITLE-PARSER (2026-07-12, Drew — scope 3 followup PR).
//
// Deterministic token-match extractor for eBay listing titles. Pulls
// year, playerName, setName, parallel, cardNumber, grade, gradeCompany,
// and isRookie; returns a parseConfidence in [0.0, 1.0] the caller uses
// to decide whether to auto-create a holding (≥0.70), mark for review
// (0.40–0.69), or skip (<0.40).
//
// PURE FUNCTION: no network, no LLM. Extends the token dictionaries
// (BRAND_TOKENS, INSERT_TOKENS, PARALLEL_TOKENS) as new patterns appear
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

/** Parallels (colors, named finishes) */
const PARALLEL_TOKENS: readonly string[] = [
  "refractor",
  "x-fractor",
  "xfractor",
  "silver",
  "gold",
  "black",
  "red",
  "blue",
  "green",
  "purple",
  "orange",
  "pink",
  "yellow",
  "aqua",
  "teal",
  "camo",
  "rainbow",
  "padparadscha",
  "speckle",
  "wave",
  "raywave",
  "fusion",
  "cracked ice",
  "ice",
  "hyper",
  "mojo",
  "shock",
  "shimmer",
  "prizmatic",
  "lava",
  "onyx",
];

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
  const parallelToken = firstMatchFromList(normalized, PARALLEL_TOKENS);
  let parallel: string | null = parallelToken ? capitalize(parallelToken) : null;
  if (!parallel) {
    // Serial marker without a named parallel → "Numbered"
    if (SERIAL_RE.test(raw)) parallel = "Numbered";
  }

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
    parallelToken,
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
    parseConfidence: 0,
  };
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
  parallelToken: string | null;
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
    [ctx.brand, ctx.insert, ctx.parallelToken]
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
