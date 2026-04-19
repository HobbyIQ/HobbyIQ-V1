"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getComps = getComps;
exports.compsProviderHealth = compsProviderHealth;
const factory_1 = require("../providers/factory");
const compsProvider = (0, factory_1.createCompsProvider)();
async function getComps(query) {
    return compsProvider.getComps(query);
}
async function compsProviderHealth() {
    return compsProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled comps refresh
