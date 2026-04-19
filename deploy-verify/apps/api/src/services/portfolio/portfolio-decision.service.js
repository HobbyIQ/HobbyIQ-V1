"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioDecisionService = void 0;
class PortfolioDecisionService {
    // In real impl, use Decision Layer, risk, targets, etc.
    recommendAction(metrics) {
        if (metrics.unrealizedGainLossPct != null) {
            if (metrics.unrealizedGainLossPct > 40)
                return "trim";
            if (metrics.unrealizedGainLossPct < -15)
                return "watch";
            if (metrics.unrealizedGainLossPct > 10)
                return "hold";
            if (metrics.unrealizedGainLossPct < 0)
                return "buy_more";
        }
        return "hold";
    }
}
exports.PortfolioDecisionService = PortfolioDecisionService;
