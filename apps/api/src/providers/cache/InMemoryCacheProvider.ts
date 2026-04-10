// src/providers/cache/InMemoryCacheProvider.ts
import type { CacheProvider } from "./CacheProvider";

const cache: Record<string, { value: any; expires: number }> = {};

export class InMemoryCacheProvider implements CacheProvider {
  getProviderMode() { return "mock"; }
  async set(key: string, value: any, ttlSeconds?: number) {
    cache[key] = { value, expires: Date.now() + (ttlSeconds ? ttlSeconds * 1000 : 60000) };
  }
  async get(key: string) {
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      delete cache[key];
      return null;
    }
    return entry.value;
  }
  async del(key: string) {
    delete cache[key];
  }
}
