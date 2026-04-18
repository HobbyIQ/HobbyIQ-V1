"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateConfidenceScore = generateConfidenceScore;
exports.getConfidenceLabel = getConfidenceLabel;
function generateConfidenceScore(parsed, rawPrice) {
    let score = 80;
    if (!parsed.player)
        score -= 30;
    if (!parsed.cardSet)
        score -= 20;
    if (!parsed.parallel)
        score -= 10;
    if (rawPrice < 20)
        score -= 10;
    if (parsed.isAuto)
        score += 5;
    return Math.max(0, Math.min(100, score));
}
function getConfidenceLabel(score) {
    if (score >= 85)
        return "High";
    if (score >= 65)
        return "Medium";
    return "Low";
}
