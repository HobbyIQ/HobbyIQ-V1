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

// Empty dataset used when the JSON blob can't be located at runtime.
// Every lookup on this empty dataset returns null; the caller then
// falls back to the hand-coded parallelPremiumFloors rules. This is
// the same behavior as if the dataset had never been added — safe.
const EMPTY_DATASET: BundledDataset = {
  generatedAt: "n/a",
  source: "not-found (defensive fallback)",
  scope: "empty",
  yearRange: { min: 0, max: 0 },
  entryCount: 0,
  productCounts: {},
  entries: [],
};

function loadDataset(): BundledDataset {
  if (_dataset) return _dataset;

  // CF-BOWMAN-DATASET-DEFENSIVE-LOAD (2026-07-10, prod-hotfix): the
  // original loader threw when `require()` couldn't resolve the JSON
  // path, taking down every year-aware search (500 on first request).
  // A missing blob is not a fatal condition — the year-aware lookup is
  // additive on top of the hand-coded rules — so the loader now:
  //   1. Tries the compiled-output relative path (prod)
  //   2. Falls back to the source-tree relative path (dev / vitest)
  //   3. Falls back to fs.readFileSync at process.cwd()-based
  //      absolute paths (Azure App Service can be quirky about
  //      require() resolution across working-directory changes)
  //   4. Returns the empty dataset — every lookup returns null,
  //      callers seamlessly fall back to hand-coded rules
  // Ordered require attempts.
  const requirePaths = [
    "../../../data/bowman-parallels.json",
    "../../../../backend/data/bowman-parallels.json",
  ];
  for (const p of requirePaths) {
    try {
      const json = require(p) as BundledDataset;
      _dataset = json;
      console.log(
        `[bowmanParallelsDataset] loaded via require: ${p} (${json.entryCount} entries)`,
      );
      return json;
    } catch {
      // continue to next path
    }
  }

  // Absolute-path fallback via fs. Compiled __dirname sits at
  // .../dist/services/compiq/ at prod; try known-good sibling paths.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: typeof import("node:fs") = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path: typeof import("node:path") = require("node:path");
    const abs = [
      path.join(__dirname, "..", "..", "..", "data", "bowman-parallels.json"),
      path.join(process.cwd(), "dist", "data", "bowman-parallels.json"),
      path.join(process.cwd(), "backend", "dist", "data", "bowman-parallels.json"),
      path.join(process.cwd(), "backend", "data", "bowman-parallels.json"),
    ];
    for (const p of abs) {
      try {
        if (fs.existsSync(p)) {
          const json = JSON.parse(fs.readFileSync(p, "utf-8")) as BundledDataset;
          _dataset = json;
          console.log(
            `[bowmanParallelsDataset] loaded via fs: ${p} (${json.entryCount} entries)`,
          );
          return json;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // fs / path unavailable — very unusual, fall through to empty
  }

  console.warn(
    "[bowmanParallelsDataset] JSON blob not found at any known path — year-aware lookups will return null (falling back to hand-coded rules)",
  );
  _dataset = EMPTY_DATASET;
  return EMPTY_DATASET;
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
