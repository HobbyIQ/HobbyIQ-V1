"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackSupply = trackSupply;
exports.supplyProviderHealth = supplyProviderHealth;
// Placeholder for future Supply Tracking module
const factory_1 = require("../providers/factory");
const supplyProvider = (0, factory_1.createSupplyProvider)();
async function trackSupply(card) {
    return supplyProvider.getSupply(card.id);
}
async function supplyProviderHealth() {
    return supplyProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled supply refresh
