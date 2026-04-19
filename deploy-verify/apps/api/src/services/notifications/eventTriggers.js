"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerNotification = triggerNotification;
exports.onPriceSpike = onPriceSpike;
exports.onSupplyDrop = onSupplyDrop;
exports.onSellSignal = onSellSignal;
exports.onBuySignal = onBuySignal;
exports.onPortfolioRoi = onPortfolioRoi;
async function triggerNotification(service, userId, type, message, data, planTier = 'Prospect') {
    // This function can be called from pricing, supply, portfolio, etc.
    // Example: check user preferences before sending
    await service.send({ userId, type, message, data }, 'in-app', planTier);
    await service.send({ userId, type, message, data }, 'push', planTier);
}
// Example trigger wrappers
async function onPriceSpike(service, userId, details, planTier = 'Prospect') {
    await triggerNotification(service, userId, 'price-spike', 'Price spike detected!', details, planTier);
}
async function onSupplyDrop(service, userId, details, planTier = 'Prospect') {
    await triggerNotification(service, userId, 'supply-drop', 'Supply drop detected!', details, planTier);
}
async function onSellSignal(service, userId, details, planTier = 'Prospect') {
    await triggerNotification(service, userId, 'sell-signal', 'Sell signal generated!', details, planTier);
}
async function onBuySignal(service, userId, details, planTier = 'Prospect') {
    await triggerNotification(service, userId, 'buy-signal', 'Buy signal generated!', details, planTier);
}
async function onPortfolioRoi(service, userId, details, planTier = 'Prospect') {
    await triggerNotification(service, userId, 'portfolio-roi', 'Portfolio ROI threshold reached!', details, planTier);
}
