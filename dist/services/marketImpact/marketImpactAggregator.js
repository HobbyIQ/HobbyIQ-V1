"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aggregateMarketImpact = aggregateMarketImpact;
function aggregateMarketImpact(signals) {
    if (!signals || signals.length === 0) {
        return {
            overallDirection: 'neutral',
            overallScore: 0,
            pricePressure: 'neutral',
            marketImpactMultiplierLow: 0.98,
            marketImpactMultiplierHigh: 1.02,
            recentSignals: [],
        };
    }
    let pos = 0, neg = 0, score = 0;
    signals.forEach(s => {
        if (s.direction === 'positive')
            pos += s.score * s.impactWeight;
        if (s.direction === 'negative')
            neg += s.score * s.impactWeight;
        score += s.score * s.impactWeight;
    });
    let overallDirection = 'neutral';
    let pricePressure = 'neutral';
    if (pos > neg && pos > 0) {
        overallDirection = 'positive';
        pricePressure = 'upward';
    }
    else if (neg > pos && neg > 0) {
        overallDirection = 'negative';
        pricePressure = 'downward';
    }
    const overallScore = Math.round(Math.min(score * 10, 100));
    // Modest multipliers: 0.98-1.02 neutral, 0.95-1.05 max
    let marketImpactMultiplierLow = 0.98;
    let marketImpactMultiplierHigh = 1.02;
    if (overallDirection === 'positive') {
        marketImpactMultiplierLow = 1.00;
        marketImpactMultiplierHigh = 1.05;
    }
    else if (overallDirection === 'negative') {
        marketImpactMultiplierLow = 0.95;
        marketImpactMultiplierHigh = 1.00;
    }
    return {
        overallDirection,
        overallScore,
        pricePressure,
        marketImpactMultiplierLow,
        marketImpactMultiplierHigh,
        recentSignals: signals,
    };
}
