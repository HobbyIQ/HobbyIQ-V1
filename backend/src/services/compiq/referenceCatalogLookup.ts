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

  const productKey = slug(product);
  const parallelKey = slug(parallel);
  if (!productKey || !parallelKey) return null;

  let bucket: Bucket;
  try {
    bucket = await getBucket(productKey, year);
  } catch (err) {
    // Never let a Cosmos blip poison the projection path — log and miss.
    console.warn(
      `[referenceCatalogLookup] getBucket failed (${productKey}, ${year}):`,
      (err as Error)?.message ?? err,
    );
    return null;
  }

  const candidates = bucket.byParallelKey.get(parallelKey);
  if (!candidates || candidates.length === 0) return null;

  const best = selectBest(candidates, opts?.isAuto);
  if (!best) return null;

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

/**
 * Test-only: clear the in-process cache between test cases so each test
 * starts from a clean state. Prod code should never call this — the
 * whole point of the cache is process-lifetime persistence.
 */
export function _resetReferenceCatalogCacheForTest(): void {
  _cache.clear();
}
