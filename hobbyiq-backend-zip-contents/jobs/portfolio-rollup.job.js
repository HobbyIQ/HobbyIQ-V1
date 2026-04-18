"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioRollupJob = void 0;
class PortfolioRollupJob {
    constructor(positionService, summaryService, allocationService, exposureService) {
        this.positionService = positionService;
        this.summaryService = summaryService;
        this.allocationService = allocationService;
        this.exposureService = exposureService;
    }
    async run(userId) {
        const positions = await this.positionService.listPositions(userId);
        const fullPositions = positions.map(p => ({
            ...p,
            quantity: p.quantity ?? 0,
            averageCost: p.averageCost ?? null,
            totalCostBasis: null,
            currentModeledValue: null,
            currentTotalValue: null,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            convictionTag: p.convictionTag ?? null,
            notes: null,
        }));
        const summary = this.summaryService.computeSummary(userId, fullPositions);
        const allocation = this.allocationService.computeAllocation(userId, fullPositions);
        const exposure = this.exposureService.computeExposure(userId, fullPositions);
        // TODO: Persist summary/allocation/exposure if needed
        return { summary, allocation, exposure };
    }
}
exports.PortfolioRollupJob = PortfolioRollupJob;
