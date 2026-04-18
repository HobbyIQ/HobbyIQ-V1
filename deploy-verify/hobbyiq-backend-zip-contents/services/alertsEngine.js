"use strict";
// src/services/alertsEngine.ts
// HobbyIQ Alerts Engine: generates alerts from CompIQ and PortfolioIQ outputs
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCompIQAlerts = generateCompIQAlerts;
exports.generatePortfolioIQAlerts = generatePortfolioIQAlerts;
// Generate alerts from CompIQ output
function generateCompIQAlerts(comp) {
    const alerts = [];
    const { player, keyNumbers, directAnswer } = comp;
    if (keyNumbers && keyNumbers.trend && keyNumbers.trend < -15) {
        alerts.push({
            type: "SELL_ALERT",
            player,
            message: `Market trend is sharply negative for ${player}. Consider selling.`,
            priority: 1
        });
    }
    else if (keyNumbers && keyNumbers.trend && keyNumbers.trend > 15) {
        alerts.push({
            type: "BUY_ALERT",
            player,
            message: `Market trend is strongly positive for ${player}. Consider buying.`,
            priority: 2
        });
    }
    if (directAnswer && /panic|crash|urgent/i.test(directAnswer)) {
        alerts.push({
            type: "PANIC_ALERT",
            player,
            message: `Panic signal detected for ${player}: ${directAnswer}`,
            priority: 1
        });
    }
    // Add watch alert for moderate signals
    if (keyNumbers && Math.abs(keyNumbers.trend || 0) > 5 && Math.abs(keyNumbers.trend || 0) <= 15) {
        alerts.push({
            type: "WATCH_ALERT",
            player,
            message: `Market movement for ${player} is notable. Watch closely.`,
            priority: 3
        });
    }
    return alerts;
}
// Generate alerts from PortfolioIQ output
function generatePortfolioIQAlerts(portfolio) {
    const alerts = [];
    for (const card of portfolio.cards) {
        if (card.currentValue < 0.7 * card.purchasePrice) {
            alerts.push({
                type: "SELL_ALERT",
                player: card.player,
                message: `Value of ${card.card} dropped significantly. Consider selling.`,
                priority: 1
            });
        }
        else if (card.currentValue > 1.2 * card.purchasePrice) {
            alerts.push({
                type: "BUY_ALERT",
                player: card.player,
                message: `Value of ${card.card} increased. Consider buying more or holding.`,
                priority: 2
            });
        }
        else if (card.currentValue < 0.5 * card.purchasePrice) {
            alerts.push({
                type: "PANIC_ALERT",
                player: card.player,
                message: `Severe loss detected for ${card.card}. Immediate action recommended!`,
                priority: 1
            });
        }
        else if (Math.abs(card.currentValue - card.purchasePrice) / card.purchasePrice < 0.05) {
            alerts.push({
                type: "WATCH_ALERT",
                player: card.player,
                message: `Value of ${card.card} is stable. Monitor for changes.`,
                priority: 3
            });
        }
    }
    return alerts;
}
