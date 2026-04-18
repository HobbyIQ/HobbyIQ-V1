"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioSummaryService = void 0;
class PortfolioSummaryService {
    computeSummary(userId, positions) {
        let buyMoreCount = 0, holdCount = 0, trimCount = 0, sellCount = 0, watchCount = 0;
        positions.forEach(p => {
            // In real impl, use action plan/decision
            if (p.unrealizedGainLossPct != null) {
                if (p.unrealizedGainLossPct > 40)
                    trimCount++;
                else if (p.unrealizedGainLossPct < -15)
                    watchCount++;
                else if (p.unrealizedGainLossPct > 10)
                    holdCount++;
                else if (p.unrealizedGainLossPct < 0)
                    buyMoreCount++;
                else
                    holdCount++;
            }
            else
                holdCount++;
        });
        return {
            userId,
            totalPositions: positions.length,
            totalEstimatedValue: positions.reduce((sum, p) => sum + (p.currentTotalValue ?? 0), 0),
            totalCostBasis: positions.reduce((sum, p) => sum + (p.totalCostBasis ?? 0), 0) || null,
            totalUnrealizedGainLoss: positions.reduce((sum, p) => sum + ((p.currentTotalValue ?? 0) - (p.totalCostBasis ?? 0)), 0) || null,
            totalUnrealizedGainLossPct: null, // Can be computed if needed
            buyMoreCount,
            holdCount,
            trimCount,
            sellCount,
            watchCount,
            updatedAt: new Date().toISOString(),
        };
    }
}
exports.PortfolioSummaryService = PortfolioSummaryService;
