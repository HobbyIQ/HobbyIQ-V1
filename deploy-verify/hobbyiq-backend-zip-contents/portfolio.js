"use strict";
// portfolio.ts - Pure TypeScript module for portfolio evaluation
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluatePortfolio = evaluatePortfolio;
function evaluatePortfolio(cards, compResultsMap) {
    const results = cards.map(card => {
        // Key: player+parallel (case-insensitive, trimmed)
        const key = (card.player + "|" + card.parallel).toLowerCase().trim();
        const comp = compResultsMap[key];
        let currentValue = null;
        let riskLevel = null;
        if (comp && comp.estimates) {
            const est = comp.estimates[card.parallel?.toLowerCase() || ""] || comp.estimates["base"];
            if (est) {
                if (card.grade.toLowerCase() === "psa 10" && est.psa10)
                    currentValue = est.psa10;
                else if (card.grade.toLowerCase() === "psa 9" && est.psa9)
                    currentValue = est.psa9;
                else if (est.raw)
                    currentValue = est.raw;
            }
        }
        if (comp && comp.risk)
            riskLevel = comp.risk.level;
        let profitLoss = null;
        let roi = null;
        if (currentValue !== null && card.purchasePrice > 0) {
            profitLoss = currentValue - card.purchasePrice;
            roi = Math.round((profitLoss / card.purchasePrice) * 100);
        }
        // Decision logic
        let decision = "HOLD";
        let alert = undefined;
        if (roi !== null && riskLevel) {
            // SELL ALERT: ROI > 25%
            if (roi > 25)
                alert = "SELL ALERT";
            // PANIC ALERT: risk HIGH + price drop
            if (riskLevel === "HIGH" && roi !== null && roi < -10)
                alert = "PANIC ALERT";
            // BUY ALERT: undervalued + LOW risk
            if (roi !== null && roi < -10 && riskLevel === "LOW")
                alert = "BUY ALERT";
            // Decision
            if (roi > 20 && riskLevel !== "LOW")
                decision = "SELL";
            else if (roi < -10 && riskLevel === "LOW")
                decision = "BUY_MORE";
            else if (roi > -10 && roi <= 20)
                decision = "HOLD";
        }
        return {
            player: card.player,
            parallel: card.parallel,
            grade: card.grade,
            purchasePrice: card.purchasePrice,
            currentValue,
            roi,
            decision,
            riskLevel,
            alert
        };
    });
    // Sort by highest ROI first (nulls last)
    results.sort((a, b) => {
        if (a.roi === null && b.roi === null)
            return 0;
        if (a.roi === null)
            return 1;
        if (b.roi === null)
            return -1;
        return b.roi - a.roi;
    });
    return results;
}
