// CF-BOWMAN-PARALLELS-DATASET (2026-07-09, Drew).
//
// Bundled reference dataset — 1,849 rows spanning 2011-2026 Bowman
// family products (Bowman, Bowman Chrome, Bowman Draft, Bowman's Best,
// Platinum, Sterling, Inception, High Tek, Chrome Sapphire, Draft
// Sapphire, Chrome Mega Box, Chrome Mini, Bowman Black, 1st Edition).
// Sourced from Drew's reference workbook "bowman parallels 2011 2026.xlsx"
// with confidence tags (Verified / High / Medium) per row.
//
// Consumers: the projection paths (parallel-floor-projection,
// product-family-projection) call inferPrintRunForYearAndParallel(year,
// parallel) FIRST — when the dataset returns a hit for the requested
// (year, parallel), that value is authoritative. On a miss, callers
// fall back to the hand-coded PARALLEL_TO_PRINT_RUN rules in
// parallelPremiumFloors.ts (which are single-tier and don't vary by year).
//
// Why this matters: the hand-coded rules assume "Blue Refractor" is
// always /150, but 2011 Bowman flagship Blue is /500 while 2026 is /150.
// Year-aware lookup produces correct floors for old cards.

// tsc emits CommonJS — `require` is available directly. No `createRequire`
// / import.meta wiring needed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
declare const require: NodeRequire;

interface RawEntry {
  year: number;
  product: string;
  cardSet: string;
  parallel: string;
  printRun: number | null;
  numbered: boolean;
  auto: boolean;
  confidence: string;
  notes: string | null;
}

interface BundledDataset {
  generatedAt: string;
  source: string;
  scope: string;
  yearRange: { min: number; max: number };
  entryCount: number;
  productCounts: Record<string, number>;
  entries: RawEntry[];
}

// Lazy-loaded singleton — the JSON blob is ~600 kB parsed; load on
// first use and cache the index. Every subsequent call is O(1) Map hit.
let _dataset: BundledDataset | null = null;
let _index: Map<string, RawEntry[]> | null = null;

function normalizeParallel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadDataset(): BundledDataset {
  if (_dataset) return _dataset;
  // Bundled with the dist output; resolved relative to this compiled file.
  // The dist path lives at .../dist/services/compiq/bowmanParallelsDataset.js,
  // and the JSON is copied into .../dist/data/bowman-parallels.json by
  // the build step (see below). At dev time (tsx / vitest), the source
  // path .../src/services/compiq/bowmanParallelsDataset.ts uses the
  // sibling backend/data/bowman-parallels.json.
  //
  // We try the dist location first (production) then fall back to the
  // repo layout (dev / tests).
  let json: BundledDataset;
  try {
    json = require("../../../data/bowman-parallels.json") as BundledDataset;
  } catch {
    json = require("../../../../backend/data/bowman-parallels.json") as BundledDataset;
  }
  _dataset = json;
  return json;
}

function ensureIndex(): Map<string, RawEntry[]> {
  if (_index) return _index;
  const ds = loadDataset();
  const idx = new Map<string, RawEntry[]>();
  for (const e of ds.entries) {
    const key = `${e.year}|${normalizeParallel(e.parallel)}`;
    const bucket = idx.get(key);
    if (bucket) bucket.push(e);
    else idx.set(key, [e]);
  }
  _index = idx;
  return idx;
}

export interface BowmanParallelLookupResult {
  printRun: number | null;
  auto: boolean;
  confidence: string;
  product: string;
  cardSet: string;
  parallel: string;
}

/**
 * Look up a Bowman parallel by year + parallel name. Returns null when
 * (year, parallel) isn't in the dataset — callers should fall back to
 * the hand-coded parallelPremiumFloors rules.
 *
 * When multiple entries share the same (year, parallel) key (common —
 * a Blue Refractor exists in Chrome Prospect Autographs, Chrome
 * Prospects insert, AND Paper for the same year), we prefer:
 *   1. Higher-confidence rows (Verified > High > Medium)
 *   2. Auto vs base matching the caller's expectation, if isAuto is
 *      passed
 *   3. First occurrence otherwise
 *
 * Numbered=false + printRun=null (unnumbered parallels like Camo or
 * bare Refractor pre-2015) surface as `printRun: null` — the caller
 * decides how to handle those.
 */
export function inferPrintRunForYearAndParallel(
  year: number | null | undefined,
  parallel: string | null | undefined,
  opts?: { isAuto?: boolean },
): BowmanParallelLookupResult | null {
  if (!year || !Number.isFinite(year)) return null;
  if (!parallel || typeof parallel !== "string" || parallel.trim().length === 0) {
    return null;
  }
  const idx = ensureIndex();
  const key = `${year}|${normalizeParallel(parallel)}`;
  const bucket = idx.get(key);
  if (!bucket || bucket.length === 0) return null;

  // Preference sort — highest confidence wins; among equal-confidence,
  // match the auto flag when specified.
  const confidenceRank = (c: string): number => {
    const lower = c.toLowerCase();
    if (lower.includes("verified")) return 3;
    if (lower.includes("high")) return 2;
    if (lower.includes("medium")) return 1;
    return 0;
  };
  const requestedAuto = opts?.isAuto === true;
  const requestedBase = opts?.isAuto === false;

  const scored = bucket
    .map((e) => {
      let score = confidenceRank(e.confidence) * 100;
      if (requestedAuto && e.auto) score += 50;
      else if (requestedBase && !e.auto) score += 50;
      return { entry: e, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0].entry;
  return {
    printRun: best.printRun,
    auto: best.auto,
    confidence: best.confidence,
    product: best.product,
    cardSet: best.cardSet,
    parallel: best.parallel,
  };
}

/**
 * Diagnostic accessor for tests and admin routes — returns dataset
 * metadata without exposing the full entry array.
 */
export function getBowmanParallelsMeta(): {
  generatedAt: string;
  source: string;
  yearRange: { min: number; max: number };
  entryCount: number;
  productCounts: Record<string, number>;
} {
  const ds = loadDataset();
  return {
    generatedAt: ds.generatedAt,
    source: ds.source,
    yearRange: ds.yearRange,
    entryCount: ds.entryCount,
    productCounts: ds.productCounts,
  };
}
