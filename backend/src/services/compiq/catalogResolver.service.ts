// CF-CATALOG-RESOLVER (2026-07-13): vendor-agnostic multi-source resolver.
//
// Foundation for the CH + Cardsight + eBay-direct multi-vendor pricing arc.
// A single entry point (`resolveCard`) that fans out to N registered vendor
// sources in parallel, returns the first confident hit (early-return race),
// falls back to the slowest source if no confident hit lands within a
// timeout, and caches every resolution keyed by canonical query shape.
//
// Design principles:
//   1. Vendor sources are pluggable — the orchestrator has zero knowledge
//      of CH / Cardsight / eBay-specific quirks. Add a new source =
//      implement VendorSource + register it.
//   2. Cache-first — canonical query hash keyed against Redis/LRU with
//      TTL. Reduces vendor API cost + latency dramatically on repeat
//      queries.
//   3. Parallel fan-out with early-return — the first source to return a
//      confident hit wins; slower sources are logged (for reconciliation)
//      but don't block the caller.
//   4. Reconciliation logging — when multiple sources respond within the
//      full timeout, log a structured event with the delta. Feeds an
//      offline per-vendor accuracy audit + eventually a per-SKU routing
//      preference model.
//
// NOT wired into the pricing engine yet — this is the resolver core.
// PR-follow-up will migrate autoPriceHolding + repriceHoldingsForUser to
// consume this instead of direct CH calls.

// ─── Types ─────────────────────────────────────────────────────────────────

export type SourceVendor = "cardhedge" | "cardsight" | "ebay" | "sold-comps" | "manual";

/** Canonical query — structured fields, not free text. */
export interface CardQuery {
  playerName?: string;
  cardYear?: number;
  setName?: string;
  parallel?: string;
  cardNumber?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
  /** Explicit cardId — takes priority over structured fields when set. */
  cardId?: string;
}

/** Confidence tiers determine early-return behavior. */
export type ResolutionConfidence = "high" | "medium" | "low";

/** Unified vendor response shape. */
export interface CardResolution {
  vendor: SourceVendor;
  cardId: string;
  fairMarketValue: number | null;
  compCount: number;
  freshestSaleDate: string | null;
  confidence: ResolutionConfidence;
  /** Vendor-native response payload — callers may extract vendor-specific
   *  fields when they need to (avoids re-fetching). Never surfaced to iOS. */
  raw?: unknown;
}

/** Vendor source plugin contract. */
export interface VendorSource {
  readonly name: SourceVendor;
  /** Resolve a card query. Return null when the vendor has no answer.
   *  Should never throw for expected failures — return null instead. */
  resolveCard(query: CardQuery): Promise<CardResolution | null>;
}

// ─── Configuration ─────────────────────────────────────────────────────────

/** Early-return timeout — first confident hit within this window wins. */
const EARLY_RETURN_MS = 200;
/** Full timeout — abandon vendors that haven't responded by then. */
const FULL_TIMEOUT_MS = 3000;
/** Cache TTL. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
/** LRU cap. */
const CACHE_MAX_ENTRIES = 5000;

/** A high-confidence hit skips the wait for slower sources. */
function isConfident(r: CardResolution): boolean {
  return r.confidence === "high" && r.fairMarketValue !== null && r.compCount >= 3;
}

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  resolution: CardResolution;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Canonical cache key. Order + case + falsy field consistency matters. */
export function canonicalCacheKey(query: CardQuery): string {
  const q: CardQuery = {
    playerName: query.playerName?.trim().toLowerCase(),
    cardYear: query.cardYear,
    setName: query.setName?.trim().toLowerCase(),
    parallel: query.parallel?.trim().toLowerCase(),
    cardNumber: query.cardNumber?.trim().toLowerCase(),
    gradeCompany: query.gradeCompany?.trim().toLowerCase(),
    gradeValue: query.gradeValue,
    isAuto: query.isAuto,
    cardId: query.cardId?.trim().toLowerCase(),
  };
  const keys = Object.keys(q).sort();
  return keys.map((k) => `${k}=${(q as any)[k] ?? ""}`).join("|");
}

function cacheGet(key: string, now: number): CardResolution | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < now) {
    cache.delete(key);
    return null;
  }
  return entry.resolution;
}

