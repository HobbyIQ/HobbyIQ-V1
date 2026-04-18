"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOutcomeEngine = runOutcomeEngine;
const eventModel_1 = require("./eventModel");
const priceProjectionEngine_1 = require("./priceProjectionEngine");
const probabilityEngine_1 = require("./probabilityEngine");
function runOutcomeEngine(input) {
    const baseValue = input.currentEstimatedValue || 0;
    const events = input.events || [];
    const eventModels = events.length > 0 ? events.map(e => (0, eventModel_1.getEventModel)(e)) : [(0, eventModel_1.getEventModel)('performance_hot')];
    const scenarioResults = eventModels.map(event => {
        const price = (0, priceProjectionEngine_1.projectPrice)(input, [event]);
        let playerSignalScore = 0.5;
        if (input.playerSignal === 'positive')
            playerSignalScore = 0.8;
        if (input.playerSignal === 'negative')
            playerSignalScore = 0.2;
        let trendStrengthScore = 0.5;
        if (input.trendStrength === 'strong')
            trendStrengthScore = 0.8;
        if (input.trendStrength === 'moderate')
            trendStrengthScore = 0.6;
        if (input.trendStrength === 'low')
            trendStrengthScore = 0.4;
        const probability = (0, probabilityEngine_1.getProbability)(input, [event], event.confidence);
        const reasoning = [];
        if (event.eventType === 'promotion')
            reasoning.push('Promotions typically increase demand');
        if (event.eventType === 'performance_hot')
            reasoning.push('Hot performance can drive price upside');
        if (input.supplyTrend === 'tightening')
            reasoning.push('Supply tightening amplifies price movement');
        if (input.trendDirection === 'up')
            reasoning.push('Upward trends support higher prices');
        if (input.liquidityScore && input.liquidityScore > 0.7)
            reasoning.push('High liquidity supports price realization');
        return {
            name: `${event.eventType.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())} Scenario`,
            projectedValueLow: price.projectedValueLow,
            projectedValueHigh: price.projectedValueHigh,
            probability,
            timelineDays: event.durationDays,
            reasoning
        };
    });
    const bestCase = Math.max(...scenarioResults.map(s => s.projectedValueHigh));
    const worstCase = Math.min(...scenarioResults.map(s => s.projectedValueLow));
    const mostLikely = Math.round(scenarioResults.reduce((sum, s) => sum + s.projectedValueLow * s.probability, 0) / scenarioResults.length);
    return {
        summary: {
            currentValue: baseValue,
            bestCase,
            worstCase,
            mostLikely
        },
        scenarios: scenarioResults
    };
}
