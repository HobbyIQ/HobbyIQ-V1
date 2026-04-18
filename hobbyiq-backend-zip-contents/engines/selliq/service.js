"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSellIQ = runSellIQ;
const config_1 = require("./config");
function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}
function getLiquidityFloor(riskAdjustedFMV, liquidityScore) {
    return liquidityScore < 40
        ? riskAdjustedFMV * config_1.LIQUIDITY_FLOOR_THRESHOLDS.low
        : riskAdjustedFMV * config_1.LIQUIDITY_FLOOR_THRESHOLDS.normal;
}
function getAuctionVsBIN(urgencyScore, activeListingCount, compTrendPercent, marketMomentumScore) {
    if (urgencyScore > config_1.URGENCY_THRESHOLDS.high || activeListingCount > 20 || compTrendPercent < -10) {
        return "auction";
    }
    if (marketMomentumScore > 20 && compTrendPercent > 5) {
        return "bin";
    }
    return "either";
}
function getExpectedStrategy(auctionVsBIN, urgencyScore, marketMomentumScore) {
    if (auctionVsBIN === "auction")
        return "Aggressive auction for quick exit.";
    if (auctionVsBIN === "bin" && urgencyScore < 40 && marketMomentumScore > 10)
        return "Patient BIN listing with periodic review.";
    return "Flexible approach: start BIN, switch to auction if unsold.";
}
function runSellIQ(input) {
    const { currentFMV, riskAdjustedFMV, quickExitFMV, compTrendPercent, liquidityScore, activeListingCount, soldCountRecent, cardTier, marketMomentumScore, urgencyScore, costBasis, decisionRecommendation, negativePressureScore } = input;
    let adjustedUrgency = urgencyScore;
    let reasoning = [];
    // Decision Engine integration
    if (decisionRecommendation === "strong_buy" || decisionRecommendation === "buy") {
        adjustedUrgency = Math.max(adjustedUrgency - 25, 0);
        reasoning.push("Strong buy/buy signal: urgency to sell is reduced, favoring patient BIN pricing.");
    }
    else if (decisionRecommendation === "hold") {
        adjustedUrgency = Math.max(adjustedUrgency - 10, 0);
        reasoning.push("Hold signal: favor patient pricing and controlled repricing.");
    }
    else if (decisionRecommendation === "sell" || decisionRecommendation === "strong_sell") {
        adjustedUrgency = Math.min(adjustedUrgency + 25, 100);
        reasoning.push("Sell/strong sell signal: urgency increased, favoring quick-exit recommendations.");
    }
    // Negative pressure
    if (negativePressureScore && negativePressureScore > 20) {
        adjustedUrgency = Math.min(adjustedUrgency + 15, 100);
        reasoning.push("Elevated negative pressure: urgency increased, minimum acceptable offer lowered.");
    }
    // Pricing logic
    const liquidityFloor = getLiquidityFloor(riskAdjustedFMV, liquidityScore);
    let listPriceRecommendation = currentFMV;
    let minAcceptableOffer = liquidityFloor;
    let quickSalePrice = quickExitFMV;
    // Strong momentum supports more aggressive list pricing
    if (marketMomentumScore > 20 && (negativePressureScore ?? 0) < 10) {
        listPriceRecommendation = currentFMV * (1 + config_1.MOMENTUM_BONUS);
        reasoning.push("Strong market momentum: more aggressive list price recommended.");
    }
    // Heavy supply plus weak trend pushes auction or faster repricing
    if ((activeListingCount > 20 && compTrendPercent < 0) || compTrendPercent < -10) {
        listPriceRecommendation = quickExitFMV;
        reasoning.push("Heavy supply and weak trend: auction or faster repricing advised.");
    }
    // Profitability awareness
    if (costBasis !== undefined) {
        if (costBasis < minAcceptableOffer) {
            reasoning.push(`Profit expected: cost basis ($${costBasis}) is below minimum acceptable offer.`);
        }
        else if (costBasis > minAcceptableOffer) {
            minAcceptableOffer = costBasis;
            reasoning.push(`Break-even required: cost basis ($${costBasis}) sets the minimum offer.`);
        }
        else {
            reasoning.push(`Cost basis matches minimum acceptable offer.`);
        }
    }
    // Sell signal logic
    let sellSignal = "wait";
    if (adjustedUrgency > 70 || (activeListingCount > 20 && compTrendPercent < 0)) {
        sellSignal = "sell_now";
    }
    else if (adjustedUrgency > 50) {
        sellSignal = "reduce_price";
    }
    // Auction vs BIN
    const auctionVsBIN = getAuctionVsBIN(adjustedUrgency, activeListingCount, compTrendPercent, marketMomentumScore);
    // Repricing plan
    let repricingPlan = config_1.REPRICING_PLANS.default;
    if (sellSignal === "sell_now")
        repricingPlan = config_1.REPRICING_PLANS.aggressive;
    else if (auctionVsBIN === "bin" && adjustedUrgency < 40)
        repricingPlan = config_1.REPRICING_PLANS.patient;
    // Time to exit
    let timeToExitRecommendation = "2-4 weeks expected.";
    if (sellSignal === "sell_now")
        timeToExitRecommendation = "Target exit within 7 days.";
    else if (adjustedUrgency < 30)
        timeToExitRecommendation = "No rush; exit over 1-2 months is fine.";
    // Confidence
    let sellConfidence = clamp(80 - adjustedUrgency / 2 + liquidityScore / 3, 0, 100);
    // Expected strategy
    const expectedStrategy = getExpectedStrategy(auctionVsBIN, adjustedUrgency, marketMomentumScore);
    // Final reasoning
    reasoning.push(`List price: $${Math.round(listPriceRecommendation)}. Quick sale: $${Math.round(quickSalePrice)}. Minimum offer: $${Math.round(minAcceptableOffer)}.`);
    reasoning.push(`Recommended sale method: ${auctionVsBIN.toUpperCase()}. Strategy: ${expectedStrategy}`);
    reasoning.push(`Repricing plan: ${repricingPlan}`);
    reasoning.push(`Expected time to exit: ${timeToExitRecommendation}`);
    return {
        sellSignal,
        sellConfidence: Math.round(sellConfidence),
        listPriceRecommendation: Math.round(listPriceRecommendation),
        minimumAcceptableOffer: Math.round(minAcceptableOffer),
        quickSalePrice: Math.round(quickSalePrice),
        auctionVsBINRecommendation: auctionVsBIN,
        repricingPlan,
        timeToExitRecommendation,
        expectedStrategy,
        reasoning
    };
}
