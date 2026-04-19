"use strict";
// apps/api/src/engines/alertsEngine.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAlerts = generateAlerts;
function generateAlerts(comp) {
    const alerts = [];
    const { player, median, latestPrice, roi, decision, risk, confidence, compCount } = comp;
    // 1. SELL_ALERT
    if (typeof roi === 'number' && roi > 25 && decision === 'SELL') {
        alerts.push({
            type: 'SELL_ALERT',
            player,
            message: `${player}: Consider selling. ROI is high (${roi}%) and decision is SELL.`,
            priority: 'HIGH',
        });
    }
    // 2. BUY_ALERT
    if (typeof latestPrice === 'number' && typeof median === 'number' &&
        latestPrice < median * 0.85 &&
        risk && (risk.level === 'LOW' || risk.level === 'MEDIUM')) {
        alerts.push({
            type: 'BUY_ALERT',
            player,
            message: `${player}: Good buy opportunity. Price is well below market median and risk is ${risk.level}.`,
            priority: 'MEDIUM',
        });
    }
    // 3. PANIC_ALERT
    if (risk && risk.level === 'HIGH' &&
        typeof latestPrice === 'number' && typeof median === 'number' &&
        latestPrice < median * 0.8) {
        alerts.push({
            type: 'PANIC_ALERT',
            player,
            message: `${player}: High risk and price is far below market. Consider urgent review.`,
            priority: 'HIGH',
        });
    }
    // 4. WATCH_ALERT
    if ((confidence && confidence.toUpperCase() === 'LOW') ||
        (typeof compCount === 'number' && compCount < 5)) {
        alerts.push({
            type: 'WATCH_ALERT',
            player,
            message: `${player}: Data is limited or confidence is low. Monitor closely.`,
            priority: 'LOW',
        });
    }
    return alerts;
}
