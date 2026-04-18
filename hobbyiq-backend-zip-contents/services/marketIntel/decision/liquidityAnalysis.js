"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildLiquidityProfile = buildLiquidityProfile;
exports.buildLiquidityLadder = buildLiquidityLadder;
function buildLiquidityProfile(context) {
    // TODO: Use real comp and supply data
    return {
        label: "medium",
        avgDaysToMoveEstimate: 7,
        salesFrequencyScore: 0.6,
        spreadRiskScore: 0.3,
        explanation: ["Moderate liquidity; typical sale in 7 days."]
    };
}
function buildLiquidityLadder(context) {
    // TODO: Use real ladder data
    return [
        {
            label: "Base Auto Raw",
            estimatedPrice: context.weightedMedian,
            liquidityLabel: "medium",
            avgDaysToMoveEstimate: 7,
            activeSupply: 10,
            salesVelocity: 2
        },
        {
            label: "Gold /50 PSA 10",
            estimatedPrice: context.weightedMedian * 3,
            liquidityLabel: "low",
            avgDaysToMoveEstimate: 21,
            activeSupply: 2,
            salesVelocity: 0.5
        }
    ];
}
