// ---------------------------------------------------------------------------
// Chrome / Draft Multiplier Table — Issue #25 Phase 3 (REBUILD)
//
// Owner-curated 54-entry parallel-name → value-multiplier table for the
// Topps Bowman Chrome / Bowman Draft Chrome parallel rainbow. These values
// were derived empirically by the owner from observed 2024 market data
// (2024 Bowman Chrome Prospects, 2024 Bowman Draft Chrome, etc.) and are
// the AUTHORITATIVE source for Phase 3 predicted-range math.
//
// Replaces the earlier coarse 8-tier integer system (tierMultipliers.ts).
// Per-parallel-name multipliers are dramatically more precise than the
// 8-bucket tier system; the engine does NOT derive these values — it only
// looks them up.
//
// Naming convention:
//   • The Refractor /499 row is the "Refractor X" baseline (= 1.000 in that
//     column). The Base Auto unnumbered row is the "Base X" baseline
//     (= 1.000 in that column).
//   • For Phase 3 math we standardize on the BASE X column. Every parallel
//     entry exposes both columns so future logic can swap baselines.
//   • Color parallels in the table omit the trailing " Refractor" — e.g. the
//     /150 blue parallel is keyed "Blue", not "Blue Refractor". The
//     `lookupMultiplier()` helper accepts either form and normalizes.
//
// The same multipliers are applied to both autograph and non-autograph
// Chrome/Draft variants. The relative scarcity step from Base → Blue → Gold
// → Red is similar across both autograph and non-autograph rainbows for
// the Chrome family in 2024 product, which is what Phase 3 cares about.
// ---------------------------------------------------------------------------

export type ChromeDraftColorTier =
  | "Base"
  | "Early Color"
  | "Atomic Tier"
  | "Blue Tier"
  | "Green Tier"
  | "Yellow Tier"
  | "Gold Tier"
  | "Orange Tier"
  | "Black Tier"
  | "Red Tier"
  | "1/1 Tier"
  | "HTA";

export interface ChromeDraftEntry {
  /** Canonical parallel name as authored by the owner (Title Case). */
  parallelName: string;
  /** Print run as written ("unnumbered", "/499", "/150", "1/1"). */
  printRun: string;
  /** Color-tier bucket (informational, NOT used directly in math). */
  colorTier: ChromeDraftColorTier;
  /** Value multiplier when Base Auto unnumbered = 1.000 baseline. */
  baseMultiplier: number;
  /** Value multiplier when Refractor /499 = 1.000 baseline. */
  refractorMultiplier: number;
  /** Product family tag — currently always "chrome-draft". */
  productType: "chrome-draft";
}

