// CF-PHASE5-LADDER-TO-COSMOS (2026-07-10, Drew — all_baseball_cards_roadmap
// Phase 5). Extends the parallel-floor ladder from Bowman-only (via the
// bundled bowman-parallels.json) to the WHOLE HOBBY by consulting the
// Cosmos reference-catalog container.
//
// ──── Design principle: no additive blend ─────────────────────────────────
//
// Comp density and the scarcity prior BOTH encode print-run signal —
// combining them additively would double-count. So the handoff is:
//   * comp density N ≥ K (K=3): predictedPrice takes over; the ladder
//     does not contribute
//   * comp density N < K:       the ladder is the SOLE marketValue via
//     the parallel-floor-projection path; predictedPrice defers
//
// This wire-up doesn't move the K boundary — it broadens the ladder
// data source INSIDE the existing thin-comp path. Same discipline the
// seasonality-coefficient risk demanded.
//
// ──── Ops safety: lazy per-bucket cache ────────────────────────────────────
//
// Every call is amortized to zero Cosmos cost after the first hit for
// its (productKey, year) tuple. The cache is per-process and never
// evicted — the underlying data is owner-managed reference material,
// so once a bucket is loaded it stays correct for the process lifetime.
// This is the "hot cache" we deferred to when PR B shipped routes-only.
//
// ──── Graceful degradation ────────────────────────────────────────────────
//
// Before the container is populated (PR C), every lookup returns null
// and the caller falls back to the Bowman JSON and hand-coded rules
// unchanged. Enabling the flag ahead of ingest is a NO-OP, not a
// regression. After PR C, the ladder covers Topps, vintage, and every
// other product the workbook curates.
//
// ──── Rollback ────────────────────────────────────────────────────────────
//
// Env flag COMPIQ_REFERENCE_CATALOG_ENABLED (default: false). Flag off =
// zero behavior change from prod-today; the module returns null without
// ever touching Cosmos. Flag on + container empty = same behavior (the
// call is safe but returns miss). Flag on + container populated = the
// ladder covers the whole hobby.

import { slug } from "../../shared/slug.js";
import { listParallelsByProductYear } from "../../repositories/referenceCatalog.repository.js";
import type { ParallelDoc } from "../reference/referenceCatalog.types.js";

/**
 * CF-CATALOG-PRODUCT-FAMILY-FALLBACK (Drew, 2026-07-14): the workbook
 * data doesn't cleanly separate "Bowman Chrome" from "Bowman" — 2026
 * Bowman Chrome Prospect Autographs are stored under `product: "Bowman"`
 * with `cardSet` carrying the "Chrome" distinction. Same for
 * "Bowman Draft Chrome" (nested under bowman-draft) and "Topps Chrome
 * Update" (under topps-update).
 *
 * When a lookup misses on the requested productKey, walk up the family
 * ladder to the flagship. Preserves the exact-match precedence (a real
 * bowman-chrome-sapphire hit still beats a bowman fallback) but
 * recovers matches when the workbook chose to nest.
 *
 * Order matters: most-specific → least-specific. First hit wins.
 */
// CF-FAMILY-LADDER-BRAND-ROOT (Drew, 2026-07-29). Every set name starts
// with a company/brand token that is the family root: "Topps Chrome
// Sapphire" nests under Topps Chrome nests under Topps; "Bowman Draft
// Paper" nests under Bowman Draft nests under Bowman; "Fleer Stickers"
// nests under Fleer. Prior ladder was ad-hoc (only "-chrome" suffix
// stripping + "topps-*" branch that required ≥3 parts) — missed many
// real cases like bowman-chrome-draft, bowman-chrome-sapphire,
// topps-heritage, fleer-stickers.
//
// Algorithm: peel one hyphen-separated segment at a time from the RIGHT,
// STOPPING at a known brand root (or the first segment when no known
// root matches). Order preserved: most-specific → least-specific.
// First catalog hit wins downstream.
//
// KNOWN_BRAND_ROOTS lists company names that are multi-segment when
// slugified but should NOT be split (Upper Deck = one company; Allen &
// Ginter = a Topps subset but historically its own brand pattern).
// Everything else terminates at the first segment.
const KNOWN_BRAND_ROOTS = new Set([
  "topps", "bowman", "panini", "fleer", "donruss", "score",
  "upper-deck",  // multi-segment brand
]);

