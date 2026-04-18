"use strict";
// apps/api/src/services/comps/cache.ts
// Simple in-memory cache for repeated search queries (LRU/TTL)
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryCache = void 0;
class InMemoryCache {
    constructor(ttlMs = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000, maxSize = Number(process.env.CACHE_MAX_SIZE) || 100) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.store = new Map();
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expires) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        if (this.store.size >= this.maxSize) {
            // Remove oldest
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) {
                this.store.delete(oldest);
            }
        }
        this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    }
    clear() {
        this.store.clear();
    }
}
exports.InMemoryCache = InMemoryCache;
