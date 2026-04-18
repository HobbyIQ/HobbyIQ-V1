"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildScenarios = buildScenarios;
const eventModel_1 = require("./eventModel");
const priceProjectionEngine_1 = require("./priceProjectionEngine");
function buildScenarios(payload) {
    const { currentEstimatedValue, events = [] } = payload;
    const eventModels = events.map((e) => (0, eventModel_1.getEventModel)(e));
    const scenarios = eventModels.map(event => {
        const { projectedValueLow, projectedValueHigh, multiplierLow, multiplierHigh, probability, timelineDays, reasoning } = (0, priceProjectionEngine_1.projectPrice)(payload, [event]);
        return {
            name: `${event.eventType.replace('_', ' ').toUpperCase()} Scenario`,
            projectedValueLow,
            projectedValueHigh,
            multiplierLow,
            multiplierHigh,
            probability,
            timelineDays,
            reasoning
        };
    });
    if (eventModels.length > 1) {
        const { projectedValueLow, projectedValueHigh, multiplierLow, multiplierHigh, probability, timelineDays, reasoning } = (0, priceProjectionEngine_1.projectPrice)(payload, eventModels);
        scenarios.push({
            name: 'Combined Scenario',
            projectedValueLow,
            projectedValueHigh,
            multiplierLow,
            multiplierHigh,
            probability,
            timelineDays,
            reasoning
        });
    }
    const bestCase = Math.max(...scenarios.map(s => s.projectedValueHigh));
    const worstCase = Math.min(...scenarios.map(s => s.projectedValueLow));
    const mostLikely = Math.round(scenarios.reduce((sum, s) => sum + s.projectedValueLow * s.probability, 0) / scenarios.length);
    return {
        scenarios,
        summary: {
            currentValue: currentEstimatedValue,
            bestCase,
            worstCase,
            mostLikely
        }
    };
}
