/**
 * Beckett Brand Registry — single source of truth for which baseball products
 * exist, which family they belong to, plausible year bounds, and any known
 * Beckett URL spelling variants.
 *
 * Status: **DRAFT for owner review (Phase A.3 prep).**
 *
 *   - Bowman family was the Phase A.2 scope; entries here mirror the
 *     `BRAND_VARIANTS` table from beckettUrlDiscovery.ts.
 *   - Topps / Panini / Leaf / Onyx entries are best-guess launch and end
 *     years based on hobby knowledge. **Every one of these year bounds is
 *     subject to owner review.** Misses during the A.3 sweep will surface
 *     in REPORT-A3.md and tighten this table over time.
 *   - URL variants are seeded with the most common Beckett filename forms.
 *     `BeckettUrlDiscovery` will probe these in order; any non-primary
 *     variant that wins gets flagged in REPORT-A3.md.
 *
 * Constraints honored:
 *   - No cross-family canonicalization — each entry is independent.
 *   - Brand registry is the input to `sweepOrchestrator`; it does NOT
 *     replace the Phase A.2 hardcoded list until the orchestrator is
 *     migrated in the A.3 implementation step (gated on owner sign-off).
 */

/** Brand family — used by the normalizer for brand-scoped table lookup
 *  and by REPORT-A3.md for family-level coverage roll-ups. */
export type BrandFamily = "Bowman" | "Topps" | "Panini" | "Leaf" | "Onyx" | "Other";

export interface BrandRegistryEntry {
  /** Canonical brand label — used as map key everywhere downstream. */
  brandName: string;
  family: BrandFamily;
  /**
   * First year this brand published a baseball checklist (best guess).
   * The orchestrator skips `year < firstYear` tuples to avoid pointless
   * probes. `null` = no lower bound known, probe full range.
   */
  firstYear: number | null;
  /**
   * Last year (inclusive). `null` = still active or no known end.
   * Used to skip e.g. Topps Sterling 2020+ since it went defunct.
   */
  lastYear: number | null;
  /**
   * Beckett filename-segment variants in priority order. First entry is the
   * canonical/preferred spelling. Variants come from observed Beckett URLs.
   */
  urlVariants: readonly string[];
  /** Optional owner-facing note (defunct year, special filename pattern, etc). */
  notes?: string;
  /**
   * Cardboard Connection WordPress filename segment variants in priority order.
   * These variants feed the CC URL discovery ladder and are independent from
   * Beckett's S3 naming quirks.
   */
  cardboardConnectionUrlVariants?: readonly string[];
}

/**
 * Sport-segment placement quirk. Most Beckett URLs read
 * `{Year}-{Brand}-Baseball-Checklist.xlsx`, but a handful of products
 * historically used `{Year}-{Brand}-Checklist-Baseball.xlsx` or omitted the
 * sport entirely. The URL discovery layer probes both placements — these
 * are NOT brand-specific and live in beckettUrlDiscovery.ts.
 */

// ---------------------------------------------------------------------------
// Bowman family (Phase A.2 scope — already covered, included for completeness)
// ---------------------------------------------------------------------------

const BOWMAN_FAMILY: readonly BrandRegistryEntry[] = [
  { brandName: "Bowman",              family: "Bowman", firstYear: null, lastYear: null, urlVariants: ["Bowman"] },
  { brandName: "Bowman Chrome",       family: "Bowman", firstYear: null, lastYear: null, urlVariants: ["Bowman-Chrome", "BowmanChrome", "Bowman-Chrome-HTA"] },
  { brandName: "Bowman Draft",        family: "Bowman", firstYear: null, lastYear: null, urlVariants: ["Bowman-Draft", "Bowman-Chrome-Draft", "BowmanDraft", "Bowman-Draft-Picks-and-Prospects"] },
  { brandName: "Bowman Sterling",     family: "Bowman", firstYear: 2004, lastYear: 2018, urlVariants: ["Bowman-Sterling", "BowmanSterling"], notes: "Defunct ~2018." },
  { brandName: "Bowman Platinum",     family: "Bowman", firstYear: 2010, lastYear: null, urlVariants: ["Bowman-Platinum", "BowmanPlatinum"] },
  { brandName: "Bowman's Best",       family: "Bowman", firstYear: 1994, lastYear: null, urlVariants: ["Bowmans-Best", "Bowman-s-Best", "BowmansBest", "Bowmans-Best-Baseball"], notes: "Hiatus 2008-2015, returned 2016." },
  { brandName: "Bowman Mega",         family: "Bowman", firstYear: 2020, lastYear: null, urlVariants: ["Bowman-Mega", "BowmanMega", "Bowman-Mega-Box"] },
  { brandName: "Bowman Inception",    family: "Bowman", firstYear: 2021, lastYear: null, urlVariants: ["Bowman-Inception", "BowmanInception"] },
  { brandName: "Bowman Transcendent", family: "Bowman", firstYear: 2017, lastYear: null, urlVariants: ["Bowman-Transcendent", "BowmanTranscendent"], notes: "Sporadic releases." },
  { brandName: "Bowman Heritage",     family: "Bowman", firstYear: 2017, lastYear: null, urlVariants: ["Bowman-Heritage", "BowmanHeritage"] },
];

