"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addHolding = addHolding;
exports.listHoldings = listHoldings;
exports.getHolding = getHolding;
exports.updateHolding = updateHolding;
exports.clearHoldings = clearHoldings;
const holdings = {};
function generateId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function addHolding(input) {
    const holdingId = generateId();
    const holding = {
        ...input,
        holdingId,
        estimatedUnitValue: null,
        estimatedTotalValue: null,
        gainLossAmount: null,
        gainLossPercent: null,
        statusFlag: "Monitor",
        confidence: 0,
        warnings: [],
        nextActions: [],
    };
    holdings[holdingId] = holding;
    return holding;
}
function listHoldings() {
    return Object.values(holdings);
}
function getHolding(holdingId) {
    return holdings[holdingId];
}
function updateHolding(holding) {
    holdings[holding.holdingId] = holding;
}
function clearHoldings() {
    Object.keys(holdings).forEach(id => delete holdings[id]);
}
