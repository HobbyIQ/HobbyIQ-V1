// ---------------------------------------------------------------------------
// cardQueryParser.ts
//
// Converts free-text card descriptions (e.g. "2024 bowman blue auto Caleb
// Bonemer", "PSA 10 2011 Topps Update Mike Trout") into a structured
// ParsedCardQuery. This MUST run before the comp search so the search query
// can be built with the correct year + brand + parallel + auto-flag, and so
// post-fetch comps can be filtered out when they don't match the requested
// variant.
//
// All three functions are pure, synchronous, and side-effect free.
// ---------------------------------------------------------------------------

export interface ParsedCardQuery {
  playerName: string | null;
  year: number | null;
  brand: string | null;          // "Bowman" | "Topps" | "Panini" etc
  set: string | null;            // "Bowman Draft" | "Bowman Chrome" etc
  parallel: string | null;       // "Blue" | "Sky Blue" | "Gold" | "Refractor" etc
  isAuto: boolean;               // true if "auto" or "autograph" detected
  isPatch: boolean;              // true if "patch" or "rpa" detected
  isRookie: boolean;             // true if "rc" or "rookie" detected
  printRun: number | null;       // 499, 25, 10 etc from "/499" or "#/25"
  cardNumber: string | null;     // "BD-31" or "31" etc
  grade: string | null;          // "10" | "9.5" | "raw" etc
  gradingCompany: string | null; // "PSA" | "BGS" | "SGC" etc
  confidence: number;            // 0-1, how confident the parse is
  rawQuery: string;              // original input preserved
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// parseCardQuery
// ---------------------------------------------------------------------------
export function parseCardQuery(input: string): ParsedCardQuery {
  const text = (input ?? "").trim();

  // --- YEAR ---
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

  // --- BRAND + SET --- (more specific first)
  const SET_PATTERNS: [RegExp, string, string][] = [
    [/bowman\s+chrome\s+draft/i, "Bowman", "Bowman Chrome Draft"],
    [/bowman\s+draft\s+chrome/i, "Bowman", "Bowman Draft Chrome"],
    [/bowman\s+chrome/i, "Bowman", "Bowman Chrome"],
    [/bowman\s+draft/i, "Bowman", "Bowman Draft"],
    [/bowman\s+platinum/i, "Bowman", "Bowman Platinum"],
    [/bowman/i, "Bowman", "Bowman"],
    [/topps\s+chrome\s+update/i, "Topps", "Topps Chrome Update"],
    [/topps\s+chrome/i, "Topps", "Topps Chrome"],
    [/topps\s+update/i, "Topps", "Topps Update"],
    [/topps\s+heritage/i, "Topps", "Topps Heritage"],
    [/topps\s+finest/i, "Topps", "Topps Finest"],
    [/topps\s+stadium\s+club/i, "Topps", "Topps Stadium Club"],
    [/topps\s+series\s+[12]/i, "Topps", "Topps Series"],
    [/topps/i, "Topps", "Topps"],
    [/panini\s+prizm\s+draft\s+picks/i, "Panini", "Panini Prizm Draft Picks"],
    [/panini\s+prizm/i, "Panini", "Panini Prizm"],
    [/prizm\s+draft\s+picks/i, "Panini", "Panini Prizm Draft Picks"],
    [/prizm/i, "Panini", "Panini Prizm"],
    [/donruss\s+optic/i, "Panini", "Donruss Optic"],
    [/optic/i, "Panini", "Donruss Optic"],
    [/panini\s+donruss/i, "Panini", "Panini Donruss"],
    [/donruss\s+elite\s+extra\s+edition/i, "Panini", "Panini Elite Extra Edition"],
    [/donruss\s+elite/i, "Panini", "Donruss Elite"],
    [/donruss/i, "Panini", "Panini Donruss"],
    [/panini\s+select/i, "Panini", "Panini Select"],
    [/select/i, "Panini", "Panini Select"],
    [/panini\s+contenders/i, "Panini", "Panini Contenders"],
    [/contenders/i, "Panini", "Panini Contenders"],
    [/panini\s+national\s+treasures/i, "Panini", "Panini National Treasures"],
    [/national\s+treasures/i, "Panini", "Panini National Treasures"],
    [/panini\s+flawless/i, "Panini", "Panini Flawless"],
    [/flawless/i, "Panini", "Panini Flawless"],
    [/panini\s+immaculate/i, "Panini", "Panini Immaculate"],
    [/immaculate/i, "Panini", "Panini Immaculate"],
    [/panini\s+impeccable/i, "Panini", "Panini Impeccable"],
    [/impeccable/i, "Panini", "Panini Impeccable"],
    // CF-NO-NULL-PRICING FOLLOWUP (2026-07-11): modern Panini brands
    // the parser didn't recognize — smoke test at prod confirmed
    // "2024 Panini Origins ..." was falling into playerName because
    // "Panini Origins" had no pattern. Adds all products the reference-
    // catalog SetDoc container carries.
    [/panini\s+origins/i, "Panini", "Panini Origins"],
    [/panini\s+absolute/i, "Panini", "Panini Absolute"],
    [/panini\s+playbook/i, "Panini", "Panini Playbook"],
    [/panini\s+three\s+and\s+two/i, "Panini", "Panini Three and Two"],
    [/panini\s+prospect\s+edition/i, "Panini", "Panini Prospect Edition"],
    [/panini\s+usa\s+baseball|panini\s+stars\s+\&?\s*stripes/i, "Panini", "Panini USA Baseball Stars & Stripes"],
    [/panini\s+chronicles/i, "Panini", "Panini Chronicles"],
    [/chronicles/i, "Panini", "Panini Chronicles"],
    [/panini\s+mosaic/i, "Panini", "Panini Mosaic"],
    [/mosaic/i, "Panini", "Panini Mosaic"],
    [/panini\s+diamond\s+kings/i, "Panini", "Panini Diamond Kings"],
    [/diamond\s+kings/i, "Panini", "Panini Diamond Kings"],
    // Historic brands / third-party
    [/onyx\s+vintage/i, "Onyx", "Onyx Vintage"],
    [/onyx/i, "Onyx", "Onyx"],
    [/leaf\s+metal\s+draft/i, "Leaf", "Leaf Metal Draft"],
    [/leaf\s+metal/i, "Leaf", "Leaf Metal"],
    [/leaf\s+trinity/i, "Leaf", "Leaf Trinity"],
    [/leaf\s+signature/i, "Leaf", "Leaf Signature Series"],
    [/tristar/i, "TRISTAR", "TRISTAR"],
    [/sage\s+hit/i, "SAGE", "SAGE Hit"],
    [/sage/i, "SAGE", "SAGE"],
    // Fleer sub-brands
    [/fleer\s+ultra/i, "Fleer", "Fleer Ultra"],
    [/fleer\s+ex/i, "Fleer", "Fleer EX"],
    [/fleer\s+metal\s+universe/i, "Fleer", "Fleer Metal Universe"],
    [/fleer\s+tradition/i, "Fleer", "Fleer Tradition"],
    [/fleer\s+genuine/i, "Fleer", "Fleer Genuine"],
    [/fleer/i, "Fleer", "Fleer"],
    // Skybox
    [/skybox\s+e[-\s]?x/i, "Skybox", "Skybox EX"],
    [/skybox\s+metal/i, "Skybox", "Skybox Metal Universe"],
    [/skybox/i, "Skybox", "Skybox Premium"],
    // Upper Deck sub-brands
    [/upper\s+deck\s+spx/i, "Upper Deck", "Upper Deck SPX"],
    [/upper\s+deck\s+sp/i, "Upper Deck", "Upper Deck SP"],
    [/upper\s+deck\s+ultimate/i, "Upper Deck", "Upper Deck Ultimate"],
    [/upper\s+deck/i, "Upper Deck", "Upper Deck"],
    // Pacific line
    [/pacific\s+crown\s+royale/i, "Pacific", "Pacific Crown Royale"],
    [/pacific\s+invincible/i, "Pacific", "Pacific Invincible"],
    [/pacific\s+omega/i, "Pacific", "Pacific Omega"],
    [/pacific\s+paramount/i, "Pacific", "Pacific Paramount"],
    [/pacific/i, "Pacific", "Pacific"],
    // Score / Pinnacle
    [/score/i, "Score", "Score"],
    [/pinnacle/i, "Pinnacle", "Pinnacle"],
    // Playoff
    [/playoff\s+absolute/i, "Playoff", "Playoff Absolute"],
    [/playoff\s+honors/i, "Playoff", "Playoff Honors"],
    [/playoff/i, "Playoff", "Playoff"],
    // Studio
    [/studio/i, "Donruss", "Donruss Studio"],
  ];
  let brand: string | null = null;
  let set: string | null = null;
  for (const [pattern, b, s] of SET_PATTERNS) {
    if (pattern.test(text)) { brand = b; set = s; break; }
  }

  // --- PARALLEL --- (multi-word first so "blue" doesn't beat "sky blue")
  const PARALLEL_PATTERNS: [RegExp, string][] = [
    [/black\s+label/i, "Black Label"],
    [/sky\s+blue/i, "Sky Blue"],
    [/dark\s+blue/i, "Dark Blue"],
    [/ice\s+blue/i, "Ice Blue"],
    [/royal\s+blue/i, "Royal Blue"],
    [/neon\s+green/i, "Neon Green"],
    // Wave parallels — match COLOR+wave BEFORE plain wave so "Blue Wave Refractor"
    // doesn't get downgraded to just "Wave Refractor".
    [/blue\s+wave\s+refractor/i, "Blue Wave Refractor"],
    [/gold\s+wave\s+refractor/i, "Gold Wave Refractor"],
    [/black\s+wave\s+refractor/i, "Black Wave Refractor"],
    [/red\s+wave\s+refractor/i, "Red Wave Refractor"],
    [/green\s+wave\s+refractor/i, "Green Wave Refractor"],
    [/orange\s+wave\s+refractor/i, "Orange Wave Refractor"],
    [/purple\s+wave\s+refractor/i, "Purple Wave Refractor"],
    [/pink\s+wave\s+refractor/i, "Pink Wave Refractor"],
    [/wave\s+refractor/i, "Wave Refractor"],
    // Color+wave (no "refractor" suffix) — must precede plain color matches
    // so "Blue Wave Auto" doesn't degrade to just "Blue".
    [/blue\s+wave/i, "Blue Wave"],
    [/gold\s+wave/i, "Gold Wave"],
    [/black\s+wave/i, "Black Wave"],
    [/red\s+wave/i, "Red Wave"],
    [/green\s+wave/i, "Green Wave"],
    [/orange\s+wave/i, "Orange Wave"],
    [/purple\s+wave/i, "Purple Wave"],
    [/pink\s+wave/i, "Pink Wave"],
    [/atomic\s+refractor/i, "Atomic Refractor"],
    [/superfractor/i, "Superfractor"],
    // CF-CARDQUERY-PARSER-PARALLEL-EXPANSION (2026-07-01): parallels/products
    // that were leaking into playerName via App Insights probe. The 5-item
    // audit showed 10.9% of parsed queries had product/parallel tokens
    // contaminating the extracted player name — worst case was "Sapphire
    // Ethan Conrad", which caused the engine to price a real card at $9
    // when weekly sales averaged $62.50 (phantom-aggregation from wrong
    // candidate pool). Adding these entries strips the tokens as first-
    // class parallels — semantically correct AND clean-player fix.
    // Multi-word variants (Blue Raywave, Red Lava) precede singles so
    // downstream keeps the color info.
    //
    // Raywave — Bowman Chrome color-refractor sub-family.
    [/blue\s+raywave/i, "Blue Raywave"],
    [/green\s+raywave/i, "Green Raywave"],
    [/red\s+raywave/i, "Red Raywave"],
    [/purple\s+raywave/i, "Purple Raywave"],
    [/orange\s+raywave/i, "Orange Raywave"],
    [/pink\s+raywave/i, "Pink Raywave"],
    [/\braywave\b/i, "Raywave"],
    // Lava — Bowman Draft Chrome color-refractor sub-family.
    [/red\s+lava/i, "Red Lava"],
    [/blue\s+lava/i, "Blue Lava"],
    [/gold\s+lava/i, "Gold Lava"],
    [/green\s+lava/i, "Green Lava"],
    [/purple\s+lava/i, "Purple Lava"],
    [/orange\s+lava/i, "Orange Lava"],
    [/\blava\b/i, "Lava"],
    // X-Fractor — Bowman Chrome specialty. Hyphen / no-hyphen / space all
    // observed in the wild.
    [/x[-\s]?fractor/i, "X-Fractor"],
    // CF-SAPPHIRE-COLOR-PARALLELS (2026-07-09, Drew — Owen Carey Black
    // Sapphire): color-modified Sapphire parallels MUST come BEFORE the
    // bare `/sapphire/i` fallback below, otherwise "black sapphire"
    // matches `/sapphire/i` first, sets parallel="Sapphire", and the
    // color word leaks into playerName ("Owen Carey Black"). Downstream
    // family-projection then uses the wrong player and finds no comps.
    // Same shape as the multi-color Refractor patterns above.
    [/padparadscha\s+sapphire/i, "Padparadscha Sapphire"],
    [/black\s+sapphire/i, "Black Sapphire"],
    [/red\s+sapphire/i, "Red Sapphire"],
    [/gold\s+sapphire/i, "Gold Sapphire"],
    [/blue\s+sapphire/i, "Blue Sapphire"],
    [/green\s+sapphire/i, "Green Sapphire"],
    [/orange\s+sapphire/i, "Orange Sapphire"],
    [/yellow\s+sapphire/i, "Yellow Sapphire"],
    // Bowman Sapphire — product tier, not strictly a parallel, but treated
    // as one for query-disambiguation purposes (CH catalog indexes it by
    // "Sapphire" as an attribute). Bare fallback — only fires when none
    // of the color-modified patterns above matched.
    [/sapphire/i, "Sapphire"],
    // Topps Transcendent — product tier, same reasoning as Sapphire.
    [/transcendent/i, "Transcendent"],
    [/gold\s+refractor/i, "Gold Refractor"],
    [/red\s+refractor/i, "Red Refractor"],
    [/blue\s+refractor/i, "Blue Refractor"],
    [/orange\s+refractor/i, "Orange Refractor"],
    [/green\s+refractor/i, "Green Refractor"],
    [/purple\s+refractor/i, "Purple Refractor"],
    [/pink\s+refractor/i, "Pink Refractor"],
    [/\brefractor\b/i, "Refractor"],
    // CF-CARDQUERY-PARSER-COLOR-WORD-BOUNDARY (2026-07-01): bare-color
    // patterns MUST use `\b` word boundaries. Without them,
    // `/red/i.test("jared jones") === true` — parser mangled "Jared" to
    // "Ja" (substring-stripped "red"), CH's player filter got "Ja Jones"
    // which doesn't exist, all Jared Jones queries returned only the AI-
    // matched card (1 of 100 possible). Same class of bug affects any
    // name with a color substring: Jaredin, Silvestre, Goldberg, etc.
    [/\bgold\b/i, "Gold"],
    [/\bred\b/i, "Red"],
    [/\borange\b/i, "Orange"],
    [/\bpurple\b/i, "Purple"],
    [/\bpink\b/i, "Pink"],
    [/\bgreen\b/i, "Green"],
    [/\bblue\b/i, "Blue"],
    [/\byellow\b/i, "Yellow"],
    [/\bblack\b/i, "Black"],
    [/\bwhite\b/i, "White"],
    [/\bsilver\b/i, "Silver"],
    [/\bplatinum\b/i, "Platinum"],
    [/\baqua\b/i, "Aqua"],
    [/\bcyan\b/i, "Cyan"],
    [/1st\s+bowman/i, "1st Bowman"],
    [/1st\s+edition/i, "1st Edition"],
    [/printing\s+plate/i, "Printing Plate"],
    [/canvas/i, "Canvas"],
  ];
  let parallel: string | null = null;
  for (const [pattern, name] of PARALLEL_PATTERNS) {
    if (pattern.test(text)) { parallel = name; break; }
  }

  // --- AUTO / PATCH / ROOKIE ---
  const isAuto = /\bauto(graph(ed)?)?\b/i.test(text) || /\brpa\b/i.test(text);
  const isPatch = /\bpatch\b/i.test(text) || /\brpa\b/i.test(text);
  const isRookie = /\brc\b/i.test(text) || /\brookie\b/i.test(text) ||
                   /\b1st\b.*\bbowman\b/i.test(text);

  // --- PRINT RUN --- "/499", "#/25", "numbered to 10"
  const printRunMatch =
    text.match(/(?:\/|#\/)\s*(\d{1,4})\b/) ||
    text.match(/\bnumbered\s+to\s+(\d{1,4})\b/i);
  const printRun = printRunMatch ? parseInt(printRunMatch[1], 10) : null;

  // --- CARD NUMBER --- "#BD-31", "BD-31", "US175", "CPA-CBO", "C24-CBO"
  // Ordering matters (first match wins):
  //   1. Hashed (case-insensitive): "#CPA-CBO", "#BD-31", "#US175"
  //   2. Hyphenated: "BD-31", "CPA-CBO", "C24-CBO" — start with a letter,
  //      then 0-3 letters/digits, then "-", then 1+ letters/digits. Allows
  //      letter+digit prefix ("C24-CBO") which the prior regex missed.
  //   3. Unhyphenated last: "US175", "USC35", "HMT9" — letters followed by
  //      digits, no hyphen. Must run last so it doesn't swallow "BD" from
  //      "BD-31".
  //
  // CF-CARDNUMBER-CASE-INSENSITIVE (2026-07-09, Drew — Owen Carey BCP-69):
  // regexes 2 and 3 must be case-insensitive. User queries commonly come in
  // as lowercase ("owen carey bcp-69"); without /i the hyphenated pattern
  // missed "bcp-69", the printRun regex then stripped "69" as if it were a
  // print run, and "bcp-" leaked into playerName ("Owen Carey Bcp-"). iOS
  // then rendered the mangled name in the header and downstream lookups
  // couldn't find a real player.
  const cardNumMatch =
    text.match(/#([A-Z0-9]{1,5}-?[A-Z0-9]+)\b/i) ||
    text.match(/\b([A-Z][A-Z0-9]{0,3}-[A-Z0-9]+)\b/i) ||
    text.match(/\b([A-Z]{1,4}\d+)\b/i);
  const cardNumber = cardNumMatch ? cardNumMatch[1].toUpperCase() : null;

  // --- GRADE + GRADING COMPANY ---
  const GRADE_PATTERNS: [RegExp, string, string][] = [
    [/psa\s*10\b/i, "PSA", "10"],
    [/psa\s*9\.5\b/i, "PSA", "9.5"],
    [/psa\s*9\b/i, "PSA", "9"],
    [/psa\s*8\b/i, "PSA", "8"],
    [/psa\s*(\d(?:\.\d)?)\b/i, "PSA", "$1"],
    [/bgs\s*10\b/i, "BGS", "10"],
    [/bgs\s*9\.5\b/i, "BGS", "9.5"],
    [/bgs\s*9\b/i, "BGS", "9"],
    [/bgs\s*(\d(?:\.\d)?)\b/i, "BGS", "$1"],
    [/beckett\s*(\d(?:\.\d)?)\b/i, "BGS", "$1"],
    [/sgc\s*10\b/i, "SGC", "10"],
    [/sgc\s*9\.5\b/i, "SGC", "9.5"],
    [/sgc\s*(\d(?:\.\d)?)\b/i, "SGC", "$1"],
    [/cgc\s*(\d(?:\.\d)?)\b/i, "CGC", "$1"],
    [/hga\s*(\d(?:\.\d)?)\b/i, "HGA", "$1"],
    [/black\s+label/i, "BGS", "10"],
  ];
  let grade: string | null = null;
  let gradingCompany: string | null = null;
  for (const [pattern, company, g] of GRADE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      gradingCompany = company;
      grade = g.startsWith("$") ? m[1] : g;
      break;
    }
  }
  if (!gradingCompany && /\braw\b/i.test(text)) {
    grade = "raw";
  }

  // --- PLAYER NAME ---
  let remaining = text;
  // Strip any "#token" cache-buster / tag (e.g. "#mlift1") that wasn't already
  // captured as a card number (#BD-31 etc.). Done early so leftover word
  // fragments never bleed into playerName.
  remaining = remaining.replace(/#[A-Za-z][A-Za-z0-9_-]*/g, " ");
  if (year) remaining = remaining.replace(/\b(19|20)\d{2}\b/, " ");
  if (brand) remaining = remaining.replace(new RegExp(escapeRegex(brand), "gi"), " ");
  if (set && set !== brand) {
    const setOnly = set.replace(new RegExp(`^${escapeRegex(brand ?? "")}\\s*`, "i"), "").trim();
    if (setOnly) remaining = remaining.replace(new RegExp(escapeRegex(setOnly), "gi"), " ");
  }
  // CF-CARDQUERY-PARSER-COLOR-WORD-BOUNDARY (2026-07-01): defensive `\b`
  // on the parallel-substitution so canonical "Red" doesn't strip "red"
  // from "jared". Belt-and-suspenders with the boundary fix on the
  // PARALLEL_PATTERNS above.
  if (parallel) remaining = remaining.replace(new RegExp(`\\b${escapeRegex(parallel)}\\b`, "gi"), " ");
  if (cardNumber) remaining = remaining.replace(new RegExp(`#?${escapeRegex(cardNumber)}`, "gi"), " ");
  if (printRun != null) remaining = remaining.replace(/(?:\/|#\/)?\s*\d{1,4}/g, " ");
  if (gradingCompany) remaining = remaining.replace(new RegExp(`\\b${escapeRegex(gradingCompany)}\\b`, "gi"), " ");
  if (grade && grade !== "raw") {
    remaining = remaining.replace(new RegExp(`\\b${escapeRegex(grade)}\\b`, "gi"), " ");
  }

  const NOISE = [
    "auto", "autograph", "autographed", "patch", "rpa", "rookie", "rc", "card",
    "numbered", "to", "draft", "1st", "edition", "base", "chrome",
    "refractor", "insert", "parallel", "variation", "sp", "ssp",
    "bowman", "topps", "panini", "donruss", "prizm", "select",
    "upper", "deck", "fleer", "score", "prospect", "prospects",
    "border", "raw", "signed", "signature", "wave", "shimmer",
    "baseball", "football", "basketball", "hockey", "soccer",
    // CF-CH-STRUCTURED-SEARCH-FILTERS (2026-06-28): "image" pair to the
    // existing "variation" so the "Image Variation" parallel name doesn't
    // leak its first half into playerName (observed on
    // "Drake Baldwin 2025 Bowman Chrome Image Variation" → playerName
    // "Drake Baldwin Image" pre-fix → CardHedge player filter mismatched).
    "image",
    // CF-CARDQUERY-PARSER-PARALLEL-EXPANSION (2026-07-01): these are ALSO
    // added to PARALLEL_PATTERNS above. The pattern-based strip at
    // `remaining.replace(escapeRegex(parallel), ...)` uses the canonical
    // pattern name — "Xfractor" (no hyphen) in user input can't be
    // stripped by canonical "X-Fractor" (with hyphen). NOISE catches
    // the raw text regardless of the parallel field.
    "sapphire", "transcendent", "xfractor", "raywave", "lava",
  ];
  for (const noise of NOISE) {
    remaining = remaining.replace(new RegExp(`\\b${noise}\\b`, "gi"), " ");
  }

  const playerName = remaining
    .replace(/[^a-zA-Z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ") || null;

  // --- CONFIDENCE ---
  let confidence = 0;
  if (playerName && playerName.split(" ").length >= 2) confidence += 0.4;
  if (year) confidence += 0.2;
  if (brand) confidence += 0.2;
  if (parallel || isAuto) confidence += 0.1;
  if (set && set !== brand) confidence += 0.1;

  return {
    playerName,
    year,
    brand,
    set,
    parallel,
    isAuto,
    isPatch,
    isRookie,
    printRun,
    cardNumber,
    grade,
    gradingCompany,
    confidence: Math.min(1, confidence),
    rawQuery: input,
  };
}

// ---------------------------------------------------------------------------
// buildCompSearchQuery
// ---------------------------------------------------------------------------
export function buildCompSearchQuery(parsed: ParsedCardQuery): string {
  const parts: string[] = [];

  if (parsed.year) parts.push(parsed.year.toString());
  if (parsed.playerName) parts.push(parsed.playerName);
  if (parsed.brand) parts.push(parsed.brand);
  if (parsed.set && parsed.set !== parsed.brand) {
    const setOnly = parsed.set.replace(new RegExp(`^${escapeRegex(parsed.brand ?? "")}\\s*`, "i"), "").trim();
    if (setOnly) parts.push(setOnly);
  }
  // Critical: include "auto" in the search string when isAuto=true so
  // Card Hedge / eBay aren't asked for the base card.
  if (parsed.isAuto) parts.push("auto");
  if (parsed.isPatch) parts.push("patch");
  if (parsed.parallel) parts.push(parsed.parallel);
  if (parsed.cardNumber) parts.push(parsed.cardNumber);
  if (parsed.printRun) parts.push(`/${parsed.printRun}`);
  if (parsed.grade && parsed.gradingCompany) {
    parts.push(`${parsed.gradingCompany} ${parsed.grade}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// isCompVariantMatch
//
// Returns { match, reason } for a candidate comp title against the parsed
// query. AUTO mismatches and specific (multi-word) parallel mismatches are
// hard exclusions. Used post-fetch to filter wrong-variant comps before any
// pricing math runs.
// ---------------------------------------------------------------------------
export function isCompVariantMatch(
  compTitle: string,
  parsed: ParsedCardQuery
): { match: boolean; reason: string } {
  const title = (compTitle ?? "").toLowerCase();

  // AUTO check — both directions are hard exclusions: an autograph sells for
  // dramatically more than the base card, so mixing them poisons the FMV.
  // Card-number prefixes also indicate autograph SKUs (e.g. "CPA-CBO" =
  // Chrome Prospect Autograph) — seller listings often write the card number
  // without the word "auto".
  // Defect #4 fix: extend AUTO_PREFIX_RE terminator to accept ',', ')' (e.g.
  // titles like "(AU, RC)") in addition to the prior '[- ]'. Extend the auto
  // word regex to match "Autographs" (plural — common subset name) and "autos"
  // (colloquial plural), in addition to the prior "auto", "autograph",
  // "autographed".
  const AUTO_PREFIX_RE = /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa)[-,)\s]/i;
  const hasAuto =
    /\bauto(graph(s|ed)?|s)?\b/i.test(title) ||
    /\brpa\b/.test(title) ||
    AUTO_PREFIX_RE.test(title);
  if (parsed.isAuto && !hasAuto) {
    return { match: false, reason: "comp_missing_auto" };
  }
  if (!parsed.isAuto && hasAuto) {
    return { match: false, reason: "comp_has_unwanted_auto" };
  }

  // PARALLEL check.
  if (parsed.parallel) {
    const parallelLower = parsed.parallel.toLowerCase();
    const titleHasFull = title.includes(parallelLower);
    const isSpecific = parallelLower.split(" ").length > 1;
    if (isSpecific && !titleHasFull) {
      return { match: false, reason: `parallel_mismatch:expected_${parsed.parallel}` };
    }
    // Single-word parallel: if user asked for plain "blue" but title says
    // "sky blue" / "dark blue" / "royal blue" / "ice blue", that's wrong.
    if (!isSpecific) {
      const qualifierBefore = new RegExp(
        `\\b(sky|royal|navy|light|dark|ice|electric|neon|baby|midnight|powder|ocean|deep|hot|rose|ruby|emerald|forest|lime|mint|lemon|canary|amber)\\s+${escapeRegex(parallelLower)}\\b`
      );
      if (!titleHasFull) {
        return { match: false, reason: `parallel_mismatch:expected_${parsed.parallel}` };
      }
      if (qualifierBefore.test(title)) {
        return { match: false, reason: `parallel_qualifier_mismatch:expected_plain_${parsed.parallel}` };
      }
    }
  }

  // PRINT RUN check.
  if (parsed.printRun) {
    const printRunPattern = new RegExp(`/\\s*${parsed.printRun}\\b`);
    if (!printRunPattern.test(title)) {
      return { match: false, reason: `print_run_mismatch:expected_${parsed.printRun}` };
    }
  }

  // PLAYER check.
  if (parsed.playerName) {
    const lastName = parsed.playerName.split(" ").pop()?.toLowerCase() ?? "";
    if (lastName && !title.includes(lastName)) {
      return { match: false, reason: "player_name_missing_from_comp" };
    }
  }

  return { match: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// getCompVariantMismatchReasons
//
// CF-VARIANT-FILTER-LOOSENING: returns the FULL set of rejection-reason keys
// that apply to a comp, rather than the first-fired reason. Required by the
// tier ladder: a comp may fail two checks (e.g. comp_missing_auto AND
// print_run_mismatch); a tier that relaxes the first must still hard-reject
// on the second.
//
// Reason keys returned here are the bare keys without the `:expected_<x>`
// suffix that isCompVariantMatch attaches — tier classification matches on
// the bare key.
// ---------------------------------------------------------------------------
export function getCompVariantMismatchReasons(
  compTitle: string,
  parsed: ParsedCardQuery
): string[] {
  const title = (compTitle ?? "").toLowerCase();
  const reasons: string[] = [];

  // AUTO check (both directions).
  const AUTO_PREFIX_RE = /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa)[-,)\s]/i;
  const hasAuto =
    /\bauto(graph(s|ed)?|s)?\b/i.test(title) ||
    /\brpa\b/.test(title) ||
    AUTO_PREFIX_RE.test(title);
  if (parsed.isAuto && !hasAuto) reasons.push("comp_missing_auto");
  if (!parsed.isAuto && hasAuto) reasons.push("comp_has_unwanted_auto");

  // PARALLEL check.
  if (parsed.parallel) {
    const parallelLower = parsed.parallel.toLowerCase();
    const titleHasFull = title.includes(parallelLower);
    const isSpecific = parallelLower.split(" ").length > 1;
    if (isSpecific && !titleHasFull) {
      reasons.push("parallel_mismatch");
    } else if (!isSpecific) {
      const qualifierBefore = new RegExp(
        `\\b(sky|royal|navy|light|dark|ice|electric|neon|baby|midnight|powder|ocean|deep|hot|rose|ruby|emerald|forest|lime|mint|lemon|canary|amber)\\s+${escapeRegex(parallelLower)}\\b`
      );
      if (!titleHasFull) {
        reasons.push("parallel_mismatch");
      } else if (qualifierBefore.test(title)) {
        reasons.push("parallel_qualifier_mismatch");
      }
    }
  }

  // PRINT RUN check.
  if (parsed.printRun) {
    const printRunPattern = new RegExp(`/\\s*${parsed.printRun}\\b`);
    if (!printRunPattern.test(title)) reasons.push("print_run_mismatch");
  }

  // PLAYER check.
  if (parsed.playerName) {
    const lastName = parsed.playerName.split(" ").pop()?.toLowerCase() ?? "";
    if (lastName && !title.includes(lastName)) reasons.push("player_name_missing_from_comp");
  }

  return reasons;
}