// ---------------------------------------------------------------------------
// Topps family — A.3 scope
// ---------------------------------------------------------------------------

const TOPPS_FAMILY: readonly BrandRegistryEntry[] = [
  {
    brandName: "Topps",
    family: "Topps",
    firstYear: null,
    lastYear: null,
    urlVariants: ["Topps"],
    cardboardConnectionUrlVariants: [
      "Topps",
      "Topps-Series-1",
      "Topps-Series-2",
      "Topps-Update",
    ],
    notes: "Flagship — always present. Series 1/2/Update disambiguation is a separate structural question.",
  },
  { brandName: "Topps Update",                   family: "Topps", firstYear: 2007, lastYear: null, urlVariants: ["Topps-Update", "ToppsUpdate", "Topps-Update-Series"] },
  { brandName: "Topps Chrome",                   family: "Topps", firstYear: null, lastYear: null, urlVariants: ["Topps-Chrome", "ToppsChrome"] },
  { brandName: "Topps Chrome Update",            family: "Topps", firstYear: 2014, lastYear: null, urlVariants: ["Topps-Chrome-Update", "ToppsChromeUpdate"] },
  { brandName: "Topps Heritage",                 family: "Topps", firstYear: 2001, lastYear: null, urlVariants: ["Topps-Heritage", "ToppsHeritage"] },
  { brandName: "Topps Heritage Minor League",    family: "Topps", firstYear: 2013, lastYear: null, urlVariants: ["Topps-Heritage-Minor-League", "Topps-Heritage-Minors", "ToppsHeritageMinorLeague"] },
  { brandName: "Topps Heritage High Number",     family: "Topps", firstYear: 2013, lastYear: null, urlVariants: ["Topps-Heritage-High-Number", "Topps-Heritage-High-Numbers", "ToppsHeritageHighNumber"] },
  { brandName: "Topps Stadium Club",             family: "Topps", firstYear: 2014, lastYear: null, urlVariants: ["Topps-Stadium-Club", "Stadium-Club", "ToppsStadiumClub"], notes: "Hiatus 2009-2013; returned 2014. May also be filed under bare 'Stadium-Club'." },
  { brandName: "Topps Stadium Club Chrome",      family: "Topps", firstYear: 2014, lastYear: null, urlVariants: ["Topps-Stadium-Club-Chrome", "Stadium-Club-Chrome", "ToppsStadiumClubChrome"] },
  { brandName: "Topps Allen & Ginter",           family: "Topps", firstYear: 2006, lastYear: null, urlVariants: ["Topps-Allen-and-Ginter", "Topps-Allen-Ginter", "Allen-and-Ginter", "Allen-Ginter", "ToppsAllenAndGinter"] },
  { brandName: "Topps Allen & Ginter Chrome",    family: "Topps", firstYear: 2020, lastYear: null, urlVariants: ["Topps-Allen-and-Ginter-Chrome", "Topps-Allen-Ginter-Chrome", "Allen-and-Ginter-Chrome"] },
  { brandName: "Topps Gypsy Queen",              family: "Topps", firstYear: 2011, lastYear: null, urlVariants: ["Topps-Gypsy-Queen", "Gypsy-Queen", "ToppsGypsyQueen"] },
  { brandName: "Topps Archives",                 family: "Topps", firstYear: 2012, lastYear: null, urlVariants: ["Topps-Archives", "ToppsArchives"] },
  { brandName: "Topps Archives Snapshots",       family: "Topps", firstYear: 2017, lastYear: 2019, urlVariants: ["Topps-Archives-Snapshots", "ToppsArchivesSnapshots"], notes: "Online-exclusive product, likely discontinued." },
  { brandName: "Topps Tier One",                 family: "Topps", firstYear: 2011, lastYear: null, urlVariants: ["Topps-Tier-One", "Tier-One", "ToppsTierOne"] },
  { brandName: "Topps Triple Threads",           family: "Topps", firstYear: 2006, lastYear: null, urlVariants: ["Topps-Triple-Threads", "Triple-Threads", "ToppsTripleThreads"] },
  { brandName: "Topps Definitive Collection",    family: "Topps", firstYear: 2018, lastYear: null, urlVariants: ["Topps-Definitive-Collection", "Topps-Definitive", "ToppsDefinitive"] },
  { brandName: "Topps Dynasty",                  family: "Topps", firstYear: 2015, lastYear: null, urlVariants: ["Topps-Dynasty", "ToppsDynasty"] },
  { brandName: "Topps Five Star",                family: "Topps", firstYear: 2012, lastYear: null, urlVariants: ["Topps-Five-Star", "Five-Star", "ToppsFiveStar"] },
  { brandName: "Topps Museum Collection",        family: "Topps", firstYear: 2013, lastYear: null, urlVariants: ["Topps-Museum-Collection", "Museum-Collection", "ToppsMuseumCollection"] },
  { brandName: "Topps Pristine",                 family: "Topps", firstYear: 2022, lastYear: null, urlVariants: ["Topps-Pristine", "ToppsPristine"], notes: "Defunct mid-2000s, revived 2022." },
  { brandName: "Topps Finest",                   family: "Topps", firstYear: null, lastYear: null, urlVariants: ["Topps-Finest", "Finest", "ToppsFinest"] },
  { brandName: "Topps Inception",                family: "Topps", firstYear: 2013, lastYear: null, urlVariants: ["Topps-Inception", "Inception", "ToppsInception"] },
  { brandName: "Topps Big League",               family: "Topps", firstYear: 2018, lastYear: null, urlVariants: ["Topps-Big-League", "Big-League", "ToppsBigLeague"] },
  { brandName: "Topps Fire",                     family: "Topps", firstYear: 2016, lastYear: null, urlVariants: ["Topps-Fire", "ToppsFire"] },
  { brandName: "Topps Gold Label",               family: "Topps", firstYear: 2016, lastYear: null, urlVariants: ["Topps-Gold-Label", "Gold-Label", "ToppsGoldLabel"], notes: "Revival of 1990s product." },
  { brandName: "Topps Holiday",                  family: "Topps", firstYear: 2016, lastYear: null, urlVariants: ["Topps-Holiday", "ToppsHoliday", "Topps-Holiday-Mega-Box"] },
  { brandName: "Topps Opening Day",              family: "Topps", firstYear: null, lastYear: null, urlVariants: ["Topps-Opening-Day", "Opening-Day", "ToppsOpeningDay"] },
  { brandName: "Topps Pro Debut",                family: "Topps", firstYear: 2008, lastYear: null, urlVariants: ["Topps-Pro-Debut", "Pro-Debut", "ToppsProDebut"] },
  { brandName: "Topps Sterling",                 family: "Topps", firstYear: 2006, lastYear: 2010, urlVariants: ["Topps-Sterling", "ToppsSterling"], notes: "Discontinued ~2010." },
  { brandName: "Topps Tribute",                  family: "Topps", firstYear: null, lastYear: null, urlVariants: ["Topps-Tribute", "Tribute", "ToppsTribute"] },
  { brandName: "Topps Transcendent",             family: "Topps", firstYear: 2016, lastYear: null, urlVariants: ["Topps-Transcendent", "ToppsTranscendent"], notes: "Sporadic high-end release; not annual." },
];

