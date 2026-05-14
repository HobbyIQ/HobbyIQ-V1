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
    [/panini\s+prizm/i, "Panini", "Prizm"],
    [/prizm/i, "Panini", "Prizm"],
    [/donruss\s+optic/i, "Panini", "Donruss Optic"],
    [/donruss/i, "Panini", "Donruss"],
    [/select/i, "Panini", "Select"],
    [/contenders/i, "Panini", "Contenders"],
    [/national\s+treasures/i, "Panini", "National Treasures"],
    [/flawless/i, "Panini", "Flawless"],
    [/upper\s+deck/i, "Upper Deck", "Upper Deck"],
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
    [/gold\s+refractor/i, "Gold Refractor"],
    [/red\s+refractor/i, "Red Refractor"],
    [/blue\s+refractor/i, "Blue Refractor"],
    [/orange\s+refractor/i, "Orange Refractor"],
    [/green\s+refractor/i, "Green Refractor"],
    [/purple\s+refractor/i, "Purple Refractor"],
    [/pink\s+refractor/i, "Pink Refractor"],
    [/refractor/i, "Refractor"],
    [/gold/i, "Gold"],
    [/red/i, "Red"],
    [/orange/i, "Orange"],
    [/purple/i, "Purple"],
    [/pink/i, "Pink"],
    [/green/i, "Green"],
    [/blue/i, "Blue"],
    [/yellow/i, "Yellow"],
    [/black/i, "Black"],
    [/white/i, "White"],
    [/silver/i, "Silver"],
    [/platinum/i, "Platinum"],
    [/aqua/i, "Aqua"],
    [/cyan/i, "Cyan"],
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

  // --- CARD NUMBER --- "#BD-31", "BD-31"
  const cardNumMatch = text.match(/#([A-Z]{1,3}-?\d+)\b/i) ||
                       text.match(/\b([A-Z]{1,3}-\d+)\b/);
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
  if (parallel) remaining = remaining.replace(new RegExp(escapeRegex(parallel), "gi"), " ");
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
  const AUTO_PREFIX_RE = /\b(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa|bbpa)[- ]/i;
  const hasAuto =
    /\bauto(graph(ed)?)?\b/.test(title) ||
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
