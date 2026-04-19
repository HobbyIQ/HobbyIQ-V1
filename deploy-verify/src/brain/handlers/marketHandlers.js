"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBuys = getBestBuys;
exports.getMarketMovers = getMarketMovers;
exports.getPlayerSummary = getPlayerSummary;
// Handlers for best-buys, market-movers, player-summary
const marketProviders_1 = require("../../providers/marketProviders");
async function getBestBuys() {
    // TODO: Replace with real provider
    return (0, marketProviders_1.getBestBuysProvider)();
}
async function getMarketMovers() {
    // TODO: Replace with real provider
    return (0, marketProviders_1.getMarketMoversProvider)();
}
async function getPlayerSummary(player) {
    // TODO: Replace with real provider
    return (0, marketProviders_1.getPlayerSummaryProvider)(player);
}
