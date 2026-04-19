"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateExplanation = generateExplanation;
function generateExplanation(parsed, confidenceScore) {
    let explanation = `Valuation based on detected details: `;
    if (parsed.player)
        explanation += `Player: ${parsed.player}. `;
    if (parsed.cardSet)
        explanation += `Set: ${parsed.cardSet}. `;
    if (parsed.parallel)
        explanation += `Parallel: ${parsed.parallel}. `;
    if (parsed.isAuto)
        explanation += `Auto detected. `;
    explanation += `Confidence: ${confidenceScore}%.`;
    return explanation;
}
