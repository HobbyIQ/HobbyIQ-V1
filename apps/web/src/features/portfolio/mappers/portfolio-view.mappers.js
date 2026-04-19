"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapToPortfolioPositionView = mapToPortfolioPositionView;
function mapToPortfolioPositionView(position, metrics, actionPlan, decisionSummary, freshnessAsOf) {
    return {
        position,
        metrics,
        actionPlan,
        decisionSummary,
        freshnessAsOf,
    };
}
