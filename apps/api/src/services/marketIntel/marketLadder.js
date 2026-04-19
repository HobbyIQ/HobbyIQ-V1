"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMarketLadder = buildMarketLadder;
function buildMarketLadder(context) {
    // Example: fallback mock ladder
    return [
        {
            label: "Base Auto Raw",
            cardKey: context.cardKey,
            estimatedPrice: context.weightedMedian,
            compCount: context.compCount,
            liquidityScore: context.liquidityScore,
            activeSupply: 10,
            supplyTrend: "flat",
            demandTrend: "up"
        },
        {
            label: "Gold /50 PSA 10",
            cardKey: context.cardKey + "-gold-psa10",
            estimatedPrice: context.weightedMedian * 3,
            compCount: Math.round(context.compCount / 2),
            liquidityScore: context.liquidityScore * 0.8,
            activeSupply: 2,
            supplyTrend: "down",
            demandTrend: "up"
        }
    ];
}
