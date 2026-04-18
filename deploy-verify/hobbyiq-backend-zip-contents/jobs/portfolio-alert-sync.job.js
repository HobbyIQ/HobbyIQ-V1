"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioAlertSyncJob = void 0;
class PortfolioAlertSyncJob {
    constructor(positionService, alertContextService) {
        this.positionService = positionService;
        this.alertContextService = alertContextService;
    }
    async run(userId) {
        const positions = await this.positionService.listPositions(userId);
        for (const p of positions) {
            const position = {
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
            };
            const alerts = this.alertContextService.getAlertContext(position);
            // TODO: Feed alerts into alert system
        }
    }
}
exports.PortfolioAlertSyncJob = PortfolioAlertSyncJob;
