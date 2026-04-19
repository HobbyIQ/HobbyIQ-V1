"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setCache = setCache;
exports.getCache = getCache;
exports.clearCache = clearCache;
// Simple in-memory cache with TTL, Redis-ready adapter pattern
const cache = {};
function setCache(key, value, ttlSeconds = 60) {
    cache[key] = { value, expires: Date.now() + ttlSeconds * 1000 };
}
function getCache(key) {
    const entry = cache[key];
    if (!entry)
        return null;
    if (Date.now() > entry.expires) {
        delete cache[key];
        return null;
    }
    return entry.value;
}
function clearCache(key) {
    delete cache[key];
}
// TODO: Add Redis adapter
