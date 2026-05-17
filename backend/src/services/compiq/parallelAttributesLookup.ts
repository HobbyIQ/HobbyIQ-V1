// ---------------------------------------------------------------------------
// parallelAttributesLookup.ts — Issue #25 Phase 3
//
// Read-only, set-scoped lookup of curated `parallel_attributes` records from
// Cosmos for the tier-anchored predicted-range fallback. The fallback engine
// needs a way to resolve `(set, parallelName) → tierWithinSet` for both the
// subject card and every peer comp. This module owns that.
//
// Design points:
//   * Cache is per-set: one point query per set is shared by the subject
//     lookup and every peer lookup in the same request.
//   * Misses (sets with zero curated rows) are cached too, with a shorter
//     TTL, so an uncurated set doesn't repeatedly hit Cosmos in a tight loop.
//   * Parallel-name match is normalized (lowercase, trimmed, autograph token
//     respected) so input case/whitespace variation doesn't kill a match.
//   * Related-set discovery (same year + brand + sport) is heuristic but
//     stable: see `inferRelatedSets()`. Owner can override via env in future.
//
// This module performs network I/O (Cosmos). For unit testing the engine
// behavior, use the in-memory `inMemoryTierLookup()` helper exported below.
// ---------------------------------------------------------------------------

import type { Container } from "@azure/cosmos";
import { getParallelsContainers } from "../parallelsReference/ingestion.js";

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Per-set, normalized lookup. Keys are the result of `normalizeParallelKey()`.
 * Value is the curated `tierWithinSet`; never null in the map (uncurated
 * entries are simply absent).
 */
export type SetTierMap = ReadonlyMap<string, number>;

export interface TierLookupResult {
  /** Tier for the requested parallel, or null if not curated. */
  tier: number | null;
  /** Lookup source for diagnostics: cosmos-hit | cache-hit | uncurated-set. */
  source: "cosmos-hit" | "cache-hit" | "uncurated-set";
}