// ---------------------------------------------------------------------------
// Panini family — A.3 scope (Panini holds MLBPA-only license post-2021; pre-
// 2014 Panini baseball products are sparse / unlicensed-logo era)
// ---------------------------------------------------------------------------

const PANINI_FAMILY: readonly BrandRegistryEntry[] = [
  { brandName: "Donruss",                  family: "Panini", firstYear: 2014, lastYear: null, urlVariants: ["Donruss", "Panini-Donruss"], notes: "Panini took license in 2014." },
  { brandName: "Donruss Optic",            family: "Panini", firstYear: 2016, lastYear: null, urlVariants: ["Donruss-Optic", "Panini-Donruss-Optic", "DonrussOptic"] },
  { brandName: "Diamond Kings",            family: "Panini", firstYear: 2015, lastYear: null, urlVariants: ["Diamond-Kings", "Panini-Diamond-Kings", "DiamondKings"] },
  { brandName: "Chronicles",               family: "Panini", firstYear: 2020, lastYear: null, urlVariants: ["Chronicles", "Panini-Chronicles"] },
  { brandName: "Immaculate Collection",    family: "Panini", firstYear: 2014, lastYear: null, urlVariants: ["Immaculate", "Immaculate-Collection", "Panini-Immaculate", "Panini-Immaculate-Collection"] },
  { brandName: "National Treasures",       family: "Panini", firstYear: 2014, lastYear: null, urlVariants: ["National-Treasures", "Panini-National-Treasures", "NationalTreasures"] },
  { brandName: "Flawless",                 family: "Panini", firstYear: 2016, lastYear: null, urlVariants: ["Flawless", "Panini-Flawless"] },
  { brandName: "Contenders",               family: "Panini", firstYear: 2014, lastYear: null, urlVariants: ["Contenders", "Panini-Contenders"] },
  { brandName: "Elite Extra Edition",      family: "Panini", firstYear: 2008, lastYear: null, urlVariants: ["Elite-Extra-Edition", "Panini-Elite-Extra-Edition", "EliteExtraEdition"], notes: "Draft-pick product." },
  { brandName: "Prizm",                    family: "Panini", firstYear: 2012, lastYear: null, urlVariants: ["Prizm", "Panini-Prizm"] },
  { brandName: "Select",                   family: "Panini", firstYear: 2013, lastYear: null, urlVariants: ["Select", "Panini-Select"] },
  { brandName: "Absolute",                 family: "Panini", firstYear: 2022, lastYear: null, urlVariants: ["Absolute", "Panini-Absolute"], notes: "Revived 2022; defunct in interim." },
  { brandName: "Limited",                  family: "Panini", firstYear: 2010, lastYear: 2011, urlVariants: ["Limited", "Panini-Limited"], notes: "Short-lived." },
  { brandName: "Pinnacle",                 family: "Panini", firstYear: 2013, lastYear: 2013, urlVariants: ["Pinnacle", "Panini-Pinnacle"], notes: "One-off 2013 release." },
  { brandName: "Score",                    family: "Panini", firstYear: null, lastYear: 2012, urlVariants: ["Score", "Panini-Score"], notes: "Baseball line discontinued — verify availability." },
];