// CF-SUBSET-TO-BRAND-FALLBACK (Drew, 2026-07-29). "Not every time is
// the first word the parent company." Sometimes historical rows carry
// a setKey where the leading segment is a subset name (Prizm, Optic,
// Heritage) rather than the brand (Panini, Topps). Map those back to
// their brand parent so the ladder still terminates at the family
// root. When the leading segment isn't a known subset either, we stop
// at the first segment (best effort).
const KNOWN_SUBSET_TO_BRAND: Record<string, string> = {
  // Panini-family subsets
  prizm: "panini",
  optic: "panini",
  select: "panini",
  mosaic: "panini",
  immaculate: "panini",
  flawless: "panini",
  contenders: "panini",
  absolute: "panini",
  chronicles: "panini",
  // CF-PANINI-EXPAND (Drew, 2026-07-29). Full Panini vocabulary so
  // orphan single-segment setKeys walk to their brand parent.
  phoenix: "panini",
  illusions: "panini",
  obsidian: "panini",
  spectra: "panini",
  revolution: "panini",
  donruss: "panini",
  // "national-treasures" / "crown-royale" / "one-one" are 2-segment;
  // peel handles them via right-to-left segment drop.
  // Topps-family subsets
  heritage: "topps",
  finest: "topps",
  pristine: "topps",
  transcendent: "topps",
  dynasty: "topps",
  tribute: "topps",
  inception: "topps",
  // CF-TOPPS-EXPAND (Drew, 2026-07-29).
  definitive: "topps",
  archives: "topps",
  bunt: "topps",
  // 2-segment: "stadium-club", "allen-ginter", "gypsy-queen",
  // "five-star", "museum-collection", "big-league" — peel handles.
};

function productFamilyLadder(productKey: string): string[] {
  const ladder: string[] = [productKey];
  const parts = productKey.split("-");
  if (parts.length <= 1) {
    // Single-segment setKey — check if it's a known subset whose brand
    // parent isn't in the key itself.
    const brand = KNOWN_SUBSET_TO_BRAND[productKey];
    if (brand) ladder.push(brand);
    return Array.from(new Set(ladder));
  }

  // Peel trailing segments one at a time. Stop when we hit a known
  // brand root OR the single leading segment. Check current BEFORE
  // peeling so multi-segment brand roots (e.g. "upper-deck") are not
  // split into upper→deck.
  let current = productKey;
  while (current.includes("-")) {
    if (KNOWN_BRAND_ROOTS.has(current)) break;
    const idx = current.lastIndexOf("-");
    const parent = current.slice(0, idx);
    ladder.push(parent);
    if (KNOWN_BRAND_ROOTS.has(parent)) break;
    current = parent;
  }

  // If the terminal segment is NOT a known brand root but IS a known
  // subset name, append its brand parent. Handles historical setKeys
  // like "prizm-silver" → prizm → panini.
  const terminal = current;
  if (!KNOWN_BRAND_ROOTS.has(terminal)) {
    const brand = KNOWN_SUBSET_TO_BRAND[terminal];
    if (brand) ladder.push(brand);
  }

  return Array.from(new Set(ladder));
}

export interface ReferenceCatalogLookupResult {
  printRun: number | null;
  auto: boolean;
  confidence: string;
  product: string;
  cardSet: string;
  parallel: string;
  source: "reference-catalog";
}

// ─── Cache ────────────────────────────────────────────────────────────────

interface Bucket {
  /** Keyed by parallelKey — the same slug the ingest wrote. */
  byParallelKey: Map<string, ParallelDoc[]>;
  loadedAt: number;
}

const _cache = new Map<string, Bucket>();

function bucketCacheKey(productKey: string, year: number): string {
  return `${productKey}|${year}`;
}

async function getBucket(
  productKey: string,
  year: number,
): Promise<Bucket> {
  const key = bucketCacheKey(productKey, year);
  const hit = _cache.get(key);
  if (hit) return hit;

  const docs = await listParallelsByProductYear(productKey, year);
  const byParallelKey = new Map<string, ParallelDoc[]>();
  for (const d of docs) {
    const bucketForKey = byParallelKey.get(d.parallelKey);
    if (bucketForKey) bucketForKey.push(d);
    else byParallelKey.set(d.parallelKey, [d]);
  }
  const bucket: Bucket = { byParallelKey, loadedAt: Date.now() };
  _cache.set(key, bucket);
  return bucket;
}

