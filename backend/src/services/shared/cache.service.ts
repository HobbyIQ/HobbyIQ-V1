/**
 * Cache service. Prefers Azure Redis when REDIS_HOST is configured; otherwise
 * falls back to a process-memory Map so the API stays online (single-instance
 * App Service today — safe). If Redis is misconfigured or unreachable, we
 * degrade to memory rather than 500 every request.
 *
 * PHASE-4A-2.2 (2026-06-02): cache hardening — stale-serve fallback for
 * Cardsight outages + AsyncLocalStorage per-prediction cache stats +
 * per-prefix hit-rate telemetry. The substrate (Redis + memory fallback)
 * was already deployed; this file adds the resilience and observability
 * layers per the 2.1 sign-off (cache EXISTS, reframe as hardening).
 *
 * Backward-compatible storage shape: cacheWrap now wraps values as
 * `{_v: actual, _ts: epoch_ms}` so age can be computed for stale-serve.
 * Legacy bare-value entries written before this change are read transparently
 * with storedAt=null (stale-serve does not apply to them; they expire on
 * Redis TTL and get replaced with the new shape on next fetch).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import Redis from "ioredis";

// ─── In-memory fallback (per-process) ────────────────────────────────────────
interface MemoryEntry { value: string; expiresAt: number; }
const _memory = new Map<string, MemoryEntry>();
let _memoryWarned = false;

function memoryGet(key: string): string | null {
  const hit = _memory.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _memory.delete(key); return null; }
  return hit.value;
}
function memorySet(key: string, value: string, ttlSeconds: number): void {
  _memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// ─── Redis client (lazy, optional) ───────────────────────────────────────────
let _client: Redis | null = null;
let _clientPromise: Promise<Redis | null> | null = null;
let _redisDisabled = false; // true once we've decided to fall back to memory

async function getClient(): Promise<Redis | null> {
  if (_redisDisabled) return null;
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const host = process.env.REDIS_HOST;
    if (!host) {
      _redisDisabled = true;
      if (!_memoryWarned) {
        console.warn("[Cache] REDIS_HOST not configured — using in-memory cache fallback.");
        _memoryWarned = true;
      }
      return null;
    }
    try {
      const port = Number(process.env.REDIS_PORT ?? 6380);
      const key = process.env.REDIS_KEY;
      const tls = process.env.REDIS_TLS !== "false";
      const client = new Redis({
        host,
        port,
        password: key,
        tls: tls ? {} : undefined,
        enableReadyCheck: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        lazyConnect: true,
      });
      await client.connect();
      _client = client;
      console.log("[Redis] Connected to", host);
      return client;
    } catch (err: any) {
      _redisDisabled = true;
      console.warn(`[Cache] Redis connection failed (${err.message}) — falling back to in-memory cache.`);
      return null;
    }
  })();
  return _clientPromise;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function cacheGet(key: string): Promise<string | null> {
  const client = await getClient();
  if (!client) return memoryGet(key);
  try { return await client.get(key); } catch { return memoryGet(key); }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const client = await getClient();
  if (!client) { memorySet(key, value, ttlSeconds); return; }
  try { await client.setex(key, ttlSeconds, value); } catch { memorySet(key, value, ttlSeconds); }
}

// ─── PHASE-4A-2.2: per-prediction cache stats (AsyncLocalStorage) ───────────
//
// Allows callers (computeEstimate → predictionCorpus.service emit) to know
// whether the prediction served entirely from cache. The wrapper writes to
// `getStore()` if a context is active; the absence of a context (e.g. a
// non-prediction code path) is a silent no-op.

export interface CacheStats { hits: number; misses: number; }
export const cacheStatsContext = new AsyncLocalStorage<CacheStats>();

// ─── PHASE-4A-2.2: per-prefix hit-rate telemetry ────────────────────────────
//
// Aggregated counters by `cs:pricing` / `cs:catalog` / `cs:detail` etc.
// Emitted hourly as a structured `compiq_cache_hit_rate` log line for
// App Insights consumption. Counters are reset after each emit.

interface PrefixCounters { hits: number; misses: number; staleServed: number; }
const _prefixCounters = new Map<string, PrefixCounters>();
let _hitRateTimer: NodeJS.Timeout | null = null;

function recordPrefixOutcome(key: string, outcome: "hit" | "miss" | "stale"): void {
  // Key shape is "<prefix>:<prefix>:..." (e.g. "cs:pricing:660271..."); take
  // the first two segments as the rollup prefix.
  const parts = key.split(":");
  const prefix = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0] ?? "(unknown)";
  const cur = _prefixCounters.get(prefix) ?? { hits: 0, misses: 0, staleServed: 0 };
  if (outcome === "hit") cur.hits++;
  else if (outcome === "stale") cur.staleServed++;
  else cur.misses++;
  _prefixCounters.set(prefix, cur);
}

function emitHitRateSummary(): void {
  if (_prefixCounters.size === 0) {
    console.log(JSON.stringify({
      event: "compiq_cache_hit_rate",
      source: "cache.service",
      intervalSec: 3600,
      perPrefix: [],
    }));
    return;
  }
  const perPrefix = Array.from(_prefixCounters.entries()).map(([prefix, c]) => {
    const total = c.hits + c.misses + c.staleServed;
    return {
      prefix,
      hits: c.hits,
      misses: c.misses,
      staleServed: c.staleServed,
      hitRate: total === 0 ? 0 : c.hits / total,
    };
  });
  console.log(JSON.stringify({
    event: "compiq_cache_hit_rate",
    source: "cache.service",
    intervalSec: 3600,
    perPrefix,
  }));
  _prefixCounters.clear();
}

export function startCacheHitRateEmit(): void {
  if (process.env.CACHE_HIT_RATE_EMIT_DISABLED === "true") {
    console.log("[Cache] hit-rate emit disabled via CACHE_HIT_RATE_EMIT_DISABLED");
    return;
  }
  if (_hitRateTimer) return;
  _hitRateTimer = setInterval(() => emitHitRateSummary(), 60 * 60 * 1000);
  console.log("[Cache] hit-rate emit scheduled hourly");
}

export function stopCacheHitRateEmit(): void {
  if (_hitRateTimer) { clearInterval(_hitRateTimer); _hitRateTimer = null; }
}

// ─── PHASE-4A-2.2: cacheWrap with optional stale-serve ──────────────────────

export interface CacheWrapOpts {
  freshTtlSeconds: number;
  /**
   * If > 0, entries are stored with a total Redis TTL of
   * (freshTtlSeconds + staleServeTtlSeconds). When a cache entry exists but
   * its age exceeds freshTtlSeconds, it becomes "stale-eligible": if the
   * underlying `fn` call then fails, the stale entry is returned with
   * `freshness: "stale"` rather than propagating the error. Defaults to 0
   * (no stale-serve; behavior identical to the legacy single-number form).
   */
  staleServeTtlSeconds?: number;
}

