"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.confidenceEngine = confidenceEngine;
function confidenceEngine({ compCount, recencyScore, varianceScore, supplyScore, matchQualityScore }) {
    // All scores 0-1
    const confidence = (compCount * 0.25) +
        (recencyScore * 0.25) +
        (varianceScore * 0.2) +
        (supplyScore * 0.15) +
        (matchQualityScore * 0.15);
    return Math.round(confidence * 100);
}
