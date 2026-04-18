"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decisionConfig = void 0;
exports.decisionConfig = {
    methodologyVersion: process.env.DECISION_METHODOLOGY_VERSION || "v1",
    strongBuyScoreThreshold: Number(process.env.DECISION_STRONG_BUY_THRESHOLD ?? 85),
    buyScoreThreshold: Number(process.env.DECISION_BUY_THRESHOLD ?? 70),
    holdScoreThreshold: Number(process.env.DECISION_HOLD_THRESHOLD ?? 50),
    trimScoreThreshold: Number(process.env.DECISION_TRIM_THRESHOLD ?? 35),
    sellScoreThreshold: Number(process.env.DECISION_SELL_THRESHOLD ?? 20),
    strongSellScoreThreshold: Number(process.env.DECISION_STRONG_SELL_THRESHOLD ?? 10),
    urgencySpikeThreshold: Number(process.env.DECISION_URGENCY_SPIKE_THRESHOLD ?? 80),
    riskPenaltyWeight: Number(process.env.DECISION_RISK_PENALTY_WEIGHT ?? 1.0),
    catalystBoostWeight: Number(process.env.DECISION_CATALYST_BOOST_WEIGHT ?? 1.0),
    liquidityPenaltyWeight: Number(process.env.DECISION_LIQUIDITY_PENALTY_WEIGHT ?? 1.0),
    portfolioExposurePenaltyWeight: Number(process.env.DECISION_PORTFOLIO_EXPOSURE_PENALTY_WEIGHT ?? 1.0),
};
