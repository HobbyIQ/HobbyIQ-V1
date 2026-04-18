"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarketSnapshot = getMarketSnapshot;
// Data Read Order Logic
const cache_1 = require("./cache");
// ...import gold, silver, external fetchers
async function getMarketSnapshot(entityKey, snapshotType) {
    // 1. Try Redis hot cache
    const cacheKey = `snapshot:${snapshotType}:${entityKey}`;
    const cached = await (0, cache_1.getFromCache)(cacheKey);
    if (cached)
        return { ...cached, freshness: 'cache' };
    // 2. Try gold snapshot store
    // TODO: Implement DB fetch for gold layer
    // 3. Try recompute from normalized data (silver)
    // 4. Fallback to external API
    return null;
}
