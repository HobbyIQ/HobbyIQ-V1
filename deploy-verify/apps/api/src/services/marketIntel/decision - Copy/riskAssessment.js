"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessRisks = assessRisks;
function assessRisks(context) {
    // TODO: Use real context and signals
    return {
        downsideRiskScore: 0.3,
        volatilityScore: 0.4,
        liquidityRiskScore: 0.2,
        compQualityRiskScore: 0.3,
        staleMarketRiskScore: 0.2,
        spikeRiskScore: 0.1,
        overallRiskLabel: "low",
        warnings: ["Thin market; estimate is model-heavy"],
        explanation: ["Low downside risk due to strong comp base and stable supply."]
    };
}
