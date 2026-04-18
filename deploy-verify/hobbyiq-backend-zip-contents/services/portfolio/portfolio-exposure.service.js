"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioExposureService = void 0;
const portfolio_config_1 = require("../../config/portfolio.config");
class PortfolioExposureService {
    computeExposure(userId, positions) {
        const totalValue = positions.reduce((sum, pos) => sum + (pos.currentTotalValue ?? 0), 0);
        return positions.map(p => {
            const allocationPct = totalValue > 0 ? ((p.currentTotalValue ?? 0) / totalValue) * 100 : 0;
            const overexposed = allocationPct > portfolio_config_1.portfolioConfig.overexposureAllocationThresholdPct;
            const notes = [];
            if (overexposed)
                notes.push(`This position is ${allocationPct.toFixed(1)}% of your portfolio.`);
            if (p.convictionTag === 'spec')
                notes.push('Speculative position.');
            return {
                userId,
                entityKey: p.entityKey,
                exposureScore: allocationPct,
                overexposed,
                notes,
            };
        });
    }
}
exports.PortfolioExposureService = PortfolioExposureService;
