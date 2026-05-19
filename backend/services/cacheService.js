/**
 * cacheService.js (legacy wrapper)
 * 
 * DEPRECATED: Use backend/src/services/shared/cache.service.ts instead.
 * This file is kept for backward compatibility only.
 * 
 * Redis cache with no fallback (live data only).
 * Requires REDIS_HOST to be configured.
 */

let _client = null;
let _clientPromise = null;

async function getClient() {
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;
  
  _clientPromise = (async () => {
    const host = process.env.REDIS_HOST;
    if (!host) {
      throw new Error('[cache] REDIS_HOST is not configured. Redis cache is required.');
    }

    try {
      const Redis = require('ioredis');
      const port = parseInt(process.env.REDIS_PORT || '6380', 10);
      const password = process.env.REDIS_KEY;
      const tls = process.env.REDIS_TLS !== 'false';

      _client = new Redis({
        host,
        port,
        password,
        tls: tls ? {} : undefined,
        connectTimeout: 5000,
        commandTimeout: 3000,
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });

      _client.on('ready', () => {
        console.log('[cache] Redis connected');
      });
      _client.on('error', (err) => {
        console.error('[cache] Redis error:', err.message);
      });

      await _client.connect();
      return _client;
    } catch (err) {
      throw new Error(`[cache] Redis connection failed: ${err.message}`);
    }
  })();

  return _clientPromise;
}

/**
 * Get a cached value. Returns parsed object or null.
 */
async function get(key) {
  const client = await getClient();
  const raw = await client.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Set a value with optional TTL in seconds.
 */
async function set(key, value, ttlSeconds = 900) {
  const client = await getClient();
  const serialized = JSON.stringify(value);
  await client.set(key, serialized, 'EX', ttlSeconds);
}

/**
 * Delete a key.
 */
async function del(key) {
  const client = await getClient();
  await client.del(key);
}

/**
 * Wrap an async function with cache. Returns cached value if available.
 */
async function wrap(key, fn, ttlSeconds = 900) {
  const cached = await get(key);
  if (cached !== null) return cached;

  const result = await fn();
  if (result !== null && result !== undefined) {
    await set(key, result, ttlSeconds);
  }
  return result;
}

async function isRedisReady() {
  try {
    const client = await getClient();
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { get, set, del, wrap, isRedisReady };