// ---------------------------------------------------------------------------
// Leaf family — A.3 scope
// ---------------------------------------------------------------------------

const LEAF_FAMILY: readonly BrandRegistryEntry[] = [
  { brandName: "Leaf Metal",      family: "Leaf", firstYear: 2012, lastYear: null, urlVariants: ["Leaf-Metal", "Leaf-Metal-Draft", "LeafMetal"] },
  { brandName: "Leaf Trinity",    family: "Leaf", firstYear: 2016, lastYear: null, urlVariants: ["Leaf-Trinity", "LeafTrinity"] },
  { brandName: "Leaf Valiant",    family: "Leaf", firstYear: 2018, lastYear: null, urlVariants: ["Leaf-Valiant", "LeafValiant"] },
  { brandName: "Leaf Pearl",      family: "Leaf", firstYear: 2018, lastYear: null, urlVariants: ["Leaf-Pearl", "LeafPearl"] },
  { brandName: "Leaf Ultimate",   family: "Leaf", firstYear: 2012, lastYear: null, urlVariants: ["Leaf-Ultimate", "Leaf-Ultimate-Draft", "LeafUltimate"] },
];

// ---------------------------------------------------------------------------
// Onyx + Other — A.3 scope
// ---------------------------------------------------------------------------

const OTHER_FAMILY: readonly BrandRegistryEntry[] = [
  { brandName: "Onyx", family: "Onyx", firstYear: 2017, lastYear: null, urlVariants: ["Onyx", "Onyx-Vintage", "Onyx-Premium"], notes: "Multiple Onyx sub-products; may need separate entries after owner review." },
];

// ---------------------------------------------------------------------------
// Master export
// ---------------------------------------------------------------------------

export const BRAND_REGISTRY: readonly BrandRegistryEntry[] = Object.freeze([
  ...BOWMAN_FAMILY,
  ...TOPPS_FAMILY,
  ...PANINI_FAMILY,
  ...LEAF_FAMILY,
  ...OTHER_FAMILY,
]);

/** Lookup helper — case-sensitive on canonical brandName. */
export function getBrandEntry(brandName: string): BrandRegistryEntry | undefined {
  return BRAND_REGISTRY.find((e) => e.brandName === brandName);
}

/** Filter entries by family — used by the orchestrator to scope A.3 to non-Bowman. */
export function getBrandsByFamily(family: BrandFamily): readonly BrandRegistryEntry[] {
  return BRAND_REGISTRY.filter((e) => e.family === family);
}

/** All non-Bowman brands — A.3 sweep input set. */
export function getNonBowmanBrands(): readonly BrandRegistryEntry[] {
  return BRAND_REGISTRY.filter((e) => e.family !== "Bowman");
}

/**
 * Returns true if `year` falls within the registered bounds for the brand.
 * Used by the orchestrator to skip impossible (brand, year) tuples without
 * wasting HEAD probes.
 */
export function isYearInBounds(entry: BrandRegistryEntry, year: number): boolean {
  if (entry.firstYear !== null && year < entry.firstYear) return false;
  if (entry.lastYear !== null && year > entry.lastYear) return false;
  return true;
}

/** Total registered brand count — sanity check for the owner-review pass. */
export const BRAND_REGISTRY_COUNT = BRAND_REGISTRY.length;