const RAW_ENTRIES: ReadonlyArray<ChromeDraftEntry> = [
  // Base / Refractor anchors
  { parallelName: "Base Auto",           printRun: "unnumbered", colorTier: "Base",         baseMultiplier:   1.000, refractorMultiplier:  0.455, productType: "chrome-draft" },
  { parallelName: "Refractor",           printRun: "/499",       colorTier: "Base",         baseMultiplier:   2.200, refractorMultiplier:  1.000, productType: "chrome-draft" },
  // Early color
  { parallelName: "Speckle",             printRun: "/299",       colorTier: "Early Color",  baseMultiplier:   2.700, refractorMultiplier:  1.227, productType: "chrome-draft" },
  { parallelName: "Purple",              printRun: "/250",       colorTier: "Early Color",  baseMultiplier:   2.700, refractorMultiplier:  1.227, productType: "chrome-draft" },
  { parallelName: "Purple Shimmer",      printRun: "/250",       colorTier: "Early Color",  baseMultiplier:   3.000, refractorMultiplier:  1.364, productType: "chrome-draft" },
  { parallelName: "Purple RayWave",      printRun: "/250",       colorTier: "Early Color",  baseMultiplier:   3.100, refractorMultiplier:  1.409, productType: "chrome-draft" },
  // Atomic
  { parallelName: "Atomic",              printRun: "/100",       colorTier: "Atomic Tier",  baseMultiplier:   4.200, refractorMultiplier:  1.909, productType: "chrome-draft" },
  // Blue
  { parallelName: "Blue",                printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   5.700, refractorMultiplier:  2.591, productType: "chrome-draft" },
  { parallelName: "Blue Wave",           printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   4.900, refractorMultiplier:  2.227, productType: "chrome-draft" },
  { parallelName: "Blue Shimmer",        printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   4.800, refractorMultiplier:  2.182, productType: "chrome-draft" },
  { parallelName: "Blue RayWave",        printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   4.600, refractorMultiplier:  2.091, productType: "chrome-draft" },
  { parallelName: "Blue Reptilian",      printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   4.700, refractorMultiplier:  2.136, productType: "chrome-draft" },
  { parallelName: "Blue Sapphire",       printRun: "/150",       colorTier: "Blue Tier",    baseMultiplier:   5.200, refractorMultiplier:  2.364, productType: "chrome-draft" },
  // Green
  { parallelName: "Green",               printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   4.300, refractorMultiplier:  1.955, productType: "chrome-draft" },
  { parallelName: "Green Wave",          printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   5.600, refractorMultiplier:  2.545, productType: "chrome-draft" },
  { parallelName: "Green Shimmer",       printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   6.000, refractorMultiplier:  2.727, productType: "chrome-draft" },
  { parallelName: "Green Sapphire",      printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   5.300, refractorMultiplier:  2.409, productType: "chrome-draft" },
  { parallelName: "Green Reptilian",     printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   6.200, refractorMultiplier:  2.818, productType: "chrome-draft" },
  { parallelName: "Green Grass",         printRun: "/99",        colorTier: "Green Tier",   baseMultiplier:   6.400, refractorMultiplier:  2.909, productType: "chrome-draft" },
  // Yellow
  { parallelName: "Yellow",              printRun: "/75",        colorTier: "Yellow Tier",  baseMultiplier:   6.700, refractorMultiplier:  3.045, productType: "chrome-draft" },
  { parallelName: "Yellow RayWave",      printRun: "/75",        colorTier: "Yellow Tier",  baseMultiplier:   6.500, refractorMultiplier:  2.955, productType: "chrome-draft" },
  { parallelName: "Yellow Mini Diamond", printRun: "/75",        colorTier: "Yellow Tier",  baseMultiplier:   7.000, refractorMultiplier:  3.182, productType: "chrome-draft" },
  // Gold
  { parallelName: "Gold",                printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:  14.500, refractorMultiplier:  7.045, productType: "chrome-draft" },
  { parallelName: "Gold Wave",           printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:   8.700, refractorMultiplier:  3.955, productType: "chrome-draft" },
  { parallelName: "Gold Shimmer",        printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:   9.300, refractorMultiplier:  4.227, productType: "chrome-draft" },
  { parallelName: "Gold Mini Diamond",   printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:  10.300, refractorMultiplier:  4.682, productType: "chrome-draft" },
  { parallelName: "Gold Sapphire",       printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:  10.900, refractorMultiplier:  4.955, productType: "chrome-draft" },
  { parallelName: "Gold Lava",           printRun: "/50",        colorTier: "Gold Tier",    baseMultiplier:   9.000, refractorMultiplier:  4.091, productType: "chrome-draft" },
  // Orange
  { parallelName: "Orange",              printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  21.900, refractorMultiplier:  9.955, productType: "chrome-draft" },
  { parallelName: "Orange Wave",         printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  16.300, refractorMultiplier:  7.409, productType: "chrome-draft" },
  { parallelName: "Orange Shimmer",      printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  16.200, refractorMultiplier:  7.364, productType: "chrome-draft" },
  { parallelName: "Orange Mini Diamond", printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  17.500, refractorMultiplier:  7.955, productType: "chrome-draft" },
  { parallelName: "Orange Sapphire",     printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  18.500, refractorMultiplier:  8.409, productType: "chrome-draft" },
  { parallelName: "Orange Lava",         printRun: "/25",        colorTier: "Orange Tier",  baseMultiplier:  17.800, refractorMultiplier:  8.091, productType: "chrome-draft" },
  // Black
  { parallelName: "Black",               printRun: "/10",        colorTier: "Black Tier",   baseMultiplier:  32.000, refractorMultiplier: 14.545, productType: "chrome-draft" },
  { parallelName: "Black Wave",          printRun: "/10",        colorTier: "Black Tier",   baseMultiplier:  30.000, refractorMultiplier: 13.636, productType: "chrome-draft" },
  { parallelName: "Black Shimmer",       printRun: "/10",        colorTier: "Black Tier",   baseMultiplier:  30.000, refractorMultiplier: 13.636, productType: "chrome-draft" },
  { parallelName: "Black Mini Diamond",  printRun: "/10",        colorTier: "Black Tier",   baseMultiplier:  33.000, refractorMultiplier: 15.000, productType: "chrome-draft" },
  { parallelName: "Black Sapphire",      printRun: "/10",        colorTier: "Black Tier",   baseMultiplier:  34.000, refractorMultiplier: 15.455, productType: "chrome-draft" },
  // Red
  { parallelName: "Red",                 printRun: "/5",         colorTier: "Red Tier",     baseMultiplier:  55.000, refractorMultiplier: 25.000, productType: "chrome-draft" },
  { parallelName: "Red Wave",            printRun: "/5",         colorTier: "Red Tier",     baseMultiplier:  52.000, refractorMultiplier: 23.636, productType: "chrome-draft" },
  { parallelName: "Red Shimmer",         printRun: "/5",         colorTier: "Red Tier",     baseMultiplier:  54.000, refractorMultiplier: 24.545, productType: "chrome-draft" },
  { parallelName: "Red Sapphire",        printRun: "/5",         colorTier: "Red Tier",     baseMultiplier:  56.000, refractorMultiplier: 25.455, productType: "chrome-draft" },
  { parallelName: "Red Lava",            printRun: "/5",         colorTier: "Red Tier",     baseMultiplier:  57.000, refractorMultiplier: 25.909, productType: "chrome-draft" },
  // 1/1
  { parallelName: "Printing Plate",        printRun: "1/1",      colorTier: "1/1 Tier",     baseMultiplier:   4.000, refractorMultiplier:  4.000, productType: "chrome-draft" },
  { parallelName: "Superfractor",          printRun: "1/1",      colorTier: "1/1 Tier",     baseMultiplier: 125.000, refractorMultiplier: 56.818, productType: "chrome-draft" },
  { parallelName: "Superfractor Wave",     printRun: "1/1",      colorTier: "1/1 Tier",     baseMultiplier: 130.000, refractorMultiplier: 59.091, productType: "chrome-draft" },
  { parallelName: "Superfractor Sapphire", printRun: "1/1",      colorTier: "1/1 Tier",     baseMultiplier: 135.000, refractorMultiplier: 61.364, productType: "chrome-draft" },
  // HTA Choice
  { parallelName: "HTA Choice Refractor", printRun: "/499",      colorTier: "HTA",          baseMultiplier:   2.300, refractorMultiplier:  1.045, productType: "chrome-draft" },
  { parallelName: "HTA Choice Green",     printRun: "/99",       colorTier: "HTA",          baseMultiplier:   5.000, refractorMultiplier:  2.273, productType: "chrome-draft" },
  { parallelName: "HTA Choice Gold",      printRun: "/50",       colorTier: "HTA",          baseMultiplier:   8.500, refractorMultiplier:  3.864, productType: "chrome-draft" },
  { parallelName: "HTA Choice Orange",    printRun: "/25",       colorTier: "HTA",          baseMultiplier:  18.000, refractorMultiplier:  8.182, productType: "chrome-draft" },
  { parallelName: "HTA Choice Red",       printRun: "/5",        colorTier: "HTA",          baseMultiplier:  45.000, refractorMultiplier: 20.455, productType: "chrome-draft" },
  { parallelName: "HTA Choice Black",     printRun: "1/1",       colorTier: "HTA",          baseMultiplier: 110.000, refractorMultiplier: 50.000, productType: "chrome-draft" },
];

