"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllProviderHealth = getAllProviderHealth;
const comps_1 = require("./comps");
const supply_1 = require("./supply");
const playerPerformance_1 = require("./playerPerformance");
async function getAllProviderHealth() {
    return {
        comps: await (0, comps_1.compsProviderHealth)(),
        supply: await (0, supply_1.supplyProviderHealth)(),
        playerPerformance: await (0, playerPerformance_1.playerPerformanceProviderHealth)(),
        // Add more providers as needed
    };
}
