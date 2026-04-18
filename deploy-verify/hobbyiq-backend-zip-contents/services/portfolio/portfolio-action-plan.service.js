"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioActionPlanService = void 0;
class PortfolioActionPlanService {
    generateActionPlan(positionId, metrics, action) {
        // Example logic, expand with real rules
        let summary = '';
        let whyNow = [];
        let actionSteps = [];
        switch (action) {
            case 'buy_more':
                summary = 'Consider adding to this position.';
                whyNow.push('Price is below your cost basis.');
                actionSteps.push('Review fundamentals.');
                break;
            case 'trim':
                summary = 'Consider trimming gains.';
                whyNow.push('Strong unrealized gains.');
                actionSteps.push('Evaluate conviction and market setup.');
                break;
            case 'sell':
                summary = 'Consider selling this position.';
                whyNow.push('Risk or thesis has changed.');
                actionSteps.push('Review exit plan.');
                break;
            case 'hold':
                summary = 'Hold your position.';
                whyNow.push('No strong buy/sell signal.');
                actionSteps.push('Monitor for changes.');
                break;
            case 'watch':
                summary = 'Monitor this position closely.';
                whyNow.push('Recent drawdown or risk.');
                actionSteps.push('Set alerts for further downside.');
                break;
            case 'avoid_adding':
                summary = 'Avoid adding to this position.';
                whyNow.push('Already large allocation or risk.');
                actionSteps.push('Focus on diversification.');
                break;
        }
        return {
            positionId,
            recommendedAction: action,
            urgencyScore: 0.5,
            confidenceScore: 0.7,
            summary,
            whyNow,
            actionSteps,
            updatedAt: new Date().toISOString(),
        };
    }
}
exports.PortfolioActionPlanService = PortfolioActionPlanService;
