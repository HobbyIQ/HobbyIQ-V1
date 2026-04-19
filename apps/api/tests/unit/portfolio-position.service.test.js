"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const portfolio_position_service_1 = require("../../src/services/portfolio/portfolio-position.service");
describe('PortfolioPositionService', () => {
    const repo = {
        listByUser: jest.fn(async () => []),
        findByEntity: jest.fn(async () => null),
    };
    const service = new portfolio_position_service_1.PortfolioPositionService(repo);
    it('should validate and create a position', async () => {
        const input = {
            userId: 'u1',
            entityType: 'card',
            entityKey: 'c1',
            quantity: 2,
            averageCost: 100,
        };
        const result = await service.createPosition(input);
        expect(result.userId).toBe('u1');
        expect(result.quantity).toBe(2);
        expect(result.totalCostBasis).toBe(200);
    });
    it('should throw on invalid quantity', async () => {
        await expect(service.createPosition({ userId: 'u1', entityType: 'card', entityKey: 'c1', quantity: 0 })).rejects.toThrow();
    });
});