// ─── Selection ────────────────────────────────────────────────────────────

function confidenceRank(c: string): number {
  const lower = c.toLowerCase();
  if (lower.includes("verified")) return 3;
  if (lower.includes("high")) return 2;
  if (lower.includes("medium")) return 1;
  return 0;
}

function selectBest(
  candidates: ParallelDoc[],
  isAuto: boolean | undefined,
): ParallelDoc | null {
  if (candidates.length === 0) return null;
  const requestedAuto = isAuto === true;
  const requestedBase = isAuto === false;
  const scored = candidates
    .map((d) => {
      let score = confidenceRank(d.confidence) * 100;
      if (requestedAuto && d.auto) score += 50;
      else if (requestedBase && !d.auto) score += 50;
      return { doc: d, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0].doc;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Try to resolve `(product, year, parallel) → print run` from the Cosmos
 * reference-catalog container. Returns null when:
 *   * env flag is off (default)
 *   * inputs are incomplete
 *   * the (productKey, year) bucket has no matching parallelKey
 *   * the container is empty / unreachable
 *
 * Never throws. The caller (inferPrintRunYearFirst) must be able to
 * fall through to its next data source on a null return.
 */
export async function inferPrintRunFromReferenceCatalog(
  product: string | null | undefined,
  year: number | null | undefined,
  parallel: string | null | undefined,
  opts?: { isAuto?: boolean },
): Promise<ReferenceCatalogLookupResult | null> {
  // Env-flag gate — this is the rollback lever.
  if (process.env.COMPIQ_REFERENCE_CATALOG_ENABLED !== "true") return null;

  if (!product || typeof product !== "string" || !product.trim()) return null;
  if (!year || !Number.isFinite(year)) return null;
  if (!parallel || typeof parallel !== "string" || !parallel.trim()) return null;

  const requestedProductKey = slug(product);
  const parallelKey = slug(parallel);
  if (!requestedProductKey || !parallelKey) return null;

  // CF-CATALOG-PRODUCT-FAMILY-FALLBACK (Drew, 2026-07-14): walk the
  // product family ladder. Exact match wins; only fall back when the
  // requested key has zero matches (empty bucket OR bucket exists but
  // has no parallel-key hit even after suffix fuzz).
  const ladder = productFamilyLadder(requestedProductKey);
  for (const productKey of ladder) {
    let bucket: Bucket;
    try {
      bucket = await getBucket(productKey, year);
    } catch (err) {
      console.warn(
        `[referenceCatalogLookup] getBucket failed (${productKey}, ${year}):`,
        (err as Error)?.message ?? err,
      );
      continue;
    }
    if (bucket.byParallelKey.size === 0) continue;   // empty bucket → try next in ladder

    // CF-STRESS-TEST-SUFFIX-FUZZ (2026-07-10): Chrome-family SKUs are
    // typically named by color alone ("Blue"), while the reference
    // catalog stores full names with the Refractor suffix ("Blue
    // Refractor"). Try exact first; on miss, fall through to a canonical
    // suffix-augmented lookup so callers don't have to know which naming
    // convention lives in Cosmos.
    let candidates = bucket.byParallelKey.get(parallelKey);
    if (!candidates || candidates.length === 0) {
      for (const suffix of ["-refractor", "-foil", "-prizm"]) {
        const suffixKey = parallelKey.endsWith(suffix)
          ? parallelKey
          : `${parallelKey}${suffix}`;
        const suffixHit = bucket.byParallelKey.get(suffixKey);
        if (suffixHit && suffixHit.length > 0) {
          candidates = suffixHit;
          break;
        }
      }
    }
    if (!candidates || candidates.length === 0) continue;   // no parallel hit → try next in ladder

    const best = selectBest(candidates, opts?.isAuto);
    if (!best) continue;

    return {
      printRun: best.printRun,
      auto: best.auto,
      confidence: best.confidence,
      product: best.product,
      cardSet: best.cardSet,
      parallel: best.parallel,
      source: "reference-catalog",
    };
  }
  return null;
}

/**
 * Test-only: clear the in-process cache between test cases so each test
 * starts from a clean state. Prod code should never call this — the
 * whole point of the cache is process-lifetime persistence.
 */
export function _resetReferenceCatalogCacheForTest(): void {
  _cache.clear();
}
