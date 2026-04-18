"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheProvider = void 0;
class RedisCacheProvider {
    // TODO: Wire up Azure Redis SDK client here for production
    // import { Redis } from "ioredis"; // Example
    // const redisClient = new Redis(...)
    getProviderMode() { return "azure"; }
    async set(key, value, ttlSeconds) {
        // TODO: Integrate with Azure Redis SDK
        // Example: await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds || 60);
    }
    async get(key) {
        // TODO: Integrate with Azure Redis SDK
        // Example: const val = await redisClient.get(key); return val ? JSON.parse(val) : null;
        return null;
    }
    async del(key) {
        // TODO: Integrate with Azure Redis SDK
        // Example: await redisClient.del(key);
    }
}
exports.RedisCacheProvider = RedisCacheProvider;
