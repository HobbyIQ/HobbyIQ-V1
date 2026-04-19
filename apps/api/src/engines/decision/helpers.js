"use strict";
// Helper functions for Decision Engine
Object.defineProperty(exports, "__esModule", { value: true });
exports.clamp = clamp;
exports.average = average;
exports.normalizeTrend = normalizeTrend;
exports.getRecommendation = getRecommendation;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function average(values) {
    if (!values.length)
        return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}
function normalizeTrend(trend) {
    // Normalize trend from -1..1 to 0..100
    return clamp(((trend + 1) / 2) * 100, 0, 100);
}
function getRecommendation(score) {
    if (score >= 85)
        return 'strong_buy';
    if (score >= 70)
        return 'buy';
    if (score >= 50)
        return 'hold';
    if (score >= 30)
        return 'sell';
    return 'strong_sell';
}
