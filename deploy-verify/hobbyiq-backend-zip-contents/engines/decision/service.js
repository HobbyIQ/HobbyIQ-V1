"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDecisionEngine = runDecisionEngine;
const config_1 = require("./config");
const helpers_1 = require("./helpers");
function runDecisionEngine(input) {
    // Weighted scores
    const playerIQ = (0, helpers_1.clamp)(input.playerIQ, 0, 100) * config_1.SCORING_WEIGHTS.playerIQ;
    const dailyIQ = (0, helpers_1.clamp)(input.dailyIQ, 0, 100) * config_1.SCORING_WEIGHTS.dailyIQ;
    const compTrend = (0, helpers_1.normalizeTrend)(input.pricingTrend) * config_1.SCORING_WEIGHTS.compTrend;
    const supplyScarcity = (0, helpers_1.average)([
        (0, helpers_1.clamp)(input.supplyScore, 0, 100),
        (0, helpers_1.clamp)(input.scarcityScore, 0, 100),
    ]) * config_1.SCORING_WEIGHTS.supplyScarcity;
    const liquidity = (0, helpers_1.clamp)(input.liquidityScore, 0, 100) * config_1.SCORING_WEIGHTS.liquidity;
    const negativePenalty = (0, helpers_1.clamp)(input.negativePressureScore, 0, 100) * config_1.SCORING_WEIGHTS.negativePressurePenalty;
    // Raw score before penalty
    let rawScore = playerIQ + dailyIQ + compTrend + supplyScarcity + liquidity;
    // Apply negative pressure as penalty
    let decisionScore = (0, helpers_1.clamp)(rawScore - negativePenalty, 0, 100);
    // Recommendation
    const recommendation = (0, helpers_1.getRecommendation)(decisionScore);
    // Confidence (simple: based on variance of major drivers)
    const drivers = [playerIQ, dailyIQ, compTrend, supplyScarcity, liquidity];
    const mean = (0, helpers_1.average)(drivers);
    const variance = (0, helpers_1.average)(drivers.map(x => Math.pow(x - mean, 2)));
    const confidenceScore = (0, helpers_1.clamp)(100 - variance, 0, 100);
    // Target ranges (example logic)
    const targetEntryRange = [decisionScore * 0.8, decisionScore * 0.95];
    const targetExit = decisionScore * 1.1;
    const holdRange = [decisionScore * 0.95, decisionScore * 1.05];
    // Urgency (example: higher negative pressure or high score = more urgent)
    const urgencyScore = (0, helpers_1.clamp)((decisionScore + input.negativePressureScore) / 2, 0, 100);
    // Time horizon (example logic)
    let timeHorizon = 'medium';
    if (decisionScore >= 80)
        timeHorizon = 'short';
    else if (decisionScore <= 40)
        timeHorizon = 'long';
    // Enhanced explanation and major drivers
    const explanation = [];
    const majorDrivers = [];
    // 1. Why the recommendation?
    if (recommendation === 'strong_buy' || recommendation === 'buy') {
        explanation.push('This card is a buy because the combined signals are strongly positive.');
    }
    else if (recommendation === 'hold') {
        explanation.push('Hold recommended: signals are mixed or neutral, so waiting may be prudent.');
    }
    else if (recommendation === 'sell' || recommendation === 'strong_sell') {
        explanation.push('Sell recommended: negative signals outweigh positives for this card.');
    }
    // 2. Strongest signals
    const signals = [
        { label: 'Player performance', value: playerIQ },
        { label: 'Recent performance', value: dailyIQ },
        { label: 'Comp trend', value: compTrend },
        { label: 'Supply/Scarcity', value: supplyScarcity },
        { label: 'Liquidity', value: liquidity },
    ];
    signals.sort((a, b) => b.value - a.value);
    const topSignal = signals[0];
    if (topSignal.value > 20) {
        explanation.push(`${topSignal.label} is the strongest positive factor.`);
        majorDrivers.push(topSignal.label);
    }
    // Add other strong signals
    signals.slice(1, 3).forEach(sig => {
        if (sig.value > 15)
            majorDrivers.push(sig.label);
    });
    // 3. Negative pressure effect
    if (negativePenalty > 0) {
        if (negativePenalty > 20) {
            explanation.push('Negative market pressure is actively suppressing the score.');
            majorDrivers.push('Negative Pressure');
        }
        else {
            explanation.push('Some negative pressure is present, but not dominant.');
        }
    }
    else {
        explanation.push('No significant negative pressure detected.');
    }
    // 4. Scarcity/Supply support
    if (supplyScarcity > 10) {
        explanation.push('Scarcity and supply levels are supportive for this card.');
        if (!majorDrivers.includes('Supply/Scarcity'))
            majorDrivers.push('Supply/Scarcity');
    }
    else {
        explanation.push('Abundant supply or low scarcity may limit upside.');
    }
    // 5. Recent performance
    if (dailyIQ > 20) {
        explanation.push('Recent player performance is helping the outlook.');
    }
    else if (dailyIQ < 10) {
        explanation.push('Recent performance is a drag on the recommendation.');
    }
    // 6. Comp trend
    if (compTrend > 15) {
        explanation.push('Comparable sales trend is favorable.');
    }
    else if (compTrend < 5) {
        explanation.push('Comparable sales trend is declining or flat.');
    }
    // Clean up majorDrivers (unique, readable)
    const uniqueDrivers = Array.from(new Set(majorDrivers));
    return {
        decisionScore: Math.round(decisionScore),
        recommendation,
        confidenceScore: Math.round(confidenceScore),
        targetEntryRange: [Math.round(targetEntryRange[0]), Math.round(targetEntryRange[1])],
        targetExit: Math.round(targetExit),
        holdRange: [Math.round(holdRange[0]), Math.round(holdRange[1])],
        urgencyScore: Math.round(urgencyScore),
        timeHorizon,
        explanation,
        majorDrivers: uniqueDrivers,
    };
}
