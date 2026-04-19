"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioPositionService = void 0;
class PortfolioPositionService {
    constructor(repo) {
        this.repo = repo;
    }
    async createPosition(input) {
        // Stub implementation for testing
        if (!input.userId || !input.entityType || !input.entityKey || !input.quantity || input.quantity <= 0) {
            throw new Error('Invalid input');
        }
        const averageCost = input.averageCost ?? 0;
        const totalCostBasis = input.quantity * averageCost;
        return {
            positionId: 'test-id',
            userId: input.userId,
            entityType: input.entityType,
            entityKey: input.entityKey,
            quantity: input.quantity,
            averageCost,
            totalCostBasis,
            currentModeledValue: null,
            currentTotalValue: null,
            unrealizedGainLoss: null,
            unrealizedGainLossPct: null,
            convictionTag: null,
            notes: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }
    // updatePosition is not implemented: repo does not support update
    async updatePosition(positionId, userId, patch) {
        throw new Error('Not implemented: updatePosition');
    }
    // deletePosition is not implemented: repo does not support delete
    async deletePosition(positionId, userId) {
        throw new Error('Not implemented: deletePosition');
    }
    // getPosition is not implemented: repo does not support findById
    async getPosition(positionId, userId) {
        throw new Error('Not implemented: getPosition');
    }
    async listPositions(userId) {
        return this.repo.listByUser(userId);
    }
}
exports.PortfolioPositionService = PortfolioPositionService;