function cacheSet(key: string, resolution: CardResolution, now: number): void {
  cache.set(key, { resolution, expiresAt: now + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX_ENTRIES) {
    // Evict oldest entry (Map iteration = insertion order).
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

/** Test hook — clear cache between tests. */
export function _clearResolverCacheForTests(): void {
  cache.clear();
}

// ─── Vendor registry ───────────────────────────────────────────────────────

const registeredSources: VendorSource[] = [];

/** Register a vendor source. Sources are queried in registration order for
 *  race-based races, and reconciliation logs list them in the same order. */
export function registerVendorSource(source: VendorSource): void {
  const existing = registeredSources.findIndex((s) => s.name === source.name);
  if (existing >= 0) registeredSources.splice(existing, 1, source);
  else registeredSources.push(source);
}

/** Test hook. */
export function _resetVendorRegistryForTests(): void {
  registeredSources.length = 0;
}

/** Read-only view for introspection. */
export function listVendorSources(): SourceVendor[] {
  return registeredSources.map((s) => s.name);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

/** Wrap a promise with a timeout. Timeout rejects; the original stays
 *  running for reconciliation logging (fire-and-forget). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

/** Sort resolutions by preference: confidence tier → comp count → recency. */
function pickBest(resolutions: Array<CardResolution | null>): CardResolution | null {
  const nonNull = resolutions.filter((r): r is CardResolution => r !== null);
  if (nonNull.length === 0) return null;
  const rank = (r: CardResolution) => {
    const conf = r.confidence === "high" ? 3 : r.confidence === "medium" ? 2 : 1;
    const comps = Math.min(50, r.compCount);
    const recency = r.freshestSaleDate ? Date.parse(r.freshestSaleDate) : 0;
    return conf * 1_000_000_000 + comps * 1_000_000 + recency / 1000;
  };
  return nonNull.slice().sort((a, b) => rank(b) - rank(a))[0];
}

/** Structured log for the offline per-vendor accuracy audit. */
function logReconciliation(query: CardQuery, resolutions: Array<CardResolution | null>): void {
  const responded = resolutions.filter((r): r is CardResolution => r !== null);
  if (responded.length < 2) return;   // nothing to reconcile
  console.log(JSON.stringify({
    event: "catalog_resolver_reconciliation",
    source: "catalogResolver.service",
    query: {
      playerName: query.playerName,
      cardYear: query.cardYear,
      setName: query.setName,
      parallel: query.parallel,
      cardNumber: query.cardNumber,
      cardId: query.cardId,
    },
    responses: responded.map((r) => ({
      vendor: r.vendor,
      cardId: r.cardId,
      fairMarketValue: r.fairMarketValue,
      compCount: r.compCount,
      freshestSaleDate: r.freshestSaleDate,
      confidence: r.confidence,
    })),
    timestamp: new Date().toISOString(),
  }));
}

/** Result of resolveCard — the winner + a snapshot of who responded. */
export interface ResolveCardResult {
  winner: CardResolution | null;
  responses: Array<CardResolution | null>;
  fromCache: boolean;
}

/**
 * Resolve a card query across all registered vendor sources.
 *
 * Flow:
 *   1. Canonical cache key → cache hit? return immediately (5ms).
 *   2. Fire ALL sources in parallel.
 *   3. Race for the first confident hit or the early-return timeout (200ms).
 *   4. If confident hit → return, cache, log reconciliation with the rest
 *      (fire-and-forget when they finish).
 *   5. If early-return timer fires without a confident hit → wait for all
 *      responses up to FULL_TIMEOUT_MS, pick the best.
 */
export async function resolveCard(query: CardQuery): Promise<ResolveCardResult> {
  const now = Date.now();
  const key = canonicalCacheKey(query);
  const cached = cacheGet(key, now);
  if (cached) {
    return { winner: cached, responses: [cached], fromCache: true };
  }

  if (registeredSources.length === 0) {
    return { winner: null, responses: [], fromCache: false };
  }

  const promises = registeredSources.map((source) =>
    Promise.resolve()
      .then(() => source.resolveCard(query))
      .catch((err) => {
        console.warn(JSON.stringify({
          event: "catalog_resolver_source_error",
          source: "catalogResolver.service",
          vendor: source.name,
          error: (err as Error)?.message ?? String(err),
        }));
        return null;
      }),
  );

  // Early-return race: first confident hit within EARLY_RETURN_MS wins.
  const earlyWinner: CardResolution | null = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, EARLY_RETURN_MS);
    for (const p of promises) {
      p.then((r) => {
        if (settled) return;
        if (r && isConfident(r)) {
          settled = true;
          clearTimeout(timer);
          resolve(r);
        }
      });
    }
  });

  if (earlyWinner) {
    // Return immediately; reconcile fire-and-forget when the rest settle.
    void Promise.allSettled(promises).then((settled) => {
      const responses = settled.map((s) => s.status === "fulfilled" ? s.value : null);
      logReconciliation(query, responses);
    });
    cacheSet(key, earlyWinner, now);
    return { winner: earlyWinner, responses: [earlyWinner], fromCache: false };
  }

  // No confident hit within early-return window — wait for all up to
  // FULL_TIMEOUT_MS, then pick best from whatever landed.
  const settled = await Promise.allSettled(
    promises.map((p) => withTimeout(p, FULL_TIMEOUT_MS, "vendor").catch(() => null)),
  );
  const responses = settled.map((s) => s.status === "fulfilled" ? s.value : null);
  logReconciliation(query, responses);
  const best = pickBest(responses);
  if (best) cacheSet(key, best, now);
  return { winner: best, responses, fromCache: false };
}
