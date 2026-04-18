"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioValuationService = void 0;
class PortfolioValuationService {
    // This should use snapshot/decision services in real impl
    async getCurrentModeledValue(position) {
        // TODO: Integrate with snapshot/decision layer
        return position.currentModeledValue ?? null;
    }
    async getCurrentTotalValue(position) {
        const modeled = await this.getCurrentModeledValue(position);
        return modeled != null && position.quantity ? modeled * position.quantity : null;
    }
}
exports.PortfolioValuationService = PortfolioValuationService;
