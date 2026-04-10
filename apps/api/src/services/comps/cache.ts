// apps/api/src/services/comps/cache.ts
// Simple in-memory cache for repeated search queries (LRU/TTL)

import type { NormalizedComp } from "../../types/comps";

export interface CacheEntry<T> {
  value: T;
  expires: number;
}


export class InMemoryCache<T> {
  private store: Map<string, CacheEntry<T>> = new Map();
  constructor(
    private ttlMs: number = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000,
    private maxSize: number = Number(process.env.CACHE_MAX_SIZE) || 100
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxSize) {
      // Remove oldest
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
