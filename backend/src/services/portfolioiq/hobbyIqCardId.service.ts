// CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706). HobbyIQ's own
// canonical card identifier. Vendor-independent, deterministic,
// human-readable. The "we set the market" identity primitive.
//
// FORMAT
//   hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallelSlug}:{autoFlag}[:num-{printRun}]
//
// EXAMPLES
//   hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50
//   hiq:baseball:2026:bowman-chrome:bcp-102:orange-shimmer-refractor:no-auto
//   hiq:basketball:2024:panini-prizm:1:silver-prizm:no-auto:num-99
//   hiq:pokemon:2023:sv1:151:full-art:no-auto
//
// DESIGN CONSTRAINTS
//   - Deterministic: same normalized inputs ALWAYS produce the same slug.
//   - Reversible enough for debugging: a human reader can look at the
//     slug and know what card it is.
//   - Uniqueness: sport is the top-level namespace so cardNumbers don't
//     collide across sports. Print run distinguishes numbered parallels
//     (Gold /50 ≠ Gold /25 ≠ Gold unnumbered).
//   - No dependency on any vendor identifier — CH, Cardsight, eBay all
//     map to the same hobbyiqCardId via their attributes.
//
// NORMALIZATION RULES (canonical — do NOT change without a migration)
//   sport         → lowercase, ASCII, no spaces
//   year          → 4-digit integer, as-is
//   setKey        → slug: lowercase, strip punctuation, spaces→hyphens,
//                   collapse repeated hyphens. Uses the SHORTEST canonical
//                   name from a controlled vocabulary when possible
//                   (e.g. "2026 Bowman Chrome Prospects" → "bowman-chrome")
//   cardNumber    → lowercase, kept literal (letters, digits, hyphens)
//   parallelSlug  → slug of the specific variant (NOT the lossy label —
//                   caller must pass the specific variant, extracted from
//                   the title if necessary)
//   autoFlag      → "auto" | "no-auto"  (never omitted)
//   printRun      → "num-{N}" optional suffix (omitted when card is
//                   unnumbered, e.g. Base or general Refractor)
//
// This module has ZERO side effects. Import + call is safe anywhere.

export interface HobbyIqCardIdComponents {
  sport: string;              // e.g. "baseball"
  year: number;               // e.g. 2026
  setKey: string;             // e.g. "bowman" (canonical short form)
  cardNumber: string;         // e.g. "CPA-EHA"
  parallel: string;           // e.g. "Gold Refractor" (SPECIFIC variant, not lossy)
  isAuto: boolean;
  printRun?: number | null;   // e.g. 50 for /50 numbered; null/undefined for unnumbered
}

/** Turn an arbitrary label into a URL-safe slug fragment.
 *  - lowercase
 *  - strip characters other than a-z0-9 and space/hyphen
 *  - spaces → hyphens
 *  - collapse repeated hyphens
 *  - trim leading/trailing hyphens
 *
 *  Deterministic — same input always produces the same output. */
export function slugify(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")             // handle unicode variants (é → e, etc.)
    .replace(/[^\w\s-]/g, "")      // strip punctuation (excl underscore/hyphen)
    .replace(/_/g, "-")            // underscore → hyphen (uniform)
    .replace(/\s+/g, "-")          // spaces → hyphens
    .replace(/-+/g, "-")           // collapse repeats
    .replace(/^-|-$/g, "");        // trim
}

/** Normalize sport to the canonical lowercase form. */
function normalizeSport(sport: string): string {
  const s = slugify(sport);
  // Aliases → canonical (defensive; upstream should already normalize)
  if (s === "nfl") return "football";
  if (s === "nba") return "basketball";
  if (s === "mlb") return "baseball";
  if (s === "nhl") return "hockey";
  return s;
}

/** Normalize setKey — accepts either an already-normalized short form
 *  ("bowman-chrome") or a longer product string ("2026 Bowman Chrome
 *  Prospects Baseball") and returns the canonical short form. */
