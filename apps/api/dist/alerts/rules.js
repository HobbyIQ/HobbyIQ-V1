"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateBuyTargetBreach = evaluateBuyTargetBreach;
exports.evaluateSellTargetBreach = evaluateSellTargetBreach;
exports.evaluateRecommendationShift = evaluateRecommendationShift;
const client_1 = require("@prisma/client");
function evaluateBuyTargetBreach(card, watchlistItem) {
    if (!watchlistItem?.targetBuyPrice || card.currentEstimatedValue >= watchlistItem.targetBuyPrice)
        return null;
    return {
        userId: card.userId,
        portfolioCardId: card.id,
        alertType: client_1.AlertType.BUY_TARGET_BREACH,
        severity: client_1.AlertSeverity.INFO,
        title: `Buy target reached for ${card.player}`,
        message: `Current value $${card.currentEstimatedValue} is below your target buy price $${watchlistItem.targetBuyPrice}.`,
        metadata: { current: card.currentEstimatedValue, target: watchlistItem.targetBuyPrice }
    };
}
function evaluateSellTargetBreach(card, watchlistItem) {
    if (!watchlistItem?.targetSellPrice || card.currentEstimatedValue <= watchlistItem.targetSellPrice)
        return null;
    return {
        userId: card.userId,
        portfolioCardId: card.id,
        alertType: client_1.AlertType.SELL_TARGET_BREACH,
        severity: client_1.AlertSeverity.INFO,
        title: `Sell target reached for ${card.player}`,
        message: `Current value $${card.currentEstimatedValue} is above your target sell price $${watchlistItem.targetSellPrice}.`,
        metadata: { current: card.currentEstimatedValue, target: watchlistItem.targetSellPrice }
    };
}
function evaluateRecommendationShift(card, prevRecommendation) {
    if (card.currentRecommendation !== prevRecommendation) {
        return {
            userId: card.userId,
            portfolioCardId: card.id,
            alertType: client_1.AlertType.RECOMMENDATION_SHIFT,
            severity: client_1.AlertSeverity.WARNING, // MODERATE does not exist, use WARNING
            title: `Recommendation changed for ${card.player}`,
            message: `Recommendation changed from ${prevRecommendation} to ${card.currentRecommendation}.`,
            metadata: { prev: prevRecommendation, next: card.currentRecommendation }
        };
    }
    return null;
}
// Add more rules as needed for risk spike, momentum breakout, etc.
