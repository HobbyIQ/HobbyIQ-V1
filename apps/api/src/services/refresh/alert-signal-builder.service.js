"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertSignalBuilderService = void 0;
const crypto_1 = require("crypto");
class AlertSignalBuilderService {
    build(entityType, entityKey, diff) {
        const signals = [];
        const now = new Date().toISOString();
        if ("actionPlanJson" in diff) {
            signals.push({
                signalId: (0, crypto_1.randomUUID)(),
                entityType,
                entityKey,
                signalType: "recommendation_upgraded",
                importanceScore: 7,
                summary: "Action plan changed materially.",
                payloadJson: diff,
                createdAt: now,
            });
        }
        if ("marketTemperatureJson" in diff) {
            signals.push({
                signalId: (0, crypto_1.randomUUID)(),
                entityType,
                entityKey,
                signalType: "market_overheated",
                importanceScore: 6,
                summary: "Market temperature changed.",
                payloadJson: diff,
                createdAt: now,
            });
        }
        if ("pricingBandsJson" in diff) {
            signals.push({
                signalId: (0, crypto_1.randomUUID)(),
                entityType,
                entityKey,
                signalType: "entered_buy_zone",
                importanceScore: 8,
                summary: "Pricing bands changed enough to re-check buy zone.",
                payloadJson: diff,
                createdAt: now,
            });
        }
        return signals;
    }
}
exports.AlertSignalBuilderService = AlertSignalBuilderService;
