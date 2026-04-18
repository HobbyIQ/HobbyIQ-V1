"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatCardDecisionViewModel = formatCardDecisionViewModel;
function getVerdictLabel(recommendation) {
    switch (recommendation) {
        case 'BUY': return 'Buy';
        case 'HOLD': return 'Hold';
        case 'SELL': return 'Sell';
        default: return 'Review';
    }
}
function getVerdictColor(recommendation) {
    switch (recommendation) {
        case 'BUY': return '#2ecc40';
        case 'HOLD': return '#f1c40f';
        case 'SELL': return '#e74c3c';
        default: return '#95a5a6';
    }
}
function getShortAdvice(recommendation, summary) {
    switch (recommendation) {
        case 'BUY': return `Consider buying at or below $${summary.currentEstimatedValue}.`;
        case 'HOLD': return `Hold for now; value is stable.`;
        case 'SELL': return `Consider selling above $${summary.priceRangeHigh}.`;
        default: return 'Review details.';
    }
}
function getRiskSummary(riskLevel) {
    switch (riskLevel) {
        case 'low': return 'Low risk: Market is stable.';
        case 'moderate': return 'Moderate risk: Some volatility.';
        case 'high': return 'High risk: Significant volatility.';
        default: return 'Risk unknown.';
    }
}
function formatZone(low, high) {
    if (low != null && high != null)
        return `$${low} - $${high}`;
    if (low != null)
        return `$${low}+`;
    if (high != null)
        return `Up to $${high}`;
    return 'N/A';
}
function formatCardDecisionViewModel(raw) {
    const summary = raw.summary || {};
    const zones = raw.zones || {};
    const insights = raw.insights || {};
    const reasoning = (raw.reasoning || []).map((r) => r.replace('comps', 'recent sales').replace('Player/news signals', 'Player and news signals'));
    const recentComps = raw.recentComps || [];
    const marketLadder = raw.marketLadder || [];
    const dataQuality = raw.dataQuality || {};
    const recommendation = summary.recommendation || 'REVIEW';
    const riskLevel = insights.riskLevel || 'moderate';
    return {
        summary: {
            ...summary,
            verdictLabel: getVerdictLabel(recommendation),
            verdictColor: getVerdictColor(recommendation),
            shortAdvice: getShortAdvice(recommendation, summary),
            riskSummary: getRiskSummary(riskLevel),
            finalFMV: raw.compiq?.finalFMV ?? summary.currentEstimatedValue ?? null,
            quickSellFloor: raw.compiq?.quickSellFloor ?? null,
            strongRetailValue: raw.compiq?.strongRetailValue ?? null,
            weightedMedian: raw.compiq?.weightedMedian ?? null,
            clusterCenter: raw.compiq?.clusterCenter ?? null,
            compCount: raw.compiq?.compCount ?? null,
            recentDirectCompCount: raw.compiq?.recentDirectCompCount ?? null,
            freshnessScore: raw.compiq?.freshnessScore ?? null,
            accelerationScore: raw.compiq?.accelerationScore ?? null,
            absorptionRate: raw.compiq?.absorptionRate ?? null,
            supplyPressure: raw.compiq?.supplyPressure ?? null,
            listingFloor: raw.compiq?.listingFloor ?? null,
            listingGap: raw.compiq?.listingGap ?? null,
            directWeight: raw.compiq?.directWeight ?? null,
            interpolationWeight: raw.compiq?.interpolationWeight ?? null,
            pricingMethod: raw.compiq?.pricingMethod ?? null,
            confidence: raw.compiq?.confidence ?? null,
            dataQualityNotes: raw.compiq?.dataQualityNotes ?? [],
        },
        zones: {
            ...zones,
            buyZoneDisplay: formatZone(zones.buyZoneLow, zones.buyZoneHigh),
            holdZoneDisplay: formatZone(zones.holdZoneLow, zones.holdZoneHigh),
            sellZoneDisplay: zones.sellZoneAbove != null ? `$${zones.sellZoneAbove}+` : 'N/A',
        },
        insights: {
            supplyTrend2W: insights.supplyTrend2W ?? null,
            supplyTrend4W: insights.supplyTrend4W ?? null,
            supplyTrend3M: insights.supplyTrend3M ?? null,
            activeSupply: insights.activeSupply ?? null,
            liquidityScore: insights.liquidityScore ?? null,
            absorptionRate: insights.absorptionRate ?? null,
            playerSignal: insights.playerSignal ?? 'neutral',
            newsSignal: insights.newsSignal ?? 'neutral',
            riskLevel: insights.riskLevel ?? 'moderate',
        },
        marketImpact: raw.marketImpact ?? null,
        marketContext: raw.compiq?.marketContext ?? null,
        reasoning: reasoning.length ? reasoning : ['No reasoning available.'],
        recentComps: recentComps.length ? recentComps : [],
        marketLadder: marketLadder.length ? marketLadder : [],
        dataQuality: {
            compCount: dataQuality.compCount ?? 0,
            confidenceNotes: dataQuality.confidenceNotes ?? '',
        },
    };
}
