// src/providers/cache/MockCacheProvider.ts
import type { CacheProvider } from "./CacheProvider";

const mockCache: Record<string, any> = {};

export class MockCacheProvider implements CacheProvider {
  getProviderMode() { return "mock"; }
  async set(key: string, value: any, ttlSeconds?: number) {
    mockCache[key] = value;
    // TTL not implemented in mock
  }
  async get(key: string) {
    return mockCache[key] ?? null;
  }
  async del(key: string) {
    delete mockCache[key];
  }
}
