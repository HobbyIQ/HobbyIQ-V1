/**
 * CF-CATALOG-FIRST P1 — parallel ladders (Drew, 2026-08-04).
 *
 * Hardcoded standard parallel structures per product family. For every
 * catalog row seeded by the rollup or ingest, the enrichment pass
 * applies the appropriate ladder so EVERY parallel that CAN exist for
 * that card has a canonical entry — even ones that haven't sold yet.
 *
 * Cam Caminiti Blue Refractor Auto had 2 sales in pool but its Green
 * Refractor / Gold Refractor / Superfractor should also have catalog
 * rows so pricing engine + search + UI know they exist. This module
 * defines them.
 *
 * Ladders are keyed by (year-range, setFamily, isAuto) so we can
 * apply the right ladder to the right cards. Additive only — we never
 * REMOVE a parallel that has observed sales; we only ADD parallels
 * that the ladder says should exist.
 */

export interface LadderRung {
  name: string;
  slug: string;
  printRun: number | null;
  isSsp: boolean;
  hobbyExclusive?: boolean;   // for tagging Hobby-only variants
}

export interface ParallelLadder {
  key: string;                // e.g. "bowman-chrome:auto:2024"
  yearMin: number;
  yearMax: number;
  setKey: string;             // matches catalog setKey exactly
  isAuto: boolean;
  rungs: LadderRung[];
}

