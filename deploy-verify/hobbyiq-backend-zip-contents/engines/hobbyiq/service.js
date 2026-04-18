"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runHobbyIQAnalysis = runHobbyIQAnalysis;
// Orchestration service for unified HobbyIQ analysis
const service_1 = require("../decision/service");
const service_2 = require("../selliq/service");
async function runHobbyIQAnalysis(input) {
    // 1. Run pricing engine (CompIQ)
    let pricingOutput = null;
    try {
        // pricingOutput = await runCompIQ(input.compData); // Placeholder
        pricingOutput = { fmv: 120, trend: 0.1, details: "Sample pricing output" };
    }
    catch (e) {
        pricingOutput = { error: "Pricing unavailable" };
    }
    // 2. Run negative pressure engine
    let negativePressureOutput = null;
    try {
        // negativePressureOutput = await runNegativePressure(input);
        negativePressureOutput = { score: 18, details: "Sample negative pressure output" };
    }
    catch (e) {
        negativePressureOutput = { error: "Negative pressure unavailable" };
    }
    // 3. Run decision engine
    let decisionOutput = null;
    try {
        decisionOutput = (0, service_1.runDecisionEngine)({
            compIQ: pricingOutput?.fmv || 0,
            playerIQ: input.playerScoreData?.playerIQ || 50,
            dailyIQ: input.dailyPerformanceData?.dailyIQ || 50,
            supplyScore: input.supplyScarcityData?.supplyScore || 50,
            scarcityScore: input.supplyScarcityData?.scarcityScore || 50,
            liquidityScore: pricingOutput?.liquidityScore || 50,
            negativePressureScore: negativePressureOutput?.score || 0,
            pricingTrend: pricingOutput?.trend || 0
        });
    }
    catch (e) {
        decisionOutput = { error: "Decision engine unavailable" };
    }
    // 4. Run SellIQ
    let sellOutput = null;
    try {
        sellOutput = (0, service_2.runSellIQ)({
            currentFMV: pricingOutput?.fmv || 0,
            riskAdjustedFMV: pricingOutput?.fmv || 0,
            quickExitFMV: pricingOutput?.fmv ? pricingOutput.fmv * 0.9 : 0,
            compTrendPercent: (pricingOutput?.trend || 0) * 100,
            liquidityScore: pricingOutput?.liquidityScore || 50,
            activeListingCount: input.supplyScarcityData?.activeListingCount || 0,
            soldCountRecent: input.compData?.soldCountRecent || 0,
            cardTier: input.cardDetails?.tier || "mid",
            marketMomentumScore: input.compData?.marketMomentumScore || 0,
            urgencyScore: decisionOutput?.urgencyScore || 50,
            costBasis: input.costBasis,
            decisionRecommendation: decisionOutput?.recommendation,
            negativePressureScore: negativePressureOutput?.score || 0
        });
    }
    catch (e) {
        sellOutput = { error: "SellIQ unavailable" };
    }
    // 5. Build summary
    let summary = "";
    if (decisionOutput?.recommendation) {
        summary = `Recommended action: ${decisionOutput.recommendation.toUpperCase()}. Sell signal: ${sellOutput?.sellSignal || "-"}.`;
    }
    else {
        summary = "Analysis incomplete. Some modules unavailable.";
    }
    return {
        pricingOutput,
        negativePressureOutput,
        decisionOutput,
        sellOutput,
        summary
    };
}
