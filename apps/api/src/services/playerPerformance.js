"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlayerPerformance = getPlayerPerformance;
exports.playerPerformanceProviderHealth = playerPerformanceProviderHealth;
const factory_1 = require("../providers/factory");
const playerPerformanceProvider = (0, factory_1.createPlayerPerformanceProvider)();
async function getPlayerPerformance(playerId) {
    return playerPerformanceProvider.getPerformance(playerId);
}
async function playerPerformanceProviderHealth() {
    return playerPerformanceProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled player performance refresh
