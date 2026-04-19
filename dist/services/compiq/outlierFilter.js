"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterOutliers = filterOutliers;
function filterOutliers(comps) {
    // Mock: remove comps > 2 stddev from mean
    if (!comps.length)
        return comps;
    const prices = comps.map(c => c.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const std = Math.sqrt(prices.map(p => (p - mean) ** 2).reduce((a, b) => a + b, 0) / prices.length);
    return comps.filter(c => Math.abs(c.price - mean) <= 2 * std);
}