// ─── 2024 Bowman Chrome Prospect Autographs ──────────────────────────
// Source: Beckett + Topps product page (verified 2026-08-04).
const BOWMAN_CHROME_PROSPECT_AUTO_2024: ParallelLadder = {
  key: "bowman-chrome:auto:2024",
  yearMin: 2024,
  yearMax: 2024,
  setKey: "bowman-chrome",
  isAuto: true,
  rungs: [
    { name: "Base",                     slug: "base",                     printRun: null, isSsp: false },
    { name: "Refractor",                slug: "refractor",                printRun: 499,  isSsp: false },
    { name: "Speckle Refractor",        slug: "speckle-refractor",        printRun: 299,  isSsp: false },
    { name: "Purple Refractor",         slug: "purple-refractor",         printRun: 250,  isSsp: false },
    { name: "Blue Refractor",           slug: "blue-refractor",           printRun: 150,  isSsp: false },
    { name: "Reptilian Blue Refractor", slug: "reptilian-blue-refractor", printRun: 150,  isSsp: false, hobbyExclusive: true },
    { name: "Mini-Diamond Refractor",   slug: "mini-diamond-refractor",   printRun: 100,  isSsp: false },
    { name: "Green Refractor",          slug: "green-refractor",          printRun: 99,   isSsp: false },
    { name: "Reptilian Green Refractor",slug: "reptilian-green-refractor",printRun: 99,   isSsp: false, hobbyExclusive: true },
    { name: "Gold Refractor",           slug: "gold-refractor",           printRun: 50,   isSsp: false },
    { name: "Orange Refractor",         slug: "orange-refractor",         printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Orange Shimmer Refractor", slug: "orange-shimmer-refractor", printRun: 25,   isSsp: false },
    { name: "Red Refractor",            slug: "red-refractor",            printRun: 5,    isSsp: false },
    { name: "Reptilian Red Refractor",  slug: "reptilian-red-refractor",  printRun: 5,    isSsp: false, hobbyExclusive: true },
    { name: "Superfractor",             slug: "superfractor",             printRun: 1,    isSsp: false },
    { name: "Black & White Shimmer",    slug: "black-white-shimmer",      printRun: null, isSsp: true },
    { name: "Black & White Red Ink",    slug: "black-white-red-ink",      printRun: null, isSsp: true },
  ],
};

// ─── 2024 Bowman Chrome Base + Prospects ─────────────────────────────
// Slightly different ladder for non-auto cards (BCP-* and 1-100).
const BOWMAN_CHROME_NONAUTO_2024: ParallelLadder = {
  key: "bowman-chrome:no-auto:2024",
  yearMin: 2024,
  yearMax: 2024,
  setKey: "bowman-chrome",
  isAuto: false,
  rungs: [
    { name: "Base",                     slug: "base",                     printRun: null, isSsp: false },
    { name: "Refractor",                slug: "refractor",                printRun: 499,  isSsp: false },
    { name: "Fuchsia Refractor",        slug: "fuchsia-refractor",        printRun: 299,  isSsp: false },
    { name: "Aqua Raywave Refractor",   slug: "aqua-raywave-refractor",   printRun: 199,  isSsp: false },
    { name: "Blue Refractor",           slug: "blue-refractor",           printRun: 150,  isSsp: false },
    { name: "Wave Refractor",           slug: "wave-refractor",           printRun: 100,  isSsp: false },
    { name: "Green Refractor",          slug: "green-refractor",          printRun: 99,   isSsp: false },
    { name: "Yellow Refractor",         slug: "yellow-refractor",         printRun: 75,   isSsp: false },
    { name: "Gold Refractor",           slug: "gold-refractor",           printRun: 50,   isSsp: false },
    { name: "Orange Refractor",         slug: "orange-refractor",         printRun: 25,   isSsp: false },
    { name: "Red Refractor",            slug: "red-refractor",            printRun: 5,    isSsp: false },
    { name: "Superfractor",             slug: "superfractor",             printRun: 1,    isSsp: false },
    // Shimmer variants (BCP-* Prospects only)
    { name: "Shimmer Refractor",        slug: "shimmer-refractor",        printRun: null, isSsp: false },
  ],
};

// ─── 2025 Bowman Chrome — verified (checklistinsider 2026-08-04) ──────
// 2025-specific deltas vs 2024:
//   - Added: Geometric / Wave / Shimmer / Pulsar variants at multiple tiers
//   - Added: Aqua Refractor /125 tier (2024 had no separate aqua level)
//   - Added: HTA Choice, Green Lava, variety pack refractors
//   - Reptilian expanded across more color tiers (Gold, Orange, Black)
const BOWMAN_CHROME_PROSPECT_AUTO_2025: ParallelLadder = {
  key: "bowman-chrome:auto:2025",
  yearMin: 2025,
  yearMax: 2025,
  setKey: "bowman-chrome",
  isAuto: true,
  rungs: [
    { name: "Base",                      slug: "base",                       printRun: null, isSsp: false },
    { name: "Black & White Shimmer Refractor", slug: "black-white-shimmer-refractor", printRun: null, isSsp: true },
    { name: "Refractor",                 slug: "refractor",                  printRun: 499,  isSsp: false },
    { name: "Speckle Refractor",         slug: "speckle-refractor",          printRun: 299,  isSsp: false },
    { name: "Purple Refractor",          slug: "purple-refractor",           printRun: 250,  isSsp: false },
    { name: "Blue Refractor",            slug: "blue-refractor",             printRun: 150,  isSsp: false },
    { name: "Reptilian Blue Refractor",  slug: "reptilian-blue-refractor",   printRun: 150,  isSsp: false, hobbyExclusive: true },
    { name: "Blue RayWave Refractor",    slug: "blue-raywave-refractor",     printRun: 150,  isSsp: false },
    { name: "Mini-Diamond Refractor",    slug: "mini-diamond-refractor",     printRun: 100,  isSsp: false },
    { name: "Green Refractor",           slug: "green-refractor",            printRun: 99,   isSsp: false },
    { name: "Reptilian Green Refractor", slug: "reptilian-green-refractor",  printRun: 99,   isSsp: false, hobbyExclusive: true },
    { name: "Yellow Refractor",          slug: "yellow-refractor",           printRun: 75,   isSsp: false },
    { name: "Gold Refractor",            slug: "gold-refractor",             printRun: 50,   isSsp: false },
    { name: "Gold Mini-Diamond Refractor", slug: "gold-mini-diamond-refractor", printRun: 50, isSsp: false, hobbyExclusive: true },
    { name: "Orange Refractor",          slug: "orange-refractor",           printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Orange Shimmer Refractor",  slug: "orange-shimmer-refractor",   printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Black Refractor",           slug: "black-refractor",            printRun: 10,   isSsp: false },
    { name: "Reptilian Black Refractor", slug: "reptilian-black-refractor",  printRun: 10,   isSsp: false },
    { name: "Red Refractor",             slug: "red-refractor",              printRun: 5,    isSsp: false },
    { name: "Red Shimmer Refractor",     slug: "red-shimmer-refractor",      printRun: 5,    isSsp: false },
    { name: "Reptilian Red Refractor",   slug: "reptilian-red-refractor",    printRun: null, isSsp: true, hobbyExclusive: true },
    { name: "Superfractor",              slug: "superfractor",               printRun: 1,    isSsp: false },
  ],
};

const BOWMAN_CHROME_NONAUTO_2025: ParallelLadder = {
  key: "bowman-chrome:no-auto:2025",
  yearMin: 2025,
  yearMax: 2025,
  setKey: "bowman-chrome",
  isAuto: false,
  rungs: [
    { name: "Base",                     slug: "base",                      printRun: null, isSsp: false },
    { name: "Refractor",                slug: "refractor",                 printRun: 499,  isSsp: false },
    { name: "Pulsar Refractor",         slug: "pulsar-refractor",          printRun: 399,  isSsp: false, hobbyExclusive: true },
    { name: "Fuchsia Refractor",        slug: "fuchsia-refractor",         printRun: 299,  isSsp: false },
    { name: "Aqua Raywave Refractor",   slug: "aqua-raywave-refractor",    printRun: 199,  isSsp: false },
    { name: "Blue Refractor",           slug: "blue-refractor",            printRun: 150,  isSsp: false },
    { name: "Wave Refractor",           slug: "wave-refractor",            printRun: 100,  isSsp: false, hobbyExclusive: true },
    { name: "Green Refractor",          slug: "green-refractor",           printRun: 99,   isSsp: false },
    { name: "Yellow Refractor",         slug: "yellow-refractor",          printRun: 75,   isSsp: false },
    { name: "Gold Refractor",           slug: "gold-refractor",            printRun: 50,   isSsp: false },
    { name: "Orange Refractor",         slug: "orange-refractor",          printRun: 25,   isSsp: false },
    { name: "Black Refractor",          slug: "black-refractor",           printRun: 10,   isSsp: false },
    { name: "Red Refractor",            slug: "red-refractor",             printRun: 5,    isSsp: false },
    { name: "Superfractor",             slug: "superfractor",              printRun: 1,    isSsp: false },
  ],
};

// ─── 2026 Bowman Chrome — verified (Cardsmiths + LUDEX 2026-08-04) ────
// 2026-specific deltas vs 2025:
//   - New Lava tier /399 (took over from 2025 Pulsar)
//   - Steel Metal /100 tier added
//   - Blue Shimmer, Aqua Shimmer, Green Grass, Yellow X-Fractor variants
//   - Bowman Logofractor /35 (new numbering tier)
//   - Rose Gold /15 (new)
//   - Black X-Fractor /10
//   - PackFractor Autograph Variation /89
//   - Gold Ink Variation /15
//   - Black & White Red Ink SSP (Victor Figueroa's card confirms it —
//     unnumbered SSP within the Black & White auto family)
const BOWMAN_CHROME_PROSPECT_AUTO_2026: ParallelLadder = {
  key: "bowman-chrome:auto:2026",
  yearMin: 2026,
  yearMax: 2026,
  setKey: "bowman-chrome",
  isAuto: true,
  rungs: [
    { name: "Base",                      slug: "base",                       printRun: null, isSsp: false },
    { name: "Refractor",                 slug: "refractor",                  printRun: 499,  isSsp: false },
    { name: "Speckle Refractor",         slug: "speckle-refractor",          printRun: 299,  isSsp: false },
    { name: "Purple Refractor",          slug: "purple-refractor",           printRun: 250,  isSsp: false },
    { name: "Blue Refractor",            slug: "blue-refractor",             printRun: 150,  isSsp: false },
    { name: "Blue X-Fractor",            slug: "blue-x-fractor",             printRun: 150,  isSsp: false },
    { name: "Aqua Refractor",            slug: "aqua-refractor",             printRun: 125,  isSsp: false },
    { name: "Mini-Diamond Refractor",    slug: "mini-diamond-refractor",     printRun: 100,  isSsp: false },
    { name: "Green Grass Refractor",     slug: "green-grass-refractor",      printRun: 99,   isSsp: false },
    { name: "Yellow Refractor",          slug: "yellow-refractor",           printRun: 75,   isSsp: false },
    { name: "Yellow X-Fractor",          slug: "yellow-x-fractor",           printRun: 75,   isSsp: false },
    { name: "Gold Refractor",            slug: "gold-refractor",             printRun: 50,   isSsp: false },
    { name: "Gold Shimmer Refractor",    slug: "gold-shimmer-refractor",     printRun: 50,   isSsp: false },
    { name: "Bowman Logofractor",        slug: "bowman-logofractor",         printRun: 35,   isSsp: false },
    { name: "Orange Refractor",          slug: "orange-refractor",           printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Orange Shimmer Refractor",  slug: "orange-shimmer-refractor",   printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Orange X-Fractor",          slug: "orange-x-fractor",           printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Gold Ink Variation",        slug: "gold-ink-variation",         printRun: 15,   isSsp: false },
    { name: "Black Refractor",           slug: "black-refractor",            printRun: 10,   isSsp: false },
    { name: "Black X-Fractor",           slug: "black-x-fractor",            printRun: 10,   isSsp: false },
    { name: "PackFractor",               slug: "packfractor",                printRun: 89,   isSsp: false },
    { name: "Red Refractor",             slug: "red-refractor",              printRun: 5,    isSsp: false },
    { name: "Red Lava Refractor",        slug: "red-lava-refractor",         printRun: 5,    isSsp: false },
    { name: "Superfractor",              slug: "superfractor",               printRun: 1,    isSsp: false },
    { name: "Black & White Shimmer",     slug: "black-white-shimmer",        printRun: null, isSsp: true },
    { name: "Black & White Red Ink",     slug: "black-white-red-ink",        printRun: null, isSsp: true },
  ],
};

const BOWMAN_CHROME_NONAUTO_2026: ParallelLadder = {
  key: "bowman-chrome:no-auto:2026",
  yearMin: 2026,
  yearMax: 2026,
  setKey: "bowman-chrome",
  isAuto: false,
  rungs: [
    { name: "Base",                     slug: "base",                      printRun: null, isSsp: false },
    { name: "Refractor",                slug: "refractor",                 printRun: 499,  isSsp: false },
    { name: "Lava Refractor",           slug: "lava-refractor",            printRun: 399,  isSsp: false },
    { name: "Speckle Refractor",        slug: "speckle-refractor",         printRun: 299,  isSsp: false },
    { name: "Purple Refractor",         slug: "purple-refractor",          printRun: 250,  isSsp: false },
    { name: "Fuchsia Refractor",        slug: "fuchsia-refractor",         printRun: 199,  isSsp: false },
    { name: "Blue Refractor",           slug: "blue-refractor",            printRun: 150,  isSsp: false },
    { name: "Blue Shimmer Refractor",   slug: "blue-shimmer-refractor",    printRun: 150,  isSsp: false },
    { name: "Aqua X-Fractor",           slug: "aqua-x-fractor",            printRun: 125,  isSsp: false },
    { name: "Steel Metal Refractor",    slug: "steel-metal-refractor",     printRun: 100,  isSsp: false },
    { name: "Green Grass Refractor",    slug: "green-grass-refractor",     printRun: 99,   isSsp: false },
    { name: "Yellow Refractor",         slug: "yellow-refractor",          printRun: 75,   isSsp: false },
    { name: "Yellow X-Fractor",         slug: "yellow-x-fractor",          printRun: 75,   isSsp: false },
    { name: "Gold Refractor",           slug: "gold-refractor",            printRun: 50,   isSsp: false },
    { name: "Gold Shimmer Refractor",   slug: "gold-shimmer-refractor",    printRun: 50,   isSsp: false },
    { name: "Bowman Logofractor",       slug: "bowman-logofractor",        printRun: 35,   isSsp: false },
    { name: "Orange Refractor",         slug: "orange-refractor",          printRun: 25,   isSsp: false, hobbyExclusive: true },
    { name: "Rose Gold Refractor",      slug: "rose-gold-refractor",       printRun: 15,   isSsp: false },
    { name: "Black Refractor",          slug: "black-refractor",           printRun: 10,   isSsp: false },
    { name: "Black X-Fractor",          slug: "black-x-fractor",           printRun: 10,   isSsp: false },
    { name: "Red Refractor",            slug: "red-refractor",             printRun: 5,    isSsp: false },
    { name: "Red Lava Refractor",       slug: "red-lava-refractor",        printRun: 5,    isSsp: false },
    { name: "Superfractor",             slug: "superfractor",              printRun: 1,    isSsp: false },
  ],
};

// ─── Topps Chrome 2024 — verified only ────────────────────────────────
// Same year-specific caveat. 2025 + 2026 Topps Chrome have different
// print runs and additional variants (2026 added "Toys R Us Purple",
// "Prizmatic", etc.) — verify per-year before extending.
const TOPPS_CHROME_NONAUTO_2024: ParallelLadder = {
  key: "topps-chrome:no-auto:2024",
  yearMin: 2024,
  yearMax: 2024,
  setKey: "topps-chrome",
  isAuto: false,
  rungs: [
    { name: "Base",                     slug: "base",                     printRun: null, isSsp: false },
    { name: "Refractor",                slug: "refractor",                printRun: null, isSsp: false },
    { name: "Purple Refractor",         slug: "purple-refractor",         printRun: 299,  isSsp: false },
    { name: "Blue Refractor",           slug: "blue-refractor",           printRun: 150,  isSsp: false },
    { name: "Green Refractor",          slug: "green-refractor",          printRun: 99,   isSsp: false },
    { name: "Yellow Refractor",         slug: "yellow-refractor",         printRun: 75,   isSsp: false },
    { name: "Gold Refractor",           slug: "gold-refractor",           printRun: 50,   isSsp: false },
    { name: "Orange Refractor",         slug: "orange-refractor",         printRun: 25,   isSsp: false },
    { name: "Red Refractor",            slug: "red-refractor",            printRun: 5,    isSsp: false },
    { name: "Superfractor",             slug: "superfractor",             printRun: 1,    isSsp: false },
  ],
};

// ─── Bowman Draft — 2024 verified only ────────────────────────────────
// 2024 Bowman Draft ships the same parallel ladder Bowman Chrome
// Prospects uses that year. 2025 + 2026 Bowman Draft ladders NOT
// defined for the same reason as 2025/2026 Bowman Chrome — verify
// per-year before adding.
const BOWMAN_DRAFT_AUTO_2024: ParallelLadder = {
  ...BOWMAN_CHROME_PROSPECT_AUTO_2024,
  key: "bowman-draft:auto:2024",
  yearMin: 2024,
  yearMax: 2024,
  setKey: "bowman-draft",
};
const BOWMAN_DRAFT_NONAUTO_2024: ParallelLadder = {
  ...BOWMAN_CHROME_NONAUTO_2024,
  key: "bowman-draft:no-auto:2024",
  yearMin: 2024,
  yearMax: 2024,
  setKey: "bowman-draft",
};

// ─── Registry ─────────────────────────────────────────────────────────
// ONLY verified per-year ladders. Do NOT add a year's ladder without
// checking that year's actual product against Beckett / Topps. Copying
// a prior year forward has caused false catalog entries for parallels
// that don't exist in the target year.
//
// Verified (2026-08-04 session):
//   ✓ 2024 Bowman Chrome (auto + non-auto)
//   ✓ 2024 Bowman Draft (auto + non-auto)
//   ✓ 2024 Topps Chrome (non-auto)
//   ✓ 2025 Bowman Chrome (auto + non-auto) — via checklistinsider.com
//   ✓ 2026 Bowman Chrome (auto + non-auto) — via Cardsmiths + LUDEX
//
// Missing (rollup + backfill still work; only enrichment gated):
//   - 2025 + 2026 Bowman Draft
//   - 2025 + 2026 Topps Chrome
//   - Panini Prizm any year
//   - Other product families (Select, Optic, Chronicles, etc.)
export const PARALLEL_LADDERS: ParallelLadder[] = [
  BOWMAN_CHROME_PROSPECT_AUTO_2024,
  BOWMAN_CHROME_NONAUTO_2024,
  BOWMAN_CHROME_PROSPECT_AUTO_2025,
  BOWMAN_CHROME_NONAUTO_2025,
  BOWMAN_CHROME_PROSPECT_AUTO_2026,
  BOWMAN_CHROME_NONAUTO_2026,
  TOPPS_CHROME_NONAUTO_2024,
  BOWMAN_DRAFT_AUTO_2024,
  BOWMAN_DRAFT_NONAUTO_2024,
];

/** Lookup — returns the ladder matching (year, setKey, isAuto) or
 *  null when no ladder is defined. */
export function findLadder(input: {
  year: number;
  setKey: string;
  isAuto: boolean;
}): ParallelLadder | null {
  for (const l of PARALLEL_LADDERS) {
    if (input.year >= l.yearMin && input.year <= l.yearMax
        && input.setKey === l.setKey
        && input.isAuto === l.isAuto) {
      return l;
    }
  }
  return null;
}
