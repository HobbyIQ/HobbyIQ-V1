// PricingCache: in-memory cache abstraction
export class PricingCache {
  private static cache: Map<string, any> = new Map();
  get(key: string) { return PricingCache.cache.get(key); }
  set(key: string, value: any) { PricingCache.cache.set(key, value); }
  clear() { PricingCache.cache.clear(); }
}
