"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const portfolio_metrics_service_1 = require("../../src/services/portfolio/portfolio-metrics.service");
const portfolio_valuation_service_1 = require("../../src/services/portfolio/portfolio-valuation.service");
describe('PortfolioMetricsService', () => {
    const valuation = new portfolio_valuation_service_1.PortfolioValuationService();
    const service = new portfolio_metrics_service_1.PortfolioMetricsService(valuation);
    it('should compute metrics with gain', async () => {
        const position = {
            positionId: 'p1',
            userId: 'u1',
            entityType: 'card',
            entityKey: 'c1',
            quantity: 2,
            averageCost: 100,
            totalCostBasis: 200,
            currentModeledValue: 150,
            currentTotalValue: 300,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            createdAt: '',
            updatedAt: '',
        };
        const metrics = await service.computeMetrics(position, 50);
        expect(metrics.unrealizedGainLoss).toBe(100);
        expect(metrics.unrealizedGainLossPct).toBe(50);
        expect(metrics.allocationPct).toBe(50);
    });
});
