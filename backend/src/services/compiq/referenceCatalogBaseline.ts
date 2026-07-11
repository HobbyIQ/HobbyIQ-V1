// CF-NO-NULL-PRICING (2026-07-11, Drew — Tier 6 fallback):
// Reference-catalog-baseline pricing. Fires when the ladder has a
// ParallelDoc for (product, year, parallel) but no comps exist at any
// higher level (player, product-year cross-player, family).
//
// This is the "we know EXACTLY what tier this parallel is on the
// scarcity ladder, but nobody's sold one recently" case. The formula:
//
//   floor = eraBaseline(productKey, year, cardClass) × tierMultiplier(printRun)
//   range = floor × [0.5, 2.0]
//
// Confidence: 25. Below scarcity-prior-floor (40), above setdoc-
// baseline (15). This tier fires more precisely than Tier 7 because
// it knows the exact print run.
//
// ──── Design principle: no additive blend ─────────────────────────────────
//
// Comp density is the discriminator between tiers. When there ARE comps
// (any level), we use them via Tiers 1-5. When there aren't, we drop to
// Tier 6 for a structural floor. Never blend.
//
// ──── Ops safety ──────────────────────────────────────────────────────────
//
// Env flag COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED (default false).
// Errors on the era-baseline lookup are non-blocking; the fallback path
// returns null and the engine drops to Tier 7 (setdoc-baseline) or Tier 8
// (unavailable).
//
// The era baselines come from a Cosmos-backed `era-baselines` container
// (populated by a daily background job — PR 4 in the arc). When the
// container is empty or unreachable, we fall through to a hand-curated
// static table (this module's ERA_BASELINE_STATIC).

import {
  floorForPrintRunByClass,
  floorForPrintRun,
} from "./parallelPremiumFloors.js";
import { inferPrintRunFromReferenceCatalog } from "./referenceCatalogLookup.js";

// ─── Static era-baseline fallback ─────────────────────────────────────────
//
// Rough baseline for the average raw base card sale for a productKey in
// a given year. Educated guess drawn from hobby context; will be
// superseded by the era-baselines Cosmos container in PR 4.
//
// Structure: { productKeyPrefix: { yearBucket: baseline } }
// productKeyPrefix uses slug format (e.g. "bowman-chrome"); we match by
// prefix so "bowman-chrome-mega-box" falls back to "bowman-chrome" if not
// explicitly listed.

interface StaticBaselineEntry {
  productKeyPrefix: string;
  yearBucket: [number, number];
  baseline: number;
}

const ERA_BASELINE_STATIC: StaticBaselineEntry[] = [
  // Bowman family
  { productKeyPrefix: "bowman-chrome", yearBucket: [2016, 2026], baseline: 12 },
  { productKeyPrefix: "bowman-chrome", yearBucket: [2010, 2015], baseline: 8 },
  { productKeyPrefix: "bowman-chrome", yearBucket: [1997, 2009], baseline: 5 },
  { productKeyPrefix: "bowman-draft", yearBucket: [2016, 2026], baseline: 10 },
  { productKeyPrefix: "bowman-draft", yearBucket: [2010, 2015], baseline: 6 },
  { productKeyPrefix: "bowman", yearBucket: [2016, 2026], baseline: 4 },
  { productKeyPrefix: "bowman", yearBucket: [2010, 2015], baseline: 3 },
  { productKeyPrefix: "bowman", yearBucket: [1989, 2009], baseline: 2 },
  // Topps family
  { productKeyPrefix: "topps-chrome", yearBucket: [2016, 2026], baseline: 8 },
  { productKeyPrefix: "topps-chrome", yearBucket: [2010, 2015], baseline: 6 },
  { productKeyPrefix: "topps-chrome", yearBucket: [1996, 2009], baseline: 4 },
  { productKeyPrefix: "topps-finest", yearBucket: [2016, 2026], baseline: 12 },
  { productKeyPrefix: "topps-finest", yearBucket: [1993, 2015], baseline: 8 },
  { productKeyPrefix: "topps-heritage", yearBucket: [2016, 2026], baseline: 5 },
  { productKeyPrefix: "topps-heritage", yearBucket: [2001, 2015], baseline: 4 },
  { productKeyPrefix: "topps-series", yearBucket: [2016, 2026], baseline: 3 },
  { productKeyPrefix: "topps-series", yearBucket: [2010, 2015], baseline: 2 },
  { productKeyPrefix: "topps-update", yearBucket: [2016, 2026], baseline: 3 },
  { productKeyPrefix: "topps", yearBucket: [1951, 2005], baseline: 2 },
  // Panini family
  { productKeyPrefix: "panini-prizm", yearBucket: [2020, 2025], baseline: 5 },
  { productKeyPrefix: "panini-prizm", yearBucket: [2012, 2019], baseline: 4 },
  { productKeyPrefix: "panini-donruss", yearBucket: [2020, 2025], baseline: 3 },
  { productKeyPrefix: "donruss-optic", yearBucket: [2020, 2025], baseline: 5 },
  { productKeyPrefix: "donruss-optic", yearBucket: [2016, 2019], baseline: 4 },
  { productKeyPrefix: "panini-national-treasures", yearBucket: [2015, 2025], baseline: 50 },
  { productKeyPrefix: "panini-flawless", yearBucket: [2016, 2025], baseline: 60 },
  { productKeyPrefix: "panini-immaculate", yearBucket: [2015, 2025], baseline: 40 },
  { productKeyPrefix: "panini-select", yearBucket: [2013, 2025], baseline: 6 },
  // Historic
  { productKeyPrefix: "fleer-ultra", yearBucket: [1991, 2007], baseline: 3 },
  { productKeyPrefix: "fleer", yearBucket: [1981, 2007], baseline: 2 },
  { productKeyPrefix: "upper-deck", yearBucket: [1989, 2013], baseline: 2 },
  { productKeyPrefix: "score", yearBucket: [1988, 2005], baseline: 1.5 },
  { productKeyPrefix: "donruss", yearBucket: [1981, 2005], baseline: 1.5 },
  { productKeyPrefix: "pinnacle", yearBucket: [1992, 1998], baseline: 3 },
  { productKeyPrefix: "pacific", yearBucket: [1993, 2004], baseline: 2 },
  { productKeyPrefix: "leaf-metal", yearBucket: [2013, 2025], baseline: 25 },
];

