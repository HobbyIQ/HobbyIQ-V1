// src/providers/cache/AzureRedisCacheProvider.ts
import type { CacheProvider } from "./CacheProvider";

export class AzureRedisCacheProvider implements CacheProvider {
  getProviderMode() { return "azure"; }
  async set(key: string, value: any, ttlSeconds?: number) {
    // TODO: Integrate with Azure Redis Cache
  }
  async get(key: string) {
    // TODO: Integrate with Azure Redis Cache
    return null;
  }
  async del(key: string) {
    // TODO: Integrate with Azure Redis Cache
  }
}