// Frozen, indexable-by-name lookup view — keys are the canonical owner-authored
// `parallelName` values (Title Case as in the table above).
export const CHROME_DRAFT_MULTIPLIERS: Readonly<Record<string, ChromeDraftEntry>> = Object.freeze(
  RAW_ENTRIES.reduce<Record<string, ChromeDraftEntry>>((acc, entry) => {
    acc[entry.parallelName] = Object.freeze({ ...entry });
    return acc;
  }, {}),
);

// Internal: canonical-name-by-normalized-key for fast fuzzy lookup.
const NORMALIZED_INDEX: Readonly<Record<string, string>> = Object.freeze(
  RAW_ENTRIES.reduce<Record<string, string>>((acc, entry) => {
    acc[normalize(entry.parallelName)] = entry.parallelName;
    return acc;
  }, {}),
);

/**
 * Normalize a parallel name for matching:
 *   • lowercase
 *   • collapse whitespace
 *   • strip "auto", "autograph"
 *   • strip a trailing " refractor" when the name has at least one other token
 *     (so "Blue Refractor" → "blue", but the bare "Refractor" entry remains).
 */
function normalize(input: string): string {
  if (typeof input !== "string") return "";
  let s = input.toLowerCase().replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
  // strip "auto" / "autograph" tokens
  s = s.replace(/\b(autograph|auto)\b/g, "").replace(/\s+/g, " ").trim();
  // Bare "refractor" → keep as-is (it's a table entry).
  if (s === "refractor") return s;
  // Otherwise strip trailing " refractor".
  s = s.replace(/\s+refractor\b/g, "").replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Look up the multiplier entry for a parallel name.
 * Returns `null` when the parallel is not in the curated table.
 *
 * Accepts:
 *   • exact canonical name ("Blue", "Gold Sapphire", "Superfractor")
 *   • Refractor-suffixed form ("Blue Refractor" → matches "Blue")
 *   • case-insensitive, whitespace-tolerant
 *   • Auto / Autograph suffix tolerated ("Blue Auto" → matches "Blue")
 */
export function lookupMultiplier(parallelName: string | null | undefined): ChromeDraftEntry | null {
  if (!parallelName || typeof parallelName !== "string") return null;
  const key = normalize(parallelName);
  if (!key) return null;
  const canonical = NORMALIZED_INDEX[key];
  if (!canonical) return null;
  return CHROME_DRAFT_MULTIPLIERS[canonical] ?? null;
}

/**
 * Convenience: returns the color-tier bucket label (or `null` when the
 * parallel is uncurated). Used by parallel_attributes curation scripts.
 */
export function getColorTier(parallelName: string | null | undefined): ChromeDraftColorTier | null {
  const entry = lookupMultiplier(parallelName);
  return entry?.colorTier ?? null;
}

/** Total number of curated entries — exposed for sanity-check tests. */
export const CHROME_DRAFT_ENTRY_COUNT: number = RAW_ENTRIES.length;

// ---------------------------------------------------------------------------
// 2022 Bowman Family Extension (additive)
//
// This block adds owner-curated 2022 Bowman/Bowman Chrome/Bowman Draft
// range-based multipliers with strict subset disambiguation and tier
// qualifiers (Hobby/HTA/Lite). Existing 54-entry behavior is intentionally
// preserved above for legacy callers.
// ---------------------------------------------------------------------------

export type BowmanFamilyProduct = "Bowman" | "Bowman Chrome" | "Bowman Draft";
export type BowmanFamilyTierQualifier = "Hobby" | "HTA" | "Lite";

export type BowmanFamilySubset =
  | "Paper Base"
  | "Paper Prospects"
  | "Paper Base + Paper Prospects"
  | "Chrome Base"
  | "Chrome Prospects"
  | "Chrome Prospect Autographs"
  | "Chrome Rookie Autographs"
  | "Inserts"
  | "Invicta Inserts"
  | "Image Variation SSP"
  | "Bowman Ascensions / AFL Relics";

export interface BowmanFamilyRange {
  low: number | null;
  high: number | null;
}

export interface BowmanFamilyEntry {
  // CF-X (2026-06-20): year is now `number` (was literal `2022`). Allows
  // additive entries for new release years (2026 X-Fractor rainbow first;
  // future Bowman product cycles next). Subject-side lookup is year-strict
  // — peer-side lookup remains year-agnostic for back-compat (see
  // lookupBowmanFamilyEntry's year-optional context).
  year: number;
  product: BowmanFamilyProduct;
  subset: BowmanFamilySubset;
  parallelName: string;
  printRun: string;
  baselineMultiplier: number;
  range: BowmanFamilyRange;
  directCompOnly: boolean;
  tierQualifier: BowmanFamilyTierQualifier | null;
  isAutograph: boolean;
  note?: string;
  newFor2022?: boolean;
  serialGlitchCaveat?: boolean;
  /**
   * CF-X (2026-06-20): per-row provenance flag.
   *
   *   "empirical"          — multiplier derived from observed sales data
   *                          the curator had in hand at curation time
   *                          (the existing default — all 54 pre-CF-X rows
   *                          inherit this).
   *   "sibling_provisional" — curated by analogy to a known sibling parallel
   *                          (e.g. Blue X-Fractor /150 inherited from
   *                          Blue Refractor /150 because they trade at
   *                          similar street value but no direct X-Fractor
   *                          sales data was available at curation time).
   *
   * Flows through MultiplierAnchoredAttribution.subjectProvenance → engine
   * response → writer → estimateBasis ("multiplier" | "multiplier_provisional")
   * → iOS badge. Same shape as CF-A(a)'s "base_auto_floor" honesty mechanism.
   *
   * Default: "empirical" when omitted (back-compat for 54 pre-CF-X rows).
   */
  provenance?: "empirical" | "sibling_provisional";
}

function normalizeBowmanFamilyParallelName(input: string): string {
  if (typeof input !== "string") return "";
  let s = input
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+-\s+.*$/g, " ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s
    .replace(/\bblack and white\b/g, "b&w")
    .replace(/\bmini[\s-]*diamond\b/g, "mini diamond")
    .replace(/\bshimmer gold\b/g, "gold shimmer")
    .replace(/\bwave orange\b/g, "orange wave")
    .replace(/\bwave red\b/g, "red wave")
    .replace(/\s*\/\s*/g, "/");

  s = s
    .replace(/\brefractors?\b/g, "refractor")
    .replace(/\bborders?\b/g, "border")
    .replace(/\s+/g, " ")
    .trim();

  if (s === "refractor") return s;
  s = s.replace(/\s+refractor\b/g, "").replace(/\s+/g, " ").trim();
  return s;
}

function makeRange(
  low: number | null,
  high: number | null,
): BowmanFamilyRange {
  return Object.freeze({ low, high });
}

function midpoint(range: BowmanFamilyRange): number {
  if (range.low != null && range.high != null) return (range.low + range.high) / 2;
  if (range.low != null) return range.low;
  if (range.high != null) return range.high;
  return 1;
}

const RAW_BOWMAN_2022_FAMILY_ENTRIES: ReadonlyArray<BowmanFamilyEntry> = [
  // 2022 Bowman — Paper Base + Paper Prospects
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Sky Blue Border", printRun: "/499", baselineMultiplier: midpoint(makeRange(1.3, 1.7)), range: makeRange(1.3, 1.7), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Neon Green Border", printRun: "/399", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Fuchsia Border", printRun: "/299", baselineMultiplier: midpoint(makeRange(1.7, 2.3)), range: makeRange(1.7, 2.3), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Purple Border", printRun: "/250", baselineMultiplier: midpoint(makeRange(2.0, 2.6)), range: makeRange(2.0, 2.6), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Blue Border", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.8, 4.0)), range: makeRange(2.8, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Yellow Border", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.5, 6.5)), range: makeRange(4.5, 6.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Gold Border", printRun: "/50", baselineMultiplier: midpoint(makeRange(7.0, 11.0)), range: makeRange(7.0, 11.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Orange Border", printRun: "/25", baselineMultiplier: midpoint(makeRange(14.0, 22.0)), range: makeRange(14.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Red Border", printRun: "/5", baselineMultiplier: midpoint(makeRange(40.0, 65.0)), range: makeRange(40.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Platinum Border", printRun: "1/1", baselineMultiplier: 100.0, range: makeRange(100.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },
  { year: 2022, product: "Bowman", subset: "Paper Base + Paper Prospects", parallelName: "Printing Plates", printRun: "1/1", baselineMultiplier: 60.0, range: makeRange(60.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman — Chrome Prospects
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.0, range: makeRange(1.0, 1.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Speckle Refractor", printRun: "/299", baselineMultiplier: midpoint(makeRange(1.3, 1.6)), range: makeRange(1.3, 1.6), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Fuchsia Refractor", printRun: "/199", baselineMultiplier: midpoint(makeRange(1.7, 2.3)), range: makeRange(1.7, 2.3), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Fuchsia Lava Refractor", printRun: "/199", baselineMultiplier: midpoint(makeRange(1.8, 2.5)), range: makeRange(1.8, 2.5), directCompOnly: false, tierQualifier: null, isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Blue Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Blue Shimmer Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.5, 3.5)), range: makeRange(2.5, 3.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Aqua Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(2.5, 3.5)), range: makeRange(2.5, 3.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Aqua Shimmer Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(3.0, 4.0)), range: makeRange(3.0, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(3.0, 4.0)), range: makeRange(3.0, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.0, 5.5)), range: makeRange(4.0, 5.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(6.0, 10.0)), range: makeRange(6.0, 10.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Gold Shimmer Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(7.0, 11.0)), range: makeRange(7.0, 11.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(12.0, 20.0)), range: makeRange(12.0, 20.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Red Lava Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(35.0, 55.0)), range: makeRange(35.0, 55.0), directCompOnly: false, tierQualifier: null, isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Printing Plates", printRun: "1/1", baselineMultiplier: 60.0, range: makeRange(60.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },
  { year: 2022, product: "Bowman", subset: "Chrome Prospects", parallelName: "Prospector's Special Die-Cut", printRun: "/49", baselineMultiplier: midpoint(makeRange(8.0, 15.0)), range: makeRange(8.0, 15.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },

  // 2022 Bowman — Inserts
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Atomic Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Aqua Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(2.5, 3.5)), range: makeRange(2.5, 3.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(5.0, 9.0)), range: makeRange(5.0, 9.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(10.0, 18.0)), range: makeRange(10.0, 18.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(35.0, 55.0)), range: makeRange(35.0, 55.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Inserts", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 200.0, range: makeRange(200.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman — Invicta Inserts
  { year: 2022, product: "Bowman", subset: "Invicta Inserts", parallelName: "Atomic Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Invicta Inserts", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(5.0, 9.0)), range: makeRange(5.0, 9.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Invicta Inserts", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(10.0, 18.0)), range: makeRange(10.0, 18.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Invicta Inserts", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(35.0, 55.0)), range: makeRange(35.0, 55.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman", subset: "Invicta Inserts", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 200.0, range: makeRange(200.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Chrome — Base
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.0, range: makeRange(1.0, 1.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Fuchsia Refractor", printRun: "/299", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Aqua RayWave Refractor", printRun: "/199", baselineMultiplier: midpoint(makeRange(1.8, 2.5)), range: makeRange(1.8, 2.5), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "B&W Mini Diamond Refractor", printRun: "/199", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: "Lite", isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Blue Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(3.0, 4.0)), range: makeRange(3.0, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.0, 5.5)), range: makeRange(4.0, 5.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(6.0, 10.0)), range: makeRange(6.0, 10.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(12.0, 20.0)), range: makeRange(12.0, 20.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Base", parallelName: "Atomic Refractor", printRun: "unnumbered", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },

  // 2022 Bowman Chrome — Chrome Prospects
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.0, range: makeRange(1.0, 1.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "B&W Mini Diamond Refractor", printRun: "unnumbered", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: "Lite", isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Aqua/Pink Vapor Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(2.8, 3.8)), range: makeRange(2.8, 3.8), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Blue Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(3.0, 4.0)), range: makeRange(3.0, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.0, 5.5)), range: makeRange(4.0, 5.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Yellow/Orange Vapor Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.5, 6.5)), range: makeRange(4.5, 6.5), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(6.0, 10.0)), range: makeRange(6.0, 10.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(12.0, 20.0)), range: makeRange(12.0, 20.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Red/Aqua Vapor Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(35.0, 55.0)), range: makeRange(35.0, 55.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false, newFor2022: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospects", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Chrome — Chrome Prospect Autographs (CPA)
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.55, range: makeRange(1.55, 1.55), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Speckle Refractor", printRun: "/299", baselineMultiplier: midpoint(makeRange(1.7, 2.2)), range: makeRange(1.7, 2.2), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(2.0, 2.5)), range: makeRange(2.0, 2.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Blue RayWave Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(3.2, 4.5)), range: makeRange(3.2, 4.5), directCompOnly: false, tierQualifier: null, isAutograph: true, newFor2022: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "HTA Choice Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(3.0, 4.4)), range: makeRange(3.0, 4.4), directCompOnly: false, tierQualifier: "HTA", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Atomic Refractor", printRun: "/100", baselineMultiplier: midpoint(makeRange(3.5, 5.0)), range: makeRange(3.5, 5.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(4.0, 4.8)), range: makeRange(4.0, 4.8), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Green Atomic Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(4.5, 5.5)), range: makeRange(4.5, 5.5), directCompOnly: false, tierQualifier: "HTA", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(5.0, 6.0)), range: makeRange(5.0, 6.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(8.0, 11.5)), range: makeRange(8.0, 11.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Gold Mini Diamond Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(9.0, 13.0)), range: makeRange(9.0, 13.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Gold Shimmer Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(9.0, 13.0)), range: makeRange(9.0, 13.0), directCompOnly: false, tierQualifier: "HTA", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(15.0, 22.0)), range: makeRange(15.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Orange Shimmer Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(17.0, 25.0)), range: makeRange(17.0, 25.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Orange Wave Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(16.0, 23.0)), range: makeRange(16.0, 23.0), directCompOnly: false, tierQualifier: "HTA", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Red Shimmer Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(50.0, 70.0)), range: makeRange(50.0, 70.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Red Wave Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(48.0, 68.0)), range: makeRange(48.0, 68.0), directCompOnly: false, tierQualifier: "HTA", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Black Mojo Refractor", printRun: "1/1", baselineMultiplier: 125.0, range: makeRange(125.0, null), directCompOnly: true, tierQualifier: "HTA", isAutograph: true, note: "direct-comp-only" },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: true, note: "direct-comp-only" },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Prospect Autographs", parallelName: "B&W Mini Diamond Refractor", printRun: "unnumbered", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: "Lite", isAutograph: true },

  // 2022 Bowman Chrome — Chrome Rookie Autographs (BCRA)
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Rookie Autographs", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.55, range: makeRange(1.55, 1.55), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Rookie Autographs", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(8.0, 11.5)), range: makeRange(8.0, 11.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Rookie Autographs", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(15.0, 22.0)), range: makeRange(15.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true },
  { year: 2022, product: "Bowman Chrome", subset: "Chrome Rookie Autographs", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: true, note: "direct-comp-only" },

  // 2022 Bowman Chrome — Image Variation SSP
  { year: 2022, product: "Bowman Chrome", subset: "Image Variation SSP", parallelName: "Image Variation SSP", printRun: "unnumbered", baselineMultiplier: midpoint(makeRange(3.0, 8.0)), range: makeRange(3.0, 8.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },

  // 2022 Bowman Chrome — Inserts
  { year: 2022, product: "Bowman Chrome", subset: "Inserts", parallelName: "Atomic Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Inserts", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(10.0, 18.0)), range: makeRange(10.0, 18.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Inserts", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 200.0, range: makeRange(200.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Chrome — Bowman Ascensions / AFL Relics
  { year: 2022, product: "Bowman Chrome", subset: "Bowman Ascensions / AFL Relics", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(10.0, 18.0)), range: makeRange(10.0, 18.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Chrome", subset: "Bowman Ascensions / AFL Relics", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 200.0, range: makeRange(200.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Draft — Paper Base + Paper Prospects
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Sky Blue Border", printRun: "/499", baselineMultiplier: midpoint(makeRange(1.3, 1.7)), range: makeRange(1.3, 1.7), directCompOnly: false, tierQualifier: null, isAutograph: false, serialGlitchCaveat: true, note: "Topps 2022 serial glitch on 20 cards; print totals still accurate" },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Purple Border", printRun: "/250", baselineMultiplier: midpoint(makeRange(2.0, 2.6)), range: makeRange(2.0, 2.6), directCompOnly: false, tierQualifier: null, isAutograph: false, serialGlitchCaveat: true, note: "Topps 2022 serial glitch on 20 cards; print totals still accurate" },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Aqua Border", printRun: "/199", baselineMultiplier: midpoint(makeRange(2.0, 2.8)), range: makeRange(2.0, 2.8), directCompOnly: false, tierQualifier: null, isAutograph: false, serialGlitchCaveat: true, note: "Topps 2022 serial glitch on 20 cards; print totals still accurate" },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Blue Border", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.8, 4.0)), range: makeRange(2.8, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false, serialGlitchCaveat: true, note: "Topps 2022 serial glitch on 20 cards; print totals still accurate" },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Yellow Border", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.5, 6.5)), range: makeRange(4.5, 6.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Gold Border", printRun: "/50", baselineMultiplier: midpoint(makeRange(7.0, 11.0)), range: makeRange(7.0, 11.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Orange Border", printRun: "/25", baselineMultiplier: midpoint(makeRange(14.0, 22.0)), range: makeRange(14.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Red Border", printRun: "/5", baselineMultiplier: midpoint(makeRange(40.0, 65.0)), range: makeRange(40.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Platinum Border", printRun: "1/1", baselineMultiplier: 100.0, range: makeRange(100.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },
  { year: 2022, product: "Bowman Draft", subset: "Paper Base + Paper Prospects", parallelName: "Printing Plates", printRun: "1/1", baselineMultiplier: 60.0, range: makeRange(60.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Draft — Chrome Prospects
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.0, range: makeRange(1.0, 1.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Speckle Refractor", printRun: "/299", baselineMultiplier: midpoint(makeRange(1.3, 1.6)), range: makeRange(1.3, 1.6), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(1.5, 2.0)), range: makeRange(1.5, 2.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Fuchsia Refractor", printRun: "/199", baselineMultiplier: midpoint(makeRange(1.7, 2.3)), range: makeRange(1.7, 2.3), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Blue Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(2.0, 3.0)), range: makeRange(2.0, 3.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Aqua Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(2.5, 3.5)), range: makeRange(2.5, 3.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(3.0, 4.0)), range: makeRange(3.0, 4.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(4.0, 5.5)), range: makeRange(4.0, 5.5), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(6.0, 10.0)), range: makeRange(6.0, 10.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(12.0, 20.0)), range: makeRange(12.0, 20.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: false },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospects", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: false, note: "direct-comp-only" },

  // 2022 Bowman Draft — Chrome Prospect Autographs
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Refractor", printRun: "/499", baselineMultiplier: 1.55, range: makeRange(1.55, 1.55), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Purple Refractor", printRun: "/250", baselineMultiplier: midpoint(makeRange(2.0, 2.5)), range: makeRange(2.0, 2.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Blue Refractor", printRun: "/150", baselineMultiplier: midpoint(makeRange(3.0, 4.4)), range: makeRange(3.0, 4.4), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Aqua Refractor", printRun: "/125", baselineMultiplier: midpoint(makeRange(2.5, 3.5)), range: makeRange(2.5, 3.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Green Refractor", printRun: "/99", baselineMultiplier: midpoint(makeRange(4.0, 4.8)), range: makeRange(4.0, 4.8), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Yellow Refractor", printRun: "/75", baselineMultiplier: midpoint(makeRange(5.0, 6.0)), range: makeRange(5.0, 6.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Gold Refractor", printRun: "/50", baselineMultiplier: midpoint(makeRange(8.0, 11.5)), range: makeRange(8.0, 11.5), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Orange Refractor", printRun: "/25", baselineMultiplier: midpoint(makeRange(15.0, 22.0)), range: makeRange(15.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Red Refractor", printRun: "/5", baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: true },
  { year: 2022, product: "Bowman Draft", subset: "Chrome Prospect Autographs", parallelName: "Superfractor", printRun: "1/1", baselineMultiplier: 300.0, range: makeRange(300.0, null), directCompOnly: true, tierQualifier: null, isAutograph: true, note: "direct-comp-only" },

  // ─────────────────────────────────────────────────────────────────────────
  // CF-X (2026-06-20): 2026 Bowman — Chrome Prospect Autographs X-Fractor
  // rainbow. PLACEHOLDER multipliers anchored to the closest sibling
  // parallels of the same print run (Blue X-Fractor /150 ← Blue RayWave
  // Refractor /150; Yellow X-Fractor /75 ← Yellow Refractor /75; etc.).
  //
  // CURATION TODO (owner-track): refine baselineMultiplier + range with
  // empirical X-Fractor sales data when available. The `provenance:
  // "sibling_provisional"` flag flows through the engine's
  // estimateBasis: "multiplier_provisional" → iOS "provisional" badge,
  // so users see the honesty marker even with placeholder values.
  //
  // Subject lookup is year-strict on year=2026, so these rows don't
  // collide with any 2022 entry. Hartman's actual holding
  // (cardsightCardId befe9bcc…) carries:
  //   year=2026, product="Bowman", subset="Chrome Prospects Autographs"
  //   (Cardsight uses plural "Prospects"; engine hardcodes singular
  //   "Prospect" — known string mismatch, out of CF-X scope. Engine
  //   lookup uses the singular form; these rows match that form.)
  //
  // Drake Baldwin integration test targets "Blue Refractor" parallel,
  // not "Blue X-Fractor" — additive add, no test conflict.
  { year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs", parallelName: "Blue X-Fractor",   printRun: "/150", baselineMultiplier: midpoint(makeRange(3.2, 4.5)), range: makeRange(3.2, 4.5), directCompOnly: false, tierQualifier: null, isAutograph: true, provenance: "sibling_provisional", note: "PLACEHOLDER — sibling anchor: Blue RayWave Refractor /150" },
  { year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs", parallelName: "Yellow X-Fractor", printRun: "/75",  baselineMultiplier: midpoint(makeRange(5.0, 6.0)), range: makeRange(5.0, 6.0), directCompOnly: false, tierQualifier: null, isAutograph: true, provenance: "sibling_provisional", note: "PLACEHOLDER — sibling anchor: Yellow Refractor /75" },
  { year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs", parallelName: "Orange X-Fractor", printRun: "/25",  baselineMultiplier: midpoint(makeRange(15.0, 22.0)), range: makeRange(15.0, 22.0), directCompOnly: false, tierQualifier: "Hobby", isAutograph: true, provenance: "sibling_provisional", note: "PLACEHOLDER — sibling anchor: Orange Refractor /25" },
  { year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs", parallelName: "Black X-Fractor",  printRun: "/10",  baselineMultiplier: midpoint(makeRange(30.0, 45.0)), range: makeRange(30.0, 45.0), directCompOnly: false, tierQualifier: null, isAutograph: true, provenance: "sibling_provisional", note: "PLACEHOLDER — no 2022 /10 CPA sibling; rough scarcity extrapolation" },
  { year: 2026, product: "Bowman", subset: "Chrome Prospect Autographs", parallelName: "Red X-Fractor",    printRun: "/5",   baselineMultiplier: midpoint(makeRange(45.0, 65.0)), range: makeRange(45.0, 65.0), directCompOnly: false, tierQualifier: null, isAutograph: true, provenance: "sibling_provisional", note: "PLACEHOLDER — sibling anchor: Red Refractor /5" },
];

export const BOWMAN_2022_FAMILY_ENTRIES: ReadonlyArray<BowmanFamilyEntry> = Object.freeze(
  RAW_BOWMAN_2022_FAMILY_ENTRIES.map((entry) => Object.freeze({ ...entry })),
);

interface BowmanFamilyLookupKey {
  product: BowmanFamilyProduct;
  subset: BowmanFamilySubset;
  normalizedParallel: string;
  tierQualifier: BowmanFamilyTierQualifier | null;
}

function makeLookupKey(k: BowmanFamilyLookupKey): string {
  return `${k.product}::${k.subset}::${k.normalizedParallel}::${k.tierQualifier ?? "any"}`;
}

const BOWMAN_2022_STRICT_INDEX: Readonly<Record<string, BowmanFamilyEntry>> = Object.freeze(
  BOWMAN_2022_FAMILY_ENTRIES.reduce<Record<string, BowmanFamilyEntry>>((acc, entry) => {
    const normalizedParallel = normalizeBowmanFamilyParallelName(entry.parallelName);
    acc[
      makeLookupKey({
        product: entry.product,
        subset: entry.subset,
        normalizedParallel,
        tierQualifier: entry.tierQualifier,
      })
    ] = entry;
    return acc;
  }, {}),
);

const BOWMAN_2022_PRODUCT_INDEX: Readonly<Record<string, BowmanFamilyEntry[]>> = Object.freeze(
  BOWMAN_2022_FAMILY_ENTRIES.reduce<Record<string, BowmanFamilyEntry[]>>((acc, entry) => {
    const k = `${entry.product}::${normalizeBowmanFamilyParallelName(entry.parallelName)}`;
    const arr = acc[k] ?? [];
    arr.push(entry);
    acc[k] = arr;
    return acc;
  }, {}),
);

const BOWMAN_2022_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "sky blue": "Sky Blue Border",
  "refractors": "Refractor",
  "fuchsia": "Fuchsia Refractor",
  "purple": "Purple Refractor",
  "aqua raywave": "Aqua RayWave Refractor",
  "black and white mini diamond": "B&W Mini Diamond Refractor",
  "b&w mini diamond": "B&W Mini Diamond Refractor",
  "green mini-diamond": "B&W Mini Diamond Refractor",
  "green mini diamond": "B&W Mini Diamond Refractor",
  "blue": "Blue Refractor",
  "green": "Green Refractor",
  "yellow": "Yellow Refractor",
  "gold": "Gold Refractor",
  "orange": "Orange Refractor",
  "red": "Red Refractor",
  "superfractors": "Superfractor",
  "shimmer": "Shimmer Refractor",
  "fuchsia/pink vapor": "Aqua/Pink Vapor Refractor",
  "fuchsia shimmer": "Fuchsia Shimmer Refractor",
  "aqua": "Aqua Refractor",
  "aqua/pink vapor": "Aqua/Pink Vapor Refractor",
  "yellow/orange vapor": "Yellow/Orange Vapor Refractor",
  "red/aqua vapor": "Red/Aqua Vapor Refractor",
  "blue raywave": "Blue RayWave Refractor",
  "hta choice": "HTA Choice Refractor",
  "atomic": "Atomic Refractor",
  "green atomic": "Green Atomic Refractor",
  "gold mini diamond": "Gold Mini Diamond Refractor",
  "gold shimmer": "Gold Shimmer Refractor",
  "orange wave": "Orange Wave Refractor",
  "red wave": "Red Wave Refractor",
  "black mojo": "Black Mojo Refractor",
  "printing plate": "Printing Plates",
  "printing plates": "Printing Plates",
});

export interface BowmanFamilyLookupContext {
  product: BowmanFamilyProduct;
  subset: BowmanFamilySubset;
  parallelName: string;
  tierQualifier?: BowmanFamilyTierQualifier;
  /**
   * CF-X (2026-06-20): year-strict match when provided. Subject-side
   * callers should always pass year so a 2026 X-Fractor request can't
   * accidentally resolve to a 2022 entry. Peer-side callers (comp-pool
   * resolution in buildParsedCompPool) may omit year — in that case the
   * lookup matches any year (back-compat). Once peer-year-strict mode is
   * supported (own CF, requires parsing year from comp titles), this
   * field becomes effectively required.
   */
  year?: number;
}

function resolveBowman2022Alias(
  normalized: string,
  rawInput: string,
): string {
  const rawLower = rawInput.toLowerCase();
  if (normalized === "sky blue" && rawLower.includes("refractor")) {
    return normalized;
  }
  return BOWMAN_2022_ALIASES[normalized] ?? rawInput;
}

export function lookupBowmanFamilyEntry(
  ctx: BowmanFamilyLookupContext,
): BowmanFamilyEntry | null {
  const normalized = normalizeBowmanFamilyParallelName(ctx.parallelName);
  const aliased = normalizeBowmanFamilyParallelName(
    resolveBowman2022Alias(normalized, ctx.parallelName),
  );

  // CF-X (2026-06-20): year-strict match when ctx.year is provided. The
  // pre-built STRICT_INDEX doesn't include year in its key (back-compat),
  // so a tiered hit is verified against ctx.year before being returned.
  const tieredKey = makeLookupKey({
    product: ctx.product,
    subset: ctx.subset,
    normalizedParallel: aliased,
    tierQualifier: ctx.tierQualifier ?? null,
  });
  const tieredHit = BOWMAN_2022_STRICT_INDEX[tieredKey];
  if (tieredHit && (ctx.year === undefined || tieredHit.year === ctx.year)) {
    return tieredHit;
  }

  if (!ctx.tierQualifier) {
    const candidates = BOWMAN_2022_FAMILY_ENTRIES.filter(
      (entry) =>
        entry.product === ctx.product &&
        entry.subset === ctx.subset &&
        normalizeBowmanFamilyParallelName(entry.parallelName) === aliased &&
        (ctx.year === undefined || entry.year === ctx.year),
    );
    if (candidates.length === 1) return candidates[0]!;
  }
  return null;
}

export function lookupBowmanFamilyByProduct(
  product: BowmanFamilyProduct,
  parallelName: string,
): BowmanFamilyEntry | null {
  const normalized = normalizeBowmanFamilyParallelName(parallelName);
  const aliased = normalizeBowmanFamilyParallelName(
    resolveBowman2022Alias(normalized, parallelName),
  );
  const candidates = BOWMAN_2022_PRODUCT_INDEX[`${product}::${aliased}`] ?? [];
  if (candidates.length === 0) return null;
  // Deterministic pick for broad product-level coverage checks.
  const preferred =
    candidates.find((c) => c.tierQualifier === null) ??
    candidates.find((c) => c.tierQualifier === "Hobby") ??
    candidates[0]!;
  return preferred;
}
