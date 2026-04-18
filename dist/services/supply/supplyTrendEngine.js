"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupplyTrends = getSupplyTrends;
exports.getLiquidity = getLiquidity;
function getSupplyTrends(payload) {
    return {
        supplyTrend2W: -14,
        supplyTrend4W: -20,
        supplyTrend3M: -8,
        activeSupply: 21,
    };
}
function getLiquidity(payload) {
    return 'moderate';
}
