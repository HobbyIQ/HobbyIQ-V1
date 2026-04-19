"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardOutcomeHandler = cardOutcomeHandler;
const scenarioBuilder_1 = require("../../services/prediction/scenarioBuilder");
const cardOutcomeViewModel_1 = require("../formatters/cardOutcomeViewModel");
const performanceImpactEngine_1 = require("../../services/marketImpact/performanceImpactEngine");
const rankingImpactEngine_1 = require("../../services/marketImpact/rankingImpactEngine");
const awardsImpactEngine_1 = require("../../services/marketImpact/awardsImpactEngine");
const hobbyBuzzEngine_1 = require("../../services/marketImpact/hobbyBuzzEngine");
const marketImpactAggregator_1 = require("../../services/marketImpact/marketImpactAggregator");
const outcomeLogger_1 = require("../../services/learning/outcomeLogger");
async function cardOutcomeHandler(payload) {
    // Build scenarios
    const scenariosResult = (0, scenarioBuilder_1.buildScenarios)(payload);
    // Market Impact Layer (mocked inputs for now)
    const perfImpact = (0, performanceImpactEngine_1.getPerformanceImpact)(payload?.stats || null);
    const rankingImpact = (0, rankingImpactEngine_1.getRankingImpact)(payload?.rankingData || null);
    const awardsImpact = (0, awardsImpactEngine_1.getAwardsImpact)(payload?.awardsData || null);
    const hobbyBuzzImpact = (0, hobbyBuzzEngine_1.getHobbyBuzzImpact)(payload?.hobbyBuzzData || null);
    const marketImpact = (0, marketImpactAggregator_1.aggregateMarketImpact)([
        perfImpact,
        rankingImpact,
        awardsImpact,
        hobbyBuzzImpact
    ]);
    // Log prediction
    (0, outcomeLogger_1.logOutcomePrediction)({ input: payload, ...scenariosResult, marketImpact, timestamp: new Date().toISOString() });
    // Format for frontend
    return (0, cardOutcomeViewModel_1.formatCardOutcomeViewModel)(payload, { ...scenariosResult, marketImpact });
}
