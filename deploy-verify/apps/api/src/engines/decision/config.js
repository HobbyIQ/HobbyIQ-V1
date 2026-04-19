"use strict";
// Config for Decision Engine scoring and thresholds
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIME_HORIZON_THRESHOLDS = exports.URGENCY_THRESHOLDS = exports.CONFIDENCE_THRESHOLDS = exports.RECOMMENDATION_THRESHOLDS = exports.SCORING_WEIGHTS = void 0;
exports.SCORING_WEIGHTS = {
    playerIQ: 0.3,
    dailyIQ: 0.2,
    compTrend: 0.2,
    supplyScarcity: 0.15,
    liquidity: 0.1,
    negativePressurePenalty: 1.0, // Multiplier for penalty
};
exports.RECOMMENDATION_THRESHOLDS = {
    strong_buy: 85,
    buy: 70,
    hold: 50,
    sell: 30,
    strong_sell: 0,
};
exports.CONFIDENCE_THRESHOLDS = {
    high: 80,
    medium: 60,
    low: 0,
};
exports.URGENCY_THRESHOLDS = {
    high: 80,
    medium: 50,
    low: 0,
};
exports.TIME_HORIZON_THRESHOLDS = {
    short: 80,
    medium: 50,
    long: 0,
};
