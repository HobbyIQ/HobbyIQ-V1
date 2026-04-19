"use strict";
// Config for SellIQ pricing and strategy rules
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPRICING_PLANS = exports.NEG_PRESSURE_PENALTY = exports.MOMENTUM_BONUS = exports.URGENCY_THRESHOLDS = exports.LIQUIDITY_FLOOR_THRESHOLDS = void 0;
exports.LIQUIDITY_FLOOR_THRESHOLDS = {
    low: 0.92, // Use 92% of riskAdjustedFMV if liquidity is low
    normal: 0.97 // Use 97% of riskAdjustedFMV if liquidity is normal/high
};
exports.URGENCY_THRESHOLDS = {
    high: 70,
    low: 30
};
exports.MOMENTUM_BONUS = 0.05; // 5% bonus to list price if momentum is strong
exports.NEG_PRESSURE_PENALTY = 0.95; // 5% penalty to list price if negative pressure is high
exports.REPRICING_PLANS = {
    default: 'Review price every 7 days; reduce by 5% if unsold.',
    aggressive: 'Reduce price by 10% every 3 days until sold.',
    patient: 'Hold price steady for 10 days, then review.'
};
