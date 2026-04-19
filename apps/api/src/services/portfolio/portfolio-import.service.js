"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioImportService = void 0;
class PortfolioImportService {
    constructor(positionService) {
        this.positionService = positionService;
    }
    async importPositions(userId, positions) {
        let created = 0, failed = 0;
        const errors = [];
        for (let i = 0; i < positions.length; i++) {
            try {
                await this.positionService.createPosition({ ...positions[i], userId });
                created++;
            }
            catch (e) {
                failed++;
                errors.push({ row: i, error: e.message });
            }
        }
        return { created, failed, errors };
    }
}
exports.PortfolioImportService = PortfolioImportService;