// Bump multipliers by cardClass (auto vs base)
const CARD_CLASS_MULTIPLIER: Record<"auto" | "base", number> = {
  auto: 4.0, // autographs typically trade 4× the equivalent raw
  base: 1.0,
};

// ─── Lookup — static table fallback ──────────────────────────────────────

export function lookupEraBaselineStatic(
  productKey: string,
  year: number,
  cardClass: "auto" | "base",
): number | null {
  if (!productKey || !Number.isFinite(year)) return null;
  // Longest-prefix match wins so specific overrides beat generic prefixes.
  const candidates = ERA_BASELINE_STATIC.filter(
    (e) =>
      productKey.startsWith(e.productKeyPrefix) &&
      year >= e.yearBucket[0] &&
      year <= e.yearBucket[1],
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) => b.productKeyPrefix.length - a.productKeyPrefix.length,
  );
  const baseline = candidates[0].baseline;
  const mult = CARD_CLASS_MULTIPLIER[cardClass];
  return baseline * mult;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface ReferenceCatalogBaselineResult {
  /** The final floor price (baseline × tier multiplier). */
  floor: number;
  /** Wide range (floor × 0.5 → 2.0). */
  range: { low: number; high: number };
  /** The raw era baseline before tier multiplier. */
  eraBaseline: number;
  /** The parallel-floor multiplier from the ladder tier. */
  tierMultiplier: number;
  /** The printRun that drove the tier lookup. */
  printRun: number;
  /** Attribution — what parallel this came from. */
  parallel: string;
  cardSet: string;
  /** Fallback path taken — static table vs Cosmos era-baselines. */
  baselineSource: "static-table" | "era-baselines-cosmos";
}

/**
 * Compute the Tier 6 reference-catalog baseline for a card.
 *
 * Returns null when:
 *   * env flag is off (default)
 *   * inputs are incomplete
 *   * ladder has no matching ParallelDoc
 *   * era baseline lookup fails
 *
 * The caller (compiqEstimate.service.ts) invokes this after Tiers 1-5
 * have all missed, before returning null.
 */
export async function computeReferenceCatalogBaseline(input: {
  product: string | null | undefined;
  year: number | null | undefined;
  parallel: string | null | undefined;
  cardClass: "auto" | "base";
}): Promise<ReferenceCatalogBaselineResult | null> {
  if (process.env.COMPIQ_REFERENCE_CATALOG_BASELINE_ENABLED !== "true") {
    return null;
  }
  if (!input.product || !input.year || !input.parallel) return null;

  // Step 1: get the ladder tier (printRun) for this parallel.
  let catalogHit;
  try {
    catalogHit = await inferPrintRunFromReferenceCatalog(
      input.product,
      input.year,
      input.parallel,
      { isAuto: input.cardClass === "auto" },
    );
  } catch (err) {
    console.warn(
      `[referenceCatalogBaseline] ladder lookup failed:`,
      (err as Error)?.message ?? err,
    );
    return null;
  }
  if (!catalogHit || catalogHit.printRun === null) return null;

  const printRun = catalogHit.printRun;
  const tierMultiplier =
    floorForPrintRunByClass(printRun, input.cardClass) ??
    floorForPrintRun(printRun) ??
    1;

  // Step 2: get the era baseline for this productKey/year/class.
  const productKey = input.product
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’‘"`]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const eraBaseline = lookupEraBaselineStatic(
    productKey,
    input.year,
    input.cardClass,
  );
  if (eraBaseline === null) return null;

  // Step 3: compute floor + range.
  const floor = Math.round(eraBaseline * tierMultiplier * 100) / 100;
  return {
    floor,
    range: {
      low: Math.round(floor * 0.5 * 100) / 100,
      high: Math.round(floor * 2.0 * 100) / 100,
    },
    eraBaseline,
    tierMultiplier,
    printRun,
    parallel: catalogHit.parallel,
    cardSet: catalogHit.cardSet,
    baselineSource: "static-table",
  };
}
