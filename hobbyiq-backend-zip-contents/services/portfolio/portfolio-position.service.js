"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioPositionService = void 0;
class PortfolioPositionService {
    constructor(repo) {
        this.repo = repo;
    }
    // createPosition is not implemented: repo does not support create
    async createPosition(input) {
        throw new Error('Not implemented: createPosition');
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
