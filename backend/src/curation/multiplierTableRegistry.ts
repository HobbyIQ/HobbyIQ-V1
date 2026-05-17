/**
 * Multiplier-Table Registry — Phase B (rewrite) curation pipeline.
 *
 * Wraps owner-curated per-brand multiplier tables behind a uniform lookup
 * surface so the curation harness (eligibility analyzer, worksheet generator,
 * apply script) never has to know which underlying source it's reading from.
 *
 * Locked rules (per phase-b-rewrite-prompt.md, section "Architectural
 * decisions"):
 *   - Multiplier tables are brand-scoped. No cross-brand canonicalization.
 *   - A set is eligible for Phase B only if 100% of its parallels are
 *     covered by its brand's multiplier table. The registry is the gating
 *     coverage check.
 *   - The 54-entry Chrome/Draft table is the only owner-curated table that
 *     exists today. Other brands return an empty table (zero coverage)
 *     until the owner publishes one.
 *
 * No I/O, no Cosmos, no side effects. Pure data + lookups.
 */

import {
  CHROME_DRAFT_MULTIPLIERS,
  BOWMAN_2022_FAMILY_ENTRIES,
  lookupBowmanFamilyByProduct,
  lookupBowmanFamilyEntry,
  type BowmanFamilyEntry,
  type BowmanFamilyProduct,
  type BowmanFamilySubset,
  type BowmanFamilyTierQualifier,
  type ChromeDraftEntry,
  type ChromeDraftColorTier,
  lookupMultiplier as lookupChromeDraft,
} from "../services/compiq/chromeDraftMultipliers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Worksheet-facing entry — what the harness needs per canonical parallel.
 *
 * `tierWithinSet` is the integer ordering on the schema's
 * `parallel_attributes` validator (positive integer, 1 = base, higher =
 * rarer). The string colorTier label is also carried for owner clarity.
 *
 * `parentVariant` is the canonical name of the immediate parent in the
 * scarcity chain (e.g. "Blue Shimmer" → "Blue"; "Refractor" → null; "Base
 * Auto" → null). This is a registry-supplied derivation, NOT a field on the
 * source multiplier table — see `deriveParentVariant()` below for the rules.
 *
 * `baselineMultiplier` is the Base-Auto-anchored multiplier (1.000 at Base
 * Auto / unnumbered).
 */
export interface MultiplierTableEntry {
  canonicalParallelName: string;
  colorTier: string;
  tierWithinSet: number;
  parentVariant: string | null;
  baselineMultiplier: number;
  refractorMultiplier: number;
  printRun: string;
  rangeLow?: number | null;
  rangeHigh?: number | null;
  directCompOnly?: boolean;
  subset?: string;
  tierQualifier?: string | null;
  product?: string;
  year?: number;
  notes?: string;
}

export interface MultiplierTable {
  brand: string;
  family: "Bowman" | "Topps" | "Panini" | "Leaf" | "Onyx" | "Other";
  /** Indexed by canonical Title-Case parallelName. */
  entries: ReadonlyMap<string, MultiplierTableEntry>;
  /**
   * Frozen version label — bumped by hand when the owner edits the
   * underlying table. Used by the orchestrator to detect worksheet drift.
   */
  version: string;
}

// ---------------------------------------------------------------------------
// Tier ordering (string colorTier → integer tierWithinSet)
// ---------------------------------------------------------------------------

/**
 * Maps the Chrome/Draft `ChromeDraftColorTier` string labels onto the integer
 * `tierWithinSet` field required by the locked `parallel_attributes` schema
 * (`parallelsReference/ingestion.ts` validator: positive integer, 1 = base).
 *
 * This ordering is the owner-implied scarcity ladder of the 54-entry table.
 * It is NOT a schema-doc commitment — when the schema migrates to a string
 * `tierWithinSet` (per parallels-reference-schema.md §2.3.2), this map can
 * be deprecated.
 */
const COLOR_TIER_ORDER: Record<ChromeDraftColorTier, number> = {
  Base: 1,
  "Early Color": 2,
  "Atomic Tier": 3,
  "Blue Tier": 4,
  "Green Tier": 5,
  "Yellow Tier": 6,
  "Gold Tier": 7,
  "Orange Tier": 8,
  "Black Tier": 9,
  "Red Tier": 10,
  "1/1 Tier": 11,
  HTA: 4, // HTA Choice tracks the blue band by owner convention
};

// ---------------------------------------------------------------------------
// Parent-variant derivation
// ---------------------------------------------------------------------------

/**
 * Returns the canonical parent variant for a Chrome/Draft parallel.
 *
 * Rules (in order, first match wins):
 *   - Anchors: "Base Auto", "Refractor", "Printing Plate" → null.
 *   - Superfractor and Superfractor variants → null (1/1 anchor).
 *   - HTA Choice subset chains off "HTA Choice Refractor".
 *   - Multi-token parallels chain off their first color token if it exists
 *     as a registered base color (e.g. "Blue Shimmer" → "Blue"; "Gold
 *     Sapphire" → "Gold"; "Yellow Mini Diamond" → "Yellow").
 *   - Single-token color parallels chain off "Refractor".
 *   - Anything unmatched → null (will surface on the worksheet for owner
 *     to override).
 *
 * The function operates on the canonical Title-Case names found in the
 * Chrome/Draft table and is intentionally conservative: when in doubt it
 * returns null rather than guess.
 */
function deriveParentVariantChromeDraft(canonicalName: string): string | null {
  if (canonicalName === "Base Auto" || canonicalName === "Refractor" || canonicalName === "Printing Plate") {
    return null;
  }
  if (canonicalName.startsWith("Superfractor")) {
    return null;
  }
  if (canonicalName === "HTA Choice Refractor") {
    return null;
  }
  if (canonicalName.startsWith("HTA Choice ")) {
    return "HTA Choice Refractor";
  }
  // Multi-token color parallels — chain off the first color token.
  const baseColors = new Set([
    "Speckle",
    "Purple",
    "Atomic",
    "Blue",
    "Green",
    "Yellow",
    "Gold",
    "Orange",
    "Black",
    "Red",
  ]);
  const firstToken = canonicalName.split(" ")[0] ?? "";
  if (firstToken && canonicalName !== firstToken && baseColors.has(firstToken)) {
    return firstToken;
  }
  // Single-token color parallels chain off "Refractor".
  if (baseColors.has(canonicalName)) {
    return "Refractor";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build Chrome/Draft table
// ---------------------------------------------------------------------------

function buildChromeDraftTable(): MultiplierTable {
  const entries = new Map<string, MultiplierTableEntry>();
  for (const e of Object.values(CHROME_DRAFT_MULTIPLIERS) as ChromeDraftEntry[]) {
    const tierWithinSet = COLOR_TIER_ORDER[e.colorTier] ?? 1;
    const parentVariant = deriveParentVariantChromeDraft(e.parallelName);
    entries.set(e.parallelName, {
      canonicalParallelName: e.parallelName,
      colorTier: e.colorTier,
      tierWithinSet,
      parentVariant,
      baselineMultiplier: e.baseMultiplier,
      refractorMultiplier: e.refractorMultiplier,
      printRun: e.printRun,
    });
  }
  return Object.freeze({
    brand: "Bowman Chrome",
    family: "Bowman",
    entries,
    version: "chrome-draft-v1-2026-05-17",
  });
}

const CHROME_DRAFT_TABLE = buildChromeDraftTable();

const BOWMAN_FAMILY_2022_VERSION = "bowman-family-2022-v1-2026-05-17";

const BOWMAN_FAMILY_BRANDS: ReadonlySet<string> = new Set([
  "Bowman",
  "Bowman Chrome",
  "Bowman Draft",
]);

function mapBrandToProduct(brand: string): BowmanFamilyProduct | null {
  if (brand === "Bowman") return "Bowman";
  if (brand === "Bowman Chrome") return "Bowman Chrome";
  if (brand === "Bowman Draft" || brand === "Bowman Chrome Draft") return "Bowman Draft";
  return null;
}

function tierFromPrintRun(printRun: string): number {
  if (printRun === "1/1") return 11;
  const m = printRun.match(/\/(\d+)/);
  if (!m) return 1;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 1;
  if (n <= 5) return 10;
  if (n <= 25) return 8;
  if (n <= 50) return 7;
  if (n <= 75) return 6;
  if (n <= 99) return 5;
  if (n <= 150) return 4;
  if (n <= 299) return 2;
  return 1;
}

function fromBowmanFamilyEntry(entry: BowmanFamilyEntry): MultiplierTableEntry {
  return {
    canonicalParallelName: entry.parallelName,
    colorTier: entry.subset,
    tierWithinSet: tierFromPrintRun(entry.printRun),
    parentVariant: null,
    baselineMultiplier: entry.baselineMultiplier,
    refractorMultiplier: entry.baselineMultiplier,
    printRun: entry.printRun,
    rangeLow: entry.range.low,
    rangeHigh: entry.range.high,
    directCompOnly: entry.directCompOnly,
    subset: entry.subset,
    tierQualifier: entry.tierQualifier,
    product: entry.product,
    year: entry.year,
    notes: entry.note,
  };
}

function buildBowmanFamily2022Table(brand: string): MultiplierTable {
  const product = mapBrandToProduct(brand);
  if (!product) return emptyTable(brand);
  const entries = new Map<string, MultiplierTableEntry>();
  for (const entry of BOWMAN_2022_FAMILY_ENTRIES) {
    if (entry.product !== product) continue;
    const key = entry.parallelName;
    if (!entries.has(key)) entries.set(key, fromBowmanFamilyEntry(entry));
  }
  return Object.freeze({
    brand,
    family: "Bowman",
    entries,
    version: BOWMAN_FAMILY_2022_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Brand → table mapping
// ---------------------------------------------------------------------------

/**
 * Brands that share the same multiplier table. Bowman Chrome, Bowman Draft
 * (Chrome variant), and per-owner instruction, the Bowman Chrome line of
 * inserts all use the 54-entry chrome-draft table. Plain Bowman (non-Chrome
 * base set) has its own scarcity ladder and is NOT covered by chrome-draft —
 * the owner has not authored a Bowman-base multiplier table yet.
 */
const BRAND_TABLE_ALIASES: Readonly<Record<string, MultiplierTable>> = Object.freeze({
  "Bowman Chrome": CHROME_DRAFT_TABLE,
  "Bowman Draft": CHROME_DRAFT_TABLE,
  "Bowman Chrome Draft": CHROME_DRAFT_TABLE,
});

/** Empty table for brands with no owner-curated multiplier table yet. */
function emptyTable(brand: string): MultiplierTable {
  return Object.freeze({
    brand,
    family: "Other",
    entries: new Map(),
    version: "empty-no-curation",
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the multiplier table for `brand`. Brands without a published table
 * return an empty table — callers should treat empty as "no coverage" and
 * report the set ineligible.
 */
export function getTable(brand: string): MultiplierTable {
  return BRAND_TABLE_ALIASES[brand] ?? emptyTable(brand);
}

export function getTableForYear(brand: string, year?: number): MultiplierTable {
  if (year === 2022 && BOWMAN_FAMILY_BRANDS.has(brand)) {
    return buildBowmanFamily2022Table(brand);
  }
  return getTable(brand);
}

/**
 * True if the brand has any multiplier-table entries at all. Used by the
 * orchestrator to short-circuit ineligibility reporting before per-parallel
 * coverage analysis.
 */
export function brandHasTable(brand: string, year?: number): boolean {
  const table = getTableForYear(brand, year);
  return table.entries.size > 0;
}

/**
 * True if a specific (brand, parallelName) combination is covered by the
 * brand's multiplier table. Uses the same fuzzy normalization as
 * `chromeDraftMultipliers.lookupMultiplier()` for Chrome/Draft brands.
 */
export interface LookupContext {
  year?: number;
  subset?: BowmanFamilySubset;
  tierQualifier?: BowmanFamilyTierQualifier;
}

export function hasCoverage(brand: string, parallelName: string, context: LookupContext = {}): boolean {
  return lookup(brand, parallelName, context) !== null;
}

/**
 * Look up the canonical multiplier entry for a (brand, parallelName).
 * Returns null when uncovered. Brands aliased onto the Chrome/Draft table
 * use `lookupChromeDraft()` so Beckett's raw spellings ("Blue Refractor",
 * "Blue Auto", "BLUE") all collapse onto the canonical "Blue" entry.
 */
export function lookup(
  brand: string,
  parallelName: string,
  context: LookupContext = {},
): MultiplierTableEntry | null {
  const table = getTableForYear(brand, context.year);
  if (table.entries.size === 0) return null;

  if (context.year === 2022) {
    const product = mapBrandToProduct(brand);
    if (product) {
      if (context.subset) {
        const strict = lookupBowmanFamilyEntry({
          product,
          subset: context.subset,
          parallelName,
          tierQualifier: context.tierQualifier,
        });
        if (strict) return fromBowmanFamilyEntry(strict);
      }
      const broad = lookupBowmanFamilyByProduct(product, parallelName);
      if (broad) return fromBowmanFamilyEntry(broad);
      return null;
    }
  }

  // Chrome/Draft fuzzy lookup
  if (table === CHROME_DRAFT_TABLE) {
    const ch = lookupChromeDraft(parallelName);
    if (!ch) return null;
    return table.entries.get(ch.parallelName) ?? null;
  }
  // Fallback exact match (case-insensitive) for any future brands
  const direct = table.entries.get(parallelName);
  if (direct) return direct;
  const lower = parallelName.toLowerCase();
  for (const [k, v] of table.entries) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * Returns all canonical parallel names for a brand. Used by the worksheet
 * generator to surface "what parallels does the curator already have curated
 * for this brand?" sidebar info.
 */
export function listCoveredParallels(brand: string, year?: number): readonly string[] {
  return Array.from(getTableForYear(brand, year).entries.keys());
}

/** Total number of brands with a registered (non-empty) table. */
export function registeredBrandCount(): number {
  return Object.keys(BRAND_TABLE_ALIASES).length;
}
