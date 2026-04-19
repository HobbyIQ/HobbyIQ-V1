"use strict";
// Parallel logic for CompIQ
Object.defineProperty(exports, "__esModule", { value: true });
exports.getParallelMultiplier = getParallelMultiplier;
exports.normalizeParallel = normalizeParallel;
const PARALLEL_MULTIPLIERS = {
    Silver: 1.2,
    Gold: 1.5,
    Red: 1.7,
    Blue: 1.3,
    Green: 1.4,
    Base: 1.0,
    Auto: 1.8
};
function getParallelMultiplier(parallel) {
    if (!parallel)
        return 1.0;
    return PARALLEL_MULTIPLIERS[parallel] || 1.0;
}
function normalizeParallel(parallel) {
    if (!parallel)
        return null;
    return parallel.trim().toLowerCase();
}