function normalizeSetKey(setName: string): string {
  const s = slugify(setName);
  // Controlled-vocabulary short forms. Order matters: more-specific
  // patterns first so "bowman-chrome-draft" doesn't collapse to "bowman".
  const known: Array<[RegExp, string]> = [
    [/bowman-chrome-draft/, "bowman-chrome-draft"],
    [/bowman-chrome/, "bowman-chrome"],
    [/bowman-draft/, "bowman-draft"],
    [/bowman-sterling/, "bowman-sterling"],
    [/^bowman/, "bowman"],
    [/bowman/, "bowman"],
    [/topps-chrome-update/, "topps-chrome-update"],
    [/topps-chrome/, "topps-chrome"],
    [/topps-heritage/, "topps-heritage"],
    [/topps-finest/, "topps-finest"],
    [/topps-pristine/, "topps-pristine"],
    [/allen-(and-)?ginter/, "topps-allen-ginter"],
    [/stadium-club/, "topps-stadium-club"],
    [/topps/, "topps"],
    [/panini-prizm|prizm/, "panini-prizm"],
    [/panini-select|select/, "panini-select"],
    [/panini-mosaic|mosaic/, "panini-mosaic"],
    [/panini-donruss|donruss/, "panini-donruss"],
    [/panini-optic|optic/, "panini-optic"],
    [/panini-contenders|contenders/, "panini-contenders"],
    [/panini-immaculate|immaculate/, "panini-immaculate"],
    [/panini-flawless|flawless/, "panini-flawless"],
    [/national-treasures/, "panini-national-treasures"],
    [/upper-deck/, "upper-deck"],
  ];
  for (const [re, canonical] of known) {
    if (re.test(s)) return canonical;
  }
  // Unknown set — fall back to slugified full name. Not ideal but
  // preserves determinism.
  return s;
}

/** Normalize cardNumber: lowercase, kept literal. Preserves letters,
 *  digits, and internal hyphens (CPA-EHA → cpa-eha, BCP-102 → bcp-102). */
function normalizeCardNumber(cardNumber: string): string {
  return slugify(cardNumber);
}

/** Normalize parallel to a canonical slug. Caller MUST pass the
 *  specific variant (not lossy vendor labels like "Refractor" for a
 *  Gold Refractor). Base/Base Refractor/no-parallel all normalize to
 *  "base". */
function normalizeParallel(parallel: string | null | undefined): string {
  const s = slugify(parallel ?? "");
  if (s === "" || s === "base" || s === "none" || s === "no-parallel") {
    return "base";
  }
  return s;
}

/** Format printRun suffix. Positive integer → "num-N"; anything else → "". */
function formatPrintRun(printRun: number | null | undefined): string {
  if (printRun === null || printRun === undefined) return "";
  if (!Number.isFinite(printRun) || printRun <= 0 || !Number.isInteger(printRun)) return "";
  return `:num-${printRun}`;
}

/** Compute the canonical hobbyiqCardId slug for a card. Same inputs
 *  ALWAYS produce the same slug — the function has no side effects and
 *  no I/O. */
export function computeHobbyIqCardId(components: HobbyIqCardIdComponents): string {
  const sport = normalizeSport(components.sport);
  const year = Number.isFinite(components.year) ? Math.trunc(components.year) : 0;
  const setKey = normalizeSetKey(components.setKey);
  const cardNumber = normalizeCardNumber(components.cardNumber);
  const parallelSlug = normalizeParallel(components.parallel);
  const autoFlag = components.isAuto ? "auto" : "no-auto";
  const printRun = formatPrintRun(components.printRun);
  return `hiq:${sport}:${year}:${setKey}:${cardNumber}:${parallelSlug}:${autoFlag}${printRun}`;
}

/** Best-effort reverse parse of a hobbyiqCardId. Returns null when the
 *  slug doesn't match the expected format. Used for debugging + audit
 *  trails; not a general-purpose deserializer. */
export function parseHobbyIqCardId(hiqId: string): HobbyIqCardIdComponents | null {
  if (typeof hiqId !== "string" || !hiqId.startsWith("hiq:")) return null;
  const parts = hiqId.split(":");
  // Minimum: hiq + 6 fields = 7 parts. With print run = 8.
  if (parts.length !== 7 && parts.length !== 8) return null;
  const [, sport, yearStr, setKey, cardNumber, parallelSlug, autoFlag, printRunPart] = parts;
  const year = Number(yearStr);
  if (!Number.isFinite(year) || year <= 0) return null;
  if (autoFlag !== "auto" && autoFlag !== "no-auto") return null;
  let printRun: number | null = null;
  if (printRunPart) {
    if (!printRunPart.startsWith("num-")) return null;
    const n = Number(printRunPart.slice(4));
    if (!Number.isFinite(n) || n <= 0) return null;
    printRun = n;
  }
  return {
    sport,
    year,
    setKey,
    cardNumber,
    parallel: parallelSlug,
    isAuto: autoFlag === "auto",
    printRun,
  };
}
