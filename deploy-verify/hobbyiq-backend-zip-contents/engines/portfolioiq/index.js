"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAddHolding = handleAddHolding;
exports.handleListHoldings = handleListHoldings;
exports.handlePortfolioSummary = handlePortfolioSummary;
const service_1 = require("./service");
async function handleAddHolding(req) {
    return (0, service_1.addHolding)(req);
}
async function handleListHoldings() {
    return (0, service_1.listHoldings)();
}
async function handlePortfolioSummary() {
    return (0, service_1.getPortfolioSummary)();
}
