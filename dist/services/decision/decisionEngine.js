"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeDecision = makeDecision;
function makeDecision({ payload, weighted, trends, supply, liquidityScore, absorptionRate, playerSignal, newsSignal, confidence, parallelInfo, comps, volatility, velocity, liquidityTier, usedInterpolation, marketImpact }) {
    const recommendation = weighted.estimatedValue > payload.askingPrice ? 'BUY' : 'HOLD';
    const urgency = trends.trendDirection === 'up' ? 'medium' : 'low';
    const riskLevel = 'moderate';
    const summary = {
        title: `${payload.year} ${payload.cardSet} ${payload.parallel} ${payload.isAuto ? 'Auto' : ''} ${payload.serial ? '/' + payload.serial : ''}`.trim(),
        player: payload.player,
        recommendation,
        confidence,
        currentEstimatedValue: weighted.estimatedValue,
        priceRangeLow: weighted.priceRangeLow,
        priceRangeHigh: weighted.priceRangeHigh,
        trendDirection: trends.trendDirection,
        trendStrength: trends.trendStrength,
        urgency,
        marketImpact: marketImpact ?? null,
    };
    const zones = {
        buyZoneLow: weighted.priceRangeLow - 10,
        buyZoneHigh: weighted.estimatedValue,
        holdZoneLow: weighted.estimatedValue + 1,
        holdZoneHigh: weighted.priceRangeHigh + 40,
        sellZoneAbove: weighted.priceRangeHigh + 41,
    };
    const insights = {
        ...supply,
        playerSignal: playerSignal.playerSignal,
        newsSignal: newsSignal.newsSignal,
        riskLevel,
    };
    const reasoning = [
        trends.trendDirection === 'up' ? 'Recent comps are trending upward' : 'Recent comps are flat or down',
        supply.supplyTrend2W < 0 ? 'Supply has tightened over the last 2 weeks' : 'Supply is stable',
        playerSignal.playerSignal === 'positive' && newsSignal.newsSignal === 'positive' ? 'Player/news signals are supportive' : 'Player/news signals are neutral or negative',
        marketImpact ? `Recent market impact: ${marketImpact.overallDirection} (${marketImpact.pricePressure}, score ${marketImpact.overallScore})` : 'No recent market impact signals',
    ];
    const recentComps = comps.slice(-1).map((c) => ({
        date: c.date,
        price: c.price,
        grade: c.grade,
        source: c.source || 'eBay',
        notes: c.notes || 'clean comp',
    }));
    const marketLadder = [
        { parallel: 'Base Auto', estimatedValue: 110 },
        { parallel: 'Refractor /499', estimatedValue: 165 },
        { parallel: 'Purple /250', estimatedValue: 210 },
        { parallel: 'Gold Shimmer /50', estimatedValue: weighted.estimatedValue },
    ];
    const dataQuality = {
        compCount: comps.length,
        confidenceNotes: confidence > 70 ? 'Confidence higher because recent comps and supply data both available' : 'Confidence moderate due to limited data',
    };
    return {
        success: true,
        summary,
        zones,
        insights,
        marketImpact: marketImpact ?? null,
        reasoning,
        recentComps,
        marketLadder,
        dataQuality,
    };
}
