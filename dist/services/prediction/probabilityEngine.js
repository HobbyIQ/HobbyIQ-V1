"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProbability = getProbability;
function getProbability(payload, events, eventConfidence) {
    let playerSignalScore = 0.5;
    if (payload.playerSignal === 'positive')
        playerSignalScore = 0.8;
    if (payload.playerSignal === 'negative')
        playerSignalScore = 0.2;
    let trendStrength = 0.5;
    if (payload.trendStrength === 'strong')
        trendStrength = 0.8;
    if (payload.trendStrength === 'moderate')
        trendStrength = 0.6;
    if (payload.trendStrength === 'low')
        trendStrength = 0.4;
    const probability = (playerSignalScore * 0.4) + (trendStrength * 0.3) + (eventConfidence * 0.3);
    return Math.max(0.05, Math.min(probability, 0.99));
}
