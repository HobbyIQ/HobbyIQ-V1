"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreConfidence = scoreConfidence;
function scoreConfidence(parsed, valuation) {
    let score = 100;
    if (parsed.warnings.length > 0)
        score -= 30;
    if (!valuation.rawPrice)
        score -= 40;
    if (parsed.parallel?.includes("gold"))
        score += 10;
    if (parsed.parallel?.includes("auto"))
        score -= 10;
    if (score > 100)
        score = 100;
    if (score < 0)
        score = 0;
    let label = "High";
    if (score < 80)
        label = "Medium";
    if (score < 50)
        label = "Low";
    return { score, label };
}
