"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheProviderFactory = cacheProviderFactory;
// src/providers/factories/cacheProviderFactory.ts
const env_1 = require("../../config/env");
const InMemoryCacheProvider_1 = require("../cache/InMemoryCacheProvider");
const RedisCacheProvider_1 = require("../cache/RedisCacheProvider");
const monitoringProviderFactory_1 = require("./monitoringProviderFactory");
function cacheProviderFactory() {
    const monitoring = (0, monitoringProviderFactory_1.monitoringProviderFactory)();
    let provider;
    if (env_1.env.AI_MODE === "azure" && env_1.env.REDIS_URL) {
        provider = new RedisCacheProvider_1.RedisCacheProvider();
    }
    else {
        provider = new InMemoryCacheProvider_1.InMemoryCacheProvider();
    }
    console.log(`[CacheProviderFactory] Initialized Cache provider: ${provider.getProviderMode()}`);
    monitoring.logEvent?.("CacheProviderInitialized", { mode: provider.getProviderMode() });
    return provider;
}
