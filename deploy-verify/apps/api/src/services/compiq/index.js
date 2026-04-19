"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCompIQ = runCompIQ;
const parse_1 = require("./parse");
const valuation_1 = require("./valuation");
const confidence_1 = require("./confidence");
const explanation_1 = require("./explanation");
async function runCompIQ(input) {
    const parsed = (0, parse_1.parseCompIQInput)(input);
    const valuation = (0, valuation_1.estimateCardValues)(parsed);
    const confidence = (0, confidence_1.scoreConfidence)(parsed, valuation);
    const explanation = (0, explanation_1.buildExplanation)(parsed, valuation, confidence);
    // Next actions logic
    const nextActions = [];
    if (!parsed.player || !parsed.cardSet)
        nextActions.push("Refine your search with more details");
    else
        nextActions.push("View comps", "Estimate grading ROI");
    return {
        success: true,
        player: parsed.player,
        cardSet: parsed.cardSet,
        productFamily: parsed.productFamily,
        parallel: parsed.parallel,
        normalizedParallel: parsed.normalizedParallel,
        isAuto: parsed.isAuto,
        cardType: parsed.cardType,
        rawPrice: valuation.rawPrice,
        adjustedRaw: valuation.adjustedRaw,
        estimatedPsa9: valuation.estimatedPsa9,
        estimatedPsa10: valuation.estimatedPsa10,
        confidenceScore: confidence.score,
        confidenceLabel: confidence.label,
        explanation,
        warnings: [...parsed.warnings, ...valuation.warnings],
        nextActions,
    };
}
