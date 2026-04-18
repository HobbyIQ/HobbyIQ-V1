"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addHolding = addHolding;
exports.listHoldings = listHoldings;
exports.getPortfolioSummary = getPortfolioSummary;
const service_1 = require("../compiq/service");
const validation_1 = require("../../shared/validation");
const holdings = [];
async function addHolding(input) {
    (0, validation_1.validatePortfolioAddRequest)(input);
    const estimate = await (0, service_1.handleCompIQLiveEstimate)({ query: input.cardTitle });
    const estimatedUnitValue = estimate.rawPrice;
    const estimatedTotalValue = estimatedUnitValue * input.quantity;
    const gainLossAmount = estimatedTotalValue - input.costBasis;
    const gainLossPercent = input.costBasis > 0 ? (gainLossAmount / input.costBasis) * 100 : 0;
    const statusFlag = gainLossAmount > 0 ? "Hold" : gainLossAmount < -50 ? "Sell" : "Monitor";
    const confidence = estimate.confidenceScore;
    const warnings = estimate.warnings;
    const nextActions = estimate.nextActions;
    const holding = {
        ...input,
        estimatedUnitValue,
        estimatedTotalValue,
        gainLossAmount,
        gainLossPercent,
        statusFlag,
        confidence,
        warnings,
        nextActions
    };
    holdings.push(holding);
    return holding;
}
async function listHoldings() {
    return { success: true, holdings };
}
async function getPortfolioSummary() {
    const totalHoldings = holdings.length;
    const totalCostBasis = holdings.reduce((sum, h) => sum + h.costBasis, 0);
    const totalEstimatedValue = holdings.reduce((sum, h) => sum + h.estimatedTotalValue, 0);
    const totalGainLossAmount = totalEstimatedValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLossAmount / totalCostBasis) * 100 : 0;
    const topWinners = [...holdings].sort((a, b) => b.gainLossAmount - a.gainLossAmount).slice(0, 3);
    const topRiskPositions = [...holdings].sort((a, b) => a.gainLossAmount - b.gainLossAmount).slice(0, 3);
    return {
        success: true,
        totalHoldings,
        totalCostBasis,
        totalEstimatedValue,
        totalGainLossAmount,
        totalGainLossPercent,
        topWinners,
        topRiskPositions
    };
}
