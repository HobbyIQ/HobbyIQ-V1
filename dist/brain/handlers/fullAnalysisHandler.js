"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFullAnalysis = runFullAnalysis;
const cardDecisionHandler_1 = require("./cardDecisionHandler");
const cardOutcomeHandler_1 = require("./cardOutcomeHandler");
function extractCompIQ(decision) {
    return decision?.summary?.finalFMV ?? decision?.summary?.currentEstimatedValue ?? null;
}
async function runFullAnalysis(input) {
    console.log('[FullAnalysis] Incoming request:', JSON.stringify(input));
    let decision = null;
    let outcome = null;
    let compFMV = null;
    try {
        decision = await (0, cardDecisionHandler_1.cardDecisionHandler)(input);
        compFMV = extractCompIQ(decision);
    }
    catch (err) {
        console.error('[FullAnalysis] Decision engine error:', err);
        decision = null;
        compFMV = null;
    }
    try {
        const outcomeInput = { ...input, currentEstimatedValue: compFMV };
        outcome = await (0, cardOutcomeHandler_1.cardOutcomeHandler)(outcomeInput);
    }
    catch (err) {
        console.error('[FullAnalysis] Outcome engine error:', err);
        outcome = null;
    }
    const result = {
        summary: decision?.summary ?? {},
        zones: decision?.zones ?? {},
        reasoning: Array.isArray(decision?.reasoning) ? decision.reasoning : [],
        insights: decision?.insights ?? {},
        recentComps: Array.isArray(decision?.recentComps) ? decision.recentComps : [],
        marketLadder: Array.isArray(decision?.marketLadder) ? decision.marketLadder : [],
        outcome: Array.isArray(outcome?.scenarios) ? outcome.scenarios : [],
    };
    console.log('[FullAnalysis] Final response:', JSON.stringify(result));
    return result;
}
