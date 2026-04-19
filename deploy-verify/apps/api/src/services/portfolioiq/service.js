"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addPortfolioHolding = addPortfolioHolding;
exports.listPortfolioHoldings = listPortfolioHoldings;
exports.getPortfolioSummary = getPortfolioSummary;
const storage_1 = require("./storage");
const compiq_1 = require("../compiq");
// Add holding and estimate value
async function addPortfolioHolding(input) {
    const warnings = [];
    if (!input.player)
        warnings.push("Player is required");
    if (!input.cardSet)
        warnings.push("Set is required");
    if (!input.quantity || input.quantity < 1)
        warnings.push("Quantity must be at least 1");
    if (!input.costBasis || input.costBasis < 0)
        warnings.push("Cost basis must be >= 0");
    const holding = (0, storage_1.addHolding)(input);
    // Use CompIQ for value estimate
    const compInput = {
        query: `${input.player} ${input.cardSet} ${input.parallel || ''} ${input.grade || ''} ${input.isAuto ? 'Auto' : ''}`.trim(),
        player: input.player,
        set: input.cardSet,
        parallel: input.parallel,
        gradeTarget: input.grade,
        isAuto: input.isAuto,
    };
    const compResult = await (0, compiq_1.runCompIQ)(compInput);
    holding.estimatedUnitValue = compResult.rawPrice ?? null;
    holding.estimatedTotalValue = holding.estimatedUnitValue !== null ? holding.estimatedUnitValue * input.quantity : null;
    holding.gainLossAmount = holding.estimatedTotalValue !== null ? holding.estimatedTotalValue - input.costBasis : null;
    holding.gainLossPercent = holding.gainLossAmount !== null && input.costBasis > 0 ? (holding.gainLossAmount / input.costBasis) * 100 : null;
    if (holding.gainLossPercent === null)
        holding.statusFlag = "Monitor";
    else if (holding.gainLossPercent > 20)
        holding.statusFlag = "Hold";
    else if (holding.gainLossPercent < -10)
        holding.statusFlag = "Sell";
    else
        holding.statusFlag = "Monitor";
    holding.confidence = compResult.confidenceScore;
    holding.warnings = [...warnings, ...compResult.warnings];
    holding.nextActions = compResult.nextActions;
    (0, storage_1.updateHolding)(holding);
    return { ...holding, success: warnings.length === 0 };
}
async function listPortfolioHoldings() {
    const holdings = (0, storage_1.listHoldings)();
    return { success: true, holdings };
}
async function getPortfolioSummary() {
    const holdings = (0, storage_1.listHoldings)();
    const totalHoldings = holdings.length;
    const totalCostBasis = holdings.reduce((sum, h) => sum + (h.costBasis || 0), 0);
    const totalEstimatedValue = holdings.reduce((sum, h) => sum + (h.estimatedTotalValue || 0), 0);
    const totalGainLossAmount = totalEstimatedValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLossAmount / totalCostBasis) * 100 : 0;
    const sorted = [...holdings].sort((a, b) => (b.gainLossPercent || 0) - (a.gainLossPercent || 0));
    const topWinners = sorted.slice(0, 3);
    const topRiskPositions = sorted.slice(-3);
    return {
        success: true,
        summary: {
            totalHoldings,
            totalCostBasis,
            totalEstimatedValue,
            totalGainLossAmount,
            totalGainLossPercent,
            topWinners,
            topRiskPositions,
        },
        warnings: [],
        nextActions: [],
    };
}
