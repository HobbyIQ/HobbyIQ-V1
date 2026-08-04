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

// ─── 2025 + 2026 Bowman Chrome — INTENTIONALLY NOT DEFINED ──────────
// Drew (2026-08-04): every year has different parallels. Copying 2024's
// ladder forward to 2025/2026 would seed catalog rows for parallels
// that don't exist that year (2026 dropped Reptilian and added Black &
// White Red Ink SSP; 2025 has its own delta).
//
// To add: verify the year's release with beckett + topps.com, hand-
// author a ladder with only that year's actual rungs, then register
// below. Until then, enrich-parallel-ladder returns "no ladder" for
// these releases and skips them — safer than seeding false parallels.
//
// Rollup + backfill still work for 2025/2026 — they use OBSERVED sales
// to build catalog entries. Only the parallel-ladder enrichment
// (which adds parallels that haven't been observed yet) is gated on a
// verified ladder.

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
// Verified: 2024 Bowman Chrome (auto + non-auto), 2024 Bowman Draft
//   (auto + non-auto), 2024 Topps Chrome (non-auto)
// Missing:  2025 + 2026 Bowman Chrome, Bowman Draft, Topps Chrome
//   (rollup + backfill still work — only enrichment gated)
export const PARALLEL_LADDERS: ParallelLadder[] = [
  BOWMAN_CHROME_PROSPECT_AUTO_2024,
  BOWMAN_CHROME_NONAUTO_2024,
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
