"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockCacheProvider = void 0;
const mockCache = {};
class MockCacheProvider {
    getProviderMode() { return "mock"; }
    async set(key, value, ttlSeconds) {
        mockCache[key] = value;
        // TTL not implemented in mock
    }
    async get(key) {
        return mockCache[key] ?? null;
    }
    async del(key) {
        delete mockCache[key];
    }
}
exports.MockCacheProvider = MockCacheProvider;
