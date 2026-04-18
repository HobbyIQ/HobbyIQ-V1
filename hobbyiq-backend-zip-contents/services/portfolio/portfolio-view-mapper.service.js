"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioViewMapperService = void 0;
class PortfolioViewMapperService {
    static toViewDto(position, metrics, actionPlan, decisionSummary, freshnessAsOf) {
        return {
            position,
            metrics,
            actionPlan,
            decisionSummary,
            freshnessAsOf,
        };
    }
}
exports.PortfolioViewMapperService = PortfolioViewMapperService;
