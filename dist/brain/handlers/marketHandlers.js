"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBuys = getBestBuys;
exports.getMarketMovers = getMarketMovers;
exports.getPlayerSummary = getPlayerSummary;
const marketProviders_1 = require("../../providers/marketProviders");
async function getBestBuys() {
    return (0, marketProviders_1.getBestBuysProvider)();
}
async function getMarketMovers() {
    return (0, marketProviders_1.getMarketMoversProvider)();
}
async function getPlayerSummary(player) {
    return (0, marketProviders_1.getPlayerSummaryProvider)(player);
}