interface ParsedEntry<T> {
  value: T;
  /** epoch ms when written, or null for legacy bare-value entries. */
  storedAt: number | null;
}

function parseEntry<T>(raw: string): ParsedEntry<T> | null {
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === "object" &&
      "_v" in obj &&
      "_ts" in obj &&
      typeof (obj as { _ts: unknown })._ts === "number"
    ) {
      return {
        value: (obj as { _v: T })._v,
        storedAt: (obj as { _ts: number })._ts,
      };
    }
    // Legacy bare-value (pre-2.2): treat as fresh with storedAt=null so
    // stale-serve is not eligible on it. Legacy entries will be replaced
    // with the new shape on next fetch after their natural TTL expiry.
    return { value: obj as T, storedAt: null };
  } catch {
    return null;
  }
}

function tallyStats(outcome: "hit" | "miss" | "stale"): void {
  const ctx = cacheStatsContext.getStore();
  if (ctx) {
    if (outcome === "hit") ctx.hits++;
    else if (outcome === "miss") ctx.misses++;
    // stale is tallied as miss for the per-prediction cache_hit boolean —
    // a stale-served prediction did NOT serve from a fresh cache. The
    // prefix counters separate stale out for capacity analysis.
    else ctx.misses++;
  }
}

/**
 * Wraps an async function with cache. Returns parsed JSON.
 *
 * Two call shapes:
 *   - cacheWrap(key, fn, ttlSeconds)  — legacy, no stale-serve
 *   - cacheWrap(key, fn, { freshTtlSeconds, staleServeTtlSeconds }) — 2.2
 *
 * Mandatory invariant when stale-serving: the returned value is mutated to
 * carry `freshness: "stale"`. Fresh-served values are NEVER marked stale
 * (the field is absent or carries "fresh" if downstream chooses to set it).
 */
