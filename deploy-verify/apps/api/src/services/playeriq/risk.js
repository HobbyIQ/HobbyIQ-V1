"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRiskBand = getRiskBand;
function getRiskBand(scores) {
    // Example: lower overall = higher risk
    let riskScore = 100 - scores.overall;
    let riskLabel = "Low";
    if (riskScore > 40)
        riskLabel = "High";
    else if (riskScore > 20)
        riskLabel = "Medium";
    return { riskScore, riskLabel };
}