/** Pluggable interface — pure consumer code only sees this. */
export interface ParallelAttributesLookup {
  /** Returns tier for (set, parallel, isAutograph), or null when uncurated. */
  getTier(
    set: string,
    parallelName: string,
    isAutograph: boolean,
  ): Promise<TierLookupResult>;
  /**
   * Returns the candidate "related set" names to try as a Phase-3 fallback
   * when the subject's own set yields < 3 peers. Heuristic; never throws.
   */
  inferRelatedSets(subjectSet: string): string[];
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Normalize a parallel name into the cache key. Schema §2.1 stores
 * `parallelName` exactly as curated (e.g., "Gold Refractor"); for lookup we
 * want case/whitespace-insensitive matching and we suffix `-auto` for
 * autograph parallels so "Refractor" and "Refractor Auto" never collide.
 */
export function normalizeParallelKey(
  parallelName: string,
  isAutograph: boolean,
): string {
  const base = (parallelName ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return isAutograph ? `${base}|auto` : base;
}

// ─── Cosmos-backed implementation ───────────────────────────────────────────

interface CacheEntry {
  map: SetTierMap;
  expiresAt: number;
}

const HIT_TTL_MS = 10 * 60 * 1000; // 10 min — curated data is owner-managed, rarely changes mid-day
const MISS_TTL_MS = 60 * 1000;     // 1 min  — uncurated set; revisit soon in case owner curates

class CosmosParallelAttributesLookup implements ParallelAttributesLookup {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly containerPromise: Promise<Container>;

  constructor() {
    this.containerPromise = getParallelsContainers().then((c) => c.parallelAttributes);
  }

  async getTier(
    set: string,
    parallelName: string,
    isAutograph: boolean,
  ): Promise<TierLookupResult> {
    const cleanSet = (set ?? "").trim();
    if (!cleanSet) return { tier: null, source: "uncurated-set" };
    const map = await this.loadSet(cleanSet);
    if (map.size === 0) return { tier: null, source: "uncurated-set" };
    const key = normalizeParallelKey(parallelName, isAutograph);
    const t = map.get(key);
    return { tier: typeof t === "number" ? t : null, source: "cosmos-hit" };
  }

  private async loadSet(set: string): Promise<SetTierMap> {
    const now = Date.now();
    const cached = this.cache.get(set);
    if (cached && cached.expiresAt > now) return cached.map;

    const container = await this.containerPromise;
    // Partition key is /set, so this is a single-partition query.
    const query = {
      query:
        "SELECT c.parallelName, c.isAutograph, c.tierWithinSet FROM c WHERE c[\"set\"] = @set AND IS_DEFINED(c.tierWithinSet) AND NOT IS_NULL(c.tierWithinSet)",
      parameters: [{ name: "@set", value: set }],
    };
    const map = new Map<string, number>();
    try {
      const iter = container.items.query<{
        parallelName?: string;
        isAutograph?: boolean;
        tierWithinSet?: number | null;
      }>(query, { partitionKey: set, maxItemCount: 200 });
      while (iter.hasMoreResults()) {
        const page = await iter.fetchNext();
        for (const row of page.resources ?? []) {
          if (!row || typeof row.parallelName !== "string") continue;
          if (typeof row.tierWithinSet !== "number") continue;
          const key = normalizeParallelKey(row.parallelName, !!row.isAutograph);
          map.set(key, row.tierWithinSet);
        }
      }
    } catch (err) {
      // Defensive: never let a Cosmos blip block a price prediction. Cache a
      // short-lived miss so we don't retry on every comp in the same request.
      console.warn(
        `[parallelAttributesLookup] cosmos query failed for set="${set}":`,
        (err as Error)?.message ?? err,
      );
      this.cache.set(set, { map, expiresAt: now + MISS_TTL_MS });
      return map;
    }
    const ttl = map.size > 0 ? HIT_TTL_MS : MISS_TTL_MS;
    this.cache.set(set, { map, expiresAt: now + ttl });
    return map;
  }

  inferRelatedSets(subjectSet: string): string[] {
    return inferRelatedSetsHeuristic(subjectSet);
  }
}

// ─── Related-set heuristic ──────────────────────────────────────────────────

/**
 * Heuristic: same year + same brand family + same sport, different product
 * line. Examples we want to handle for the Phase 3 prompt:
 *   "2024 Bowman Chrome Prospects Autograph"
 *     → "2024 Bowman Chrome Baseball", "2024 Bowman Chrome Prospects"
 *   "2024 Topps Chrome Update"
 *     → "2024 Topps Chrome Baseball", "2024 Topps Chrome"
 *
 * Returns candidates EXCLUDING the subject set itself. Never throws.
 */
export function inferRelatedSetsHeuristic(subjectSet: string): string[] {
  const s = (subjectSet ?? "").trim();
  if (!s) return [];
  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return [];
  const year = yearMatch[0];
  const lower = s.toLowerCase();
  // Brand families we know how to expand.
  let candidates: string[] = [];
  if (/\bbowman\s+chrome\b/.test(lower)) {
    candidates = [
      `${year} Bowman Chrome Baseball`,
      `${year} Bowman Chrome Prospects`,
      `${year} Bowman Chrome Prospects Autograph`,
      `${year} Bowman Chrome Draft`,
      `${year} Bowman Chrome Draft Autograph`,
    ];
  } else if (/\btopps\s+chrome\b/.test(lower)) {
    candidates = [
      `${year} Topps Chrome Baseball`,
      `${year} Topps Chrome`,
      `${year} Topps Chrome Update`,
    ];
  } else if (/\bbowman\b/.test(lower)) {
    candidates = [
      `${year} Bowman Baseball`,
      `${year} Bowman Chrome Baseball`,
      `${year} Bowman Chrome Prospects`,
    ];
  } else if (/\btopps\b/.test(lower)) {
    candidates = [
      `${year} Topps Baseball`,
      `${year} Topps Chrome Baseball`,
    ];
  } else {
    return [];
  }
  // Drop the subject itself.
  const sLc = s.toLowerCase();
  return candidates.filter((c) => c.toLowerCase() !== sLc);
}

// ─── Factory + test helpers ─────────────────────────────────────────────────

let singleton: ParallelAttributesLookup | null = null;

/**
 * Returns a process-wide singleton Cosmos-backed lookup. The cache lives on
 * the singleton so all requests in the same Node process share it.
 */
export function getParallelAttributesLookup(): ParallelAttributesLookup {
  if (!singleton) singleton = new CosmosParallelAttributesLookup();
  return singleton;
}

/** Test-only: allow injection of a stub lookup (e.g., in-memory). */
export function _setParallelAttributesLookupForTest(
  stub: ParallelAttributesLookup | null,
): void {
  singleton = stub;
}

/**
 * Build an in-memory lookup from a literal map. Useful for unit tests and
 * for ad-hoc dev scripts that want full control over curated data.
 *
 * `data` shape: { [setName]: { [normalizedParallelKey]: tier } }
 * Use `normalizeParallelKey()` to produce keys, or just pass the lowercased
 * parallel name (autograph variants must use `${name}|auto`).
 */
export function inMemoryTierLookup(
  data: Record<string, Record<string, number>>,
  relatedSetsFn: (set: string) => string[] = inferRelatedSetsHeuristic,
): ParallelAttributesLookup {
  return {
    async getTier(set, parallelName, isAutograph) {
      const setMap = data[set];
      if (!setMap) return { tier: null, source: "uncurated-set" };
      const key = normalizeParallelKey(parallelName, isAutograph);
      const t = setMap[key];
      return {
        tier: typeof t === "number" ? t : null,
        source: typeof t === "number" ? "cosmos-hit" : "uncurated-set",
      };
    },
    inferRelatedSets(s) {
      return relatedSetsFn(s);
    },
  };
}