export async function cacheWrap<T>(
  key: string,
  fn: () => Promise<T>,
  ttlOrOpts: number | CacheWrapOpts,
): Promise<T> {
  const opts: CacheWrapOpts =
    typeof ttlOrOpts === "number" ? { freshTtlSeconds: ttlOrOpts } : ttlOrOpts;
  const staleTtl = opts.staleServeTtlSeconds ?? 0;
  const totalTtl = opts.freshTtlSeconds + staleTtl;
  const freshMs = opts.freshTtlSeconds * 1000;

  const raw = await cacheGet(key);
  const parsed = raw !== null ? parseEntry<T>(raw) : null;

  // Fresh hit?
  if (parsed !== null) {
    const ageMs =
      parsed.storedAt !== null ? Date.now() - parsed.storedAt : 0; // legacy = treat as fresh
    if (ageMs <= freshMs) {
      tallyStats("hit");
      recordPrefixOutcome(key, "hit");
      return parsed.value;
    }
    // Stale-eligible (entry exists but past freshTtl). Fall through to try
    // fresh fetch; if that fails AND stale-serve enabled AND storedAt
    // known, return as stale.
  }

  // Try fresh fetch.
  try {
    const result = await fn();
    await cacheSet(
      key,
      JSON.stringify({ _v: result, _ts: Date.now() }),
      totalTtl,
    );
    tallyStats("miss");
    recordPrefixOutcome(key, "miss");
    return result;
  } catch (err) {
    // Stale-serve fallback?
    if (parsed !== null && parsed.storedAt !== null && staleTtl > 0) {
      const ageMs = Date.now() - parsed.storedAt;
      const staleEligibleMs = freshMs + staleTtl * 1000;
      if (ageMs <= staleEligibleMs) {
        // Mark the result as stale-served. Mutation is safe because the
        // parsed value is freshly deserialized from JSON (no shared refs).
        const staleValue =
          parsed.value && typeof parsed.value === "object"
            ? Object.assign({}, parsed.value, { freshness: "stale" as const })
            : parsed.value;
        const msg = String((err as Error)?.message ?? err);
        console.warn(JSON.stringify({
          event: "cache_stale_serve",
          source: "cache.service",
          key,
          ageMs,
          freshTtlSec: opts.freshTtlSeconds,
          staleServeTtlSec: staleTtl,
          underlyingError: msg.slice(0, 200),
        }));
        tallyStats("stale");
        recordPrefixOutcome(key, "stale");
        return staleValue as T;
      }
    }
    // No stale fallback available; propagate the error. Tally as miss.
    tallyStats("miss");
    recordPrefixOutcome(key, "miss");
    throw err;
  }
}

/**
 * Test-only escape hatch -- clears the in-memory cache state so
 * tests don't bleed cache hits across each other. Do not call from
 * production code; mirrors the `__resetRegistryForTest` pattern in
 * certGraders/registry.ts.
 */
export function __resetMemoryCacheForTest(): void {
  _memory.clear();
}

/**
 * Test-only escape hatch for the new 2.2 prefix counters + emit timer.
 * Mirrors __resetMemoryCacheForTest.
 */
export const __cacheServiceInternals = {
  resetPrefixCounters(): void { _prefixCounters.clear(); },
  getPrefixCountersSnapshot(): Array<{ prefix: string } & PrefixCounters> {
    return Array.from(_prefixCounters.entries()).map(([prefix, c]) => ({
      prefix,
      hits: c.hits,
      misses: c.misses,
      staleServed: c.staleServed,
    }));
  },
  emitHitRateSummaryForTest(): void { emitHitRateSummary(); },
  stopEmitTimer(): void { stopCacheHitRateEmit(); },
};

export async function isRedisReady(): Promise<boolean> {
  try {
    const client = await getClient();
    if (!client) return false;
    await client.ping();
    return true;
  } catch {
    return false;
  }
}
