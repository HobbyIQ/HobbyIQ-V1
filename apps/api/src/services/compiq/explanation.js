"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExplanation = buildExplanation;
function buildExplanation(parsed, valuation, confidence) {
    const parts = [];
    if (parsed.player && parsed.cardSet && parsed.parallel) {
        parts.push(`Estimated value for ${parsed.player} ${parsed.cardSet} ${parsed.parallel}`);
    }
    else {
        parts.push("Could not fully parse card details.");
    }
    if (valuation.rawPrice) {
        parts.push(`Raw: $${valuation.rawPrice}`);
        parts.push(`PSA 9: $${valuation.estimatedPsa9}`);
        parts.push(`PSA 10: $${valuation.estimatedPsa10}`);
    }
    else {
        parts.push("No comps found for valuation.");
    }
    parts.push(`Confidence: ${confidence.label} (${confidence.score}%)`);
    if (parsed.warnings.length) {
        parts.push("Warnings: " + parsed.warnings.join(", "));
    }
    return parts.join("\n");
}
