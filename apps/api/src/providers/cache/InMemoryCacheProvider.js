"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryCacheProvider = void 0;
const cache = {};
class InMemoryCacheProvider {
    getProviderMode() { return "mock"; }
    async set(key, value, ttlSeconds) {
        cache[key] = { value, expires: Date.now() + (ttlSeconds ? ttlSeconds * 1000 : 60000) };
    }
    async get(key) {
        const entry = cache[key];
        if (!entry)
            return null;
        if (Date.now() > entry.expires) {
            delete cache[key];
            return null;
        }
        return entry.value;
    }
    async del(key) {
        delete cache[key];
    }
}
exports.InMemoryCacheProvider = InMemoryCacheProvider;
