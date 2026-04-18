"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioAlertContextService = void 0;
class PortfolioAlertContextService {
    getAlertContext(position) {
        const alerts = [];
        if (position.unrealizedGainLossPct != null && position.unrealizedGainLossPct > 40) {
            alerts.push('Trim alert: Strong gains.');
        }
        if (position.unrealizedGainLossPct != null && position.unrealizedGainLossPct < -15) {
            alerts.push('Protect capital alert: Drawdown.');
        }
        // Add more alert context logic as needed
        return alerts;
    }
}
exports.PortfolioAlertContextService = PortfolioAlertContextService;
