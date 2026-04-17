// Simple in-memory cache with TTL, Redis-ready adapter pattern
const cache: Record<string, { value: any, expires: number }> = {};

export function setCache(key: string, value: any, ttlSeconds: number = 60) {
  cache[key] = { value, expires: Date.now() + ttlSeconds * 1000 };
}

export function getCache(key: string) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete cache[key];
    return null;
  }
  return entry.value;
}

export function clearCache(key: string) {
  delete cache[key];
}

// TODO: Add Redis adapter
