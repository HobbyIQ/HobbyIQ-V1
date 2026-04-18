// cacheRepository.js - Mock/local cache persistence
const cache = new Map();
function getCachedResult(key) { return cache.get(key); }
function setCachedResult(key, value) { cache.set(key, value); return true; }
module.exports = { getCachedResult, setCachedResult };
