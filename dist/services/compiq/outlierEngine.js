"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterOutliers = filterOutliers;
function filterOutliers(comps) {
    if (comps.length < 3)
        return comps;
    const prices = comps.map(c => c.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const std = Math.sqrt(prices.map(p => Math.pow(p - mean, 2)).reduce((a, b) => a + b, 0) / prices.length);
    let filtered = comps.filter(c => c.price <= mean * 1.5 && c.price >= mean * 0.6);
    if (filtered.length < 2 && comps.length >= 4) {
        const sorted = [...comps].sort((a, b) => a.price - b.price);
        const q1 = sorted[Math.floor(sorted.length * 0.25)].price;
        const q3 = sorted[Math.floor(sorted.length * 0.75)].price;
        const iqr = q3 - q1;
        filtered = comps.filter(c => c.price >= q1 - 1.5 * iqr && c.price <= q3 + 1.5 * iqr);
    }
    return filtered.length > 0 ? filtered : comps;
}
