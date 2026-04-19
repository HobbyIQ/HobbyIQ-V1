"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AzureRedisCacheProvider = void 0;
class AzureRedisCacheProvider {
    getProviderMode() { return "azure"; }
    async set(key, value, ttlSeconds) {
        // TODO: Integrate with Azure Redis Cache
    }
    async get(key) {
        // TODO: Integrate with Azure Redis Cache
        return null;
    }
    async del(key) {
        // TODO: Integrate with Azure Redis Cache
    }
}
exports.AzureRedisCacheProvider = AzureRedisCacheProvider;
