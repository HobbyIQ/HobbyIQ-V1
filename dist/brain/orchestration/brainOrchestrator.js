"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.brainOrchestrator = brainOrchestrator;
const cardDecisionHandler_1 = require("../handlers/cardDecisionHandler");
const cardOutcomeHandler_1 = require("../handlers/cardOutcomeHandler");
async function brainOrchestrator(payload) {
    // Run CompIQ + Decision
    const decision = await (0, cardDecisionHandler_1.cardDecisionHandler)(payload);
    // Run OutcomeIQ
    const outcome = await (0, cardOutcomeHandler_1.cardOutcomeHandler)(payload);
    // Market Impact Layer is already included in both
    return {
        decision,
        outcome
    };
}
