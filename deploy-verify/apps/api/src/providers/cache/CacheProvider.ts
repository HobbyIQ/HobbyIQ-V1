// src/providers/cache/CacheProvider.ts
export interface CacheProvider {
  getProviderMode(): string;
  set(key: string, value: any, ttlSeconds?: number): Promise<void>;
  get(key: string): Promise<any | null>;
  del(key: string): Promise<void>;
}
