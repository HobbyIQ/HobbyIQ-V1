export interface CacheEntry<T> {
    value: T;
    expires: number;
}
export declare class InMemoryCache<T> {
    private ttlMs;
    private maxSize;
    private store;
    constructor(ttlMs?: number, maxSize?: number);
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    clear(): void;
}
//# sourceMappingURL=cache.d.ts.map