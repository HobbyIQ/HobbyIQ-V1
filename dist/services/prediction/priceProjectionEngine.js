"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectPrice = projectPrice;
const probabilityEngine_1 = require("./probabilityEngine");
const BASE_MULTIPLIERS = {
    promotion: [1.3, 2.0],
    performance_hot: [1.1, 1.4],
    ranking_up: [1.15, 1.6],
    award: [1.5, 3.0],
    hype_spike: [1.1, 1.5],
    injury: [0.5, 0.85],
    performance_cold: [0.7, 0.95],
    ranking_down: [0.7, 0.95]
};
function projectPrice(payload, events) {
    const base = payload.currentEstimatedValue || 0;
    let multiplierLow = 1, multiplierHigh = 1;
    let timelineDays = 14;
    let eventConfidence = 0.7;
    let reasoning = [];
    events.forEach(event => {
        const [low, high] = BASE_MULTIPLIERS[event.eventType] || [1, 1];
        multiplierLow *= low;
        multiplierHigh *= high;
        timelineDays = Math.max(timelineDays, event.durationDays);
        eventConfidence = Math.max(eventConfidence, event.confidence);
        reasoning.push(`Event: ${event.eventType} (impact: ${event.impactScore}, confidence: ${event.confidence})`);
    });
    let supplyAdj = 1;
    if (payload.supplyTrend2W && payload.supplyTrend2W < 0)
        supplyAdj += 0.05;
    if (payload.supplyTrend2W && payload.supplyTrend2W > 0)
        supplyAdj -= 0.05;
    let trendAdj = 1;
    if (payload.trendDirection === 'up')
        trendAdj += 0.07;
    if (payload.trendDirection === 'down')
        trendAdj -= 0.07;
    multiplierLow *= supplyAdj * trendAdj;
    multiplierHigh *= supplyAdj * trendAdj;
    multiplierLow = Math.max(0.4, Math.min(multiplierLow, 3.5));
    multiplierHigh = Math.max(0.4, Math.min(multiplierHigh, 4.0));
    const projectedValueLow = Math.round(base * multiplierLow);
    const projectedValueHigh = Math.round(base * multiplierHigh);
    const probability = (0, probabilityEngine_1.getProbability)(payload, events, eventConfidence);
    reasoning.push(`Supply/trend adjustment: ${((supplyAdj * trendAdj - 1) * 100).toFixed(1)}%`);
    reasoning.push(`Final multipliers: low=${multiplierLow.toFixed(2)}, high=${multiplierHigh.toFixed(2)}`);
    return {
        projectedValueLow,
        projectedValueHigh,
        multiplierLow,
        multiplierHigh,
        probability,
        timelineDays,
        reasoning
    };
}
