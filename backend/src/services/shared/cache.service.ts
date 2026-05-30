/**
 * Cache service. Prefers Azure Redis when REDIS_HOST is configured; otherwise
 * falls back to a process-memory Map so the API stays online (single-instance
 * App Service today — safe). If Redis is misconfigured or unreachable, we
 * degrade to memory rather than 500 every request.
 */

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

/** Wraps an async function with cache. Returns parsed JSON. */
export async function cacheWrap<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds: number,
): Promise<T> {
  const cached = await cacheGet(key);
  if (cached !== null) {
    try { return JSON.parse(cached) as T; } catch { /* ignore bad JSON */ }
  }
  const result = await fn();
  await cacheSet(key, JSON.stringify(result), ttlSeconds);
  return result;
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

