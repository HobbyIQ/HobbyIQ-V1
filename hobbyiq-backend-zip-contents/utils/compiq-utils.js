"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeParallel = normalizeParallel;
exports.buildMarketLadder = buildMarketLadder;
exports.scoreConfidence = scoreConfidence;
exports.interpretSupply = interpretSupply;
function normalizeParallel(parallel) {
    if (!parallel)
        return '';
    return parallel.trim().toUpperCase();
}
function buildMarketLadder(input, provider) {
    // Mock ladder
    return [
        { tier: 'Raw', price: 120 },
        { tier: 'PSA 9', price: 180 },
        { tier: 'PSA 10', price: 300 }
    ];
}
function scoreConfidence(input) {
    // Simple confidence: more comps = higher confidence
    const count = input.recentComps?.length || 0;
    if (count >= 5)
        return 0.95;
    if (count >= 3)
        return 0.85;
    if (count >= 1)
        return 0.7;
    return 0.5;
}
function interpretSupply(supply) {
    if (!supply)
        return { totalListed: 0, trend2w: 0, trend4w: 0, trend3m: 0, interpretation: 'No supply data.' };
    let interpretation = 'Stable';
    if (supply.trend2w > 10)
        interpretation = 'Supply rising';
    if (supply.trend2w < -10)
        interpretation = 'Supply dropping';
    return { ...supply, interpretation };
}
