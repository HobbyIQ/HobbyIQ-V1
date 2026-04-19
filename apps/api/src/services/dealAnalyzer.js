"use strict";
// src/services/dealAnalyzer.ts
// Pure logic for HobbyIQ Deal Analyzer
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeDeal = analyzeDeal;
function analyzeDeal(enteredPrice, compIQ) {
    const prices = compIQ.comps.map((c) => c.price).filter((p) => typeof p === "number" && !isNaN(p));
    if (!prices.length)
        throw new Error("No valid comps");
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const marketMedian = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
    const percentDifference = ((enteredPrice - marketMedian) / marketMedian) * 100;
    let verdict;
    if (enteredPrice < 0.8 * marketMedian)
        verdict = "STRONG_BUY";
    else if (enteredPrice < 0.9 * marketMedian)
        verdict = "BUY";
    else if (enteredPrice <= 1.1 * marketMedian)
        verdict = "FAIR";
    else
        verdict = "OVERPRICED";
    let recommendation = "";
    let confidence = 0.5;
    let riskLevel = "MEDIUM";
    switch (verdict) {
        case "STRONG_BUY":
            recommendation = "Excellent deal. Consider buying immediately.";
            confidence = 0.95;
            riskLevel = "LOW";
            break;
        case "BUY":
            recommendation = "Good deal. Worth buying.";
            confidence = 0.85;
            riskLevel = "LOW";
            break;
        case "FAIR":
            recommendation = "Fair price. Buy if you want the card.";
            confidence = 0.7;
            riskLevel = "MEDIUM";
            break;
        case "OVERPRICED":
            recommendation = "Overpriced. Consider negotiating or waiting.";
            confidence = 0.6;
            riskLevel = "HIGH";
            break;
    }
    // Adjust confidence based on comp count
    if (prices.length >= 8)
        confidence += 0.05;
    else if (prices.length <= 2)
        confidence -= 0.15;
    confidence = Math.max(0.1, Math.min(1, confidence));
    return {
        enteredPrice,
        marketMedian,
        percentDifference,
        verdict,
        recommendation,
        confidence,
        riskLevel
    };
}
