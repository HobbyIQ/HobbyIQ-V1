"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioMetricsService = void 0;
class PortfolioMetricsService {
    constructor(valuation) {
        this.valuation = valuation;
    }
    async computeMetrics(position, allocationPct = null) {
        const currentModeledValue = await this.valuation.getCurrentModeledValue(position);
        const currentTotalValue = await this.valuation.getCurrentTotalValue(position);
        const totalCostBasis = position.totalCostBasis;
        const unrealizedGainLoss = (currentTotalValue != null && totalCostBasis != null) ? currentTotalValue - totalCostBasis : null;
        const unrealizedGainLossPct = (unrealizedGainLoss != null && totalCostBasis && totalCostBasis !== 0) ? (unrealizedGainLoss / totalCostBasis) * 100 : null;
        return {
            positionId: position.positionId,
            quantity: position.quantity,
            averageCost: position.averageCost,
            totalCostBasis,
            currentModeledValue,
            currentTotalValue,
            unrealizedGainLoss,
            unrealizedGainLossPct,
            allocationPct,
            riskScore: null,
            decisionAction: null,
            actionConfidence: null,
            freshnessAsOf: null,
        };
    }
}
exports.PortfolioMetricsService = PortfolioMetricsService;
