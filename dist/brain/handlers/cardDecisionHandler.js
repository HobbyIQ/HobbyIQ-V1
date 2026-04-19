"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardDecisionHandler = cardDecisionHandler;
const getComps_1 = require("../../services/compiq/getComps");
const normalizeCompData_1 = require("../../services/compiq/normalizeCompData");
const compSelectionEngine_1 = require("../../services/compiq/compSelectionEngine");
const recencyWeightEngine_1 = require("../../services/compiq/recencyWeightEngine");
const compQualityScorer_1 = require("../../services/compiq/compQualityScorer");
const outlierEngine_1 = require("../../services/compiq/outlierEngine");
const weightedFMVEngine_1 = require("../../services/compiq/weightedFMVEngine");
const freshnessEngine_1 = require("../../services/compiq/freshnessEngine");
const accelerationEngine_1 = require("../../engines/accelerationEngine");
const listingFloorEngine_1 = require("../../engines/listingFloorEngine");
const absorptionEngine_1 = require("../../engines/absorptionEngine");
const clusterEngine_1 = require("../../engines/clusterEngine");
const fmvBandsEngine_1 = require("../../services/compiq/fmvBandsEngine");
const trendAnalysisEngine_1 = require("../../services/compiq/trendAnalysisEngine");
const volatilityEngine_1 = require("../../services/compiq/volatilityEngine");
const velocityEngine_1 = require("../../services/compiq/velocityEngine");
const parallelInterpolationEngine_1 = require("../../services/compiq/parallelInterpolationEngine");
const parallelResolver_1 = require("../../services/compiq/parallelResolver");
const supplyTrendEngine_1 = require("../../services/supply/supplyTrendEngine");
const liquidityEngine_1 = require("../../services/supply/liquidityEngine");
const playerSignalEngine_1 = require("../../services/playeriq/playerSignalEngine");
const eventImpactEngine_1 = require("../../services/news/eventImpactEngine");
const decisionEngine_1 = require("../../services/decision/decisionEngine");
const performanceImpactEngine_1 = require("../../services/marketImpact/performanceImpactEngine");
const rankingImpactEngine_1 = require("../../services/marketImpact/rankingImpactEngine");
const awardsImpactEngine_1 = require("../../services/marketImpact/awardsImpactEngine");
const hobbyBuzzEngine_1 = require("../../services/marketImpact/hobbyBuzzEngine");
const marketImpactAggregator_1 = require("../../services/marketImpact/marketImpactAggregator");
const predictionLogger_1 = require("../../services/learning/predictionLogger");
const cardDecisionViewModel_1 = require("../formatters/cardDecisionViewModel");
async function cardDecisionHandler(payload) {
    // 1. Get comps
    const comps = await (0, getComps_1.getComps)(payload);
    const normalizedComps = (0, normalizeCompData_1.normalizeComps)(comps);
    // 2. Comp selection
    const { selected, liquidityTier, usedInterpolation } = (0, compSelectionEngine_1.selectComps)(normalizedComps);
    // 3. Outlier removal
    const filteredComps = (0, outlierEngine_1.filterOutliers)(selected);
    // 4. Recency & quality weights
    const now = Date.now();
    const compsWithWeights = filteredComps.map(c => {
        const daysSinceSale = Math.max(0, (now - new Date(c.date).getTime()) / (1000 * 60 * 60 * 24));
        const recency = (0, recencyWeightEngine_1.recencyWeight)(daysSinceSale);
        const quality = (0, compQualityScorer_1.compQualityScore)(c);
        return { ...c, recencyWeight: recency, qualityScore: quality, finalWeight: recency * quality };
    });
    // 5. Weighted FMV
    let { weightedFMV: fmv, priceRangeLow, priceRangeHigh } = (0, weightedFMVEngine_1.weightedFMV)(compsWithWeights);
    // 6. Trend analysis
    const { trendDirection, trendStrength } = (0, trendAnalysisEngine_1.trendAnalysis)(compsWithWeights);
    // 7. Volatility
    const { volatilityScore, classification: volatility } = (0, volatilityEngine_1.volatilityEngine)(compsWithWeights);
    // 8. Velocity
    const { velocityScore, classification: velocity } = (0, velocityEngine_1.velocityEngine)(compsWithWeights);
    // 9. Parallel interpolation if needed
    let interpolationUsed = usedInterpolation;
    let interpolationWeight = 0;
    let directWeight = 1;
    if (compsWithWeights.length < 5) {
        // Use parallel interpolation
        const parallelInfo = (0, parallelResolver_1.resolveParallel)(payload);
        // Mock: parallelCatalog should be injected or imported
        const parallelCatalog = {};
        const interp = (0, parallelInterpolationEngine_1.parallelInterpolation)(compsWithWeights, parallelCatalog, payload.parallel);
        if (interp.used && interp.estimatedValue > 0) {
            fmv = interp.estimatedValue;
            interpolationUsed = true;
            interpolationWeight = 0.5;
            directWeight = 0.5;
        }
    }
    // 10. Supply adjustment
    const supply = (0, supplyTrendEngine_1.getSupplyTrends)(payload);
    let supplyAdj = 1;
    // Use supplyTrend2W as the trend indicator
    if (supply && typeof supply.supplyTrend2W === 'number') {
        if (supply.supplyTrend2W < -15)
            supplyAdj = 1.1;
        else if (supply.supplyTrend2W > 15)
            supplyAdj = 0.9;
    }
    // 11. Listing floor analysis (mocked listings)
    const listings = payload.listings || [];
    const lastSale = compsWithWeights.length ? compsWithWeights[compsWithWeights.length - 1].price : fmv;
    const listingFloorResult = (0, listingFloorEngine_1.getListingFloorAnalysis)(listings, lastSale);
    // 12. Absorption analysis (mocked sold/new listings)
    const sold7d = payload.sold7d ?? compsWithWeights.length;
    const newListings7d = payload.newListings7d ?? listings.length;
    const absorptionResult = (0, absorptionEngine_1.getAbsorptionAnalysis)(listings, sold7d, newListings7d);
    // 13. Freshness
    const freshnessResult = (0, freshnessEngine_1.getFreshnessScore)(compsWithWeights);
    // 14. Acceleration
    const accelerationResult = (0, accelerationEngine_1.getAccelerationScore)(compsWithWeights);
    // 15. Cluster analysis
    const clusterResult = (0, clusterEngine_1.getClusterAnalysis)(compsWithWeights.map(c => c.price));
    // 16. FMV Bands
    const fmvBands = (0, fmvBandsEngine_1.getFMVBands)({
        comps: compsWithWeights,
        blendedFMV: fmv,
        listingFloor: typeof listingFloorResult.listingFloor === 'number' && listingFloorResult.listingFloor !== null
            ? listingFloorResult.listingFloor
            : fmv // fallback to fmv if null
    });
    // 17. Blended FMV (final adjustment)
    let blendedFMV = fmv;
    let pricingMethod = 'direct';
    let dataQualityNotes = [];
    // Freshness adjustment
    let freshnessAdjustment = freshnessResult.freshnessScore > 0.8 ? 1.05 : freshnessResult.freshnessScore < 0.4 ? 0.95 : 1.0;
    // Acceleration adjustment
    let accelerationAdjustment = accelerationResult.accelerationScore > 0.2 ? 1.05 : accelerationResult.accelerationScore < -0.2 ? 0.95 : 1.0;
    // Supply adjustment
    let supplyAdjustment = absorptionResult.supplyPressure === 'tightening' ? 1.05 : absorptionResult.supplyPressure === 'expanding' ? 0.95 : 1.0;
    // Listing floor adjustment
    let listingFloorAdjustment = (listingFloorResult.marketResetSignal ? 1.1 : 1.0);
    // Clamp all adjustments
    freshnessAdjustment = Math.max(0.9, Math.min(1.2, freshnessAdjustment));
    accelerationAdjustment = Math.max(0.9, Math.min(1.2, accelerationAdjustment));
    supplyAdjustment = Math.max(0.9, Math.min(1.2, supplyAdjustment));
    listingFloorAdjustment = Math.max(0.9, Math.min(1.2, listingFloorAdjustment));
    // Compose
    blendedFMV = Math.round(fmv * freshnessAdjustment * accelerationAdjustment * supplyAdjustment * listingFloorAdjustment);
    pricingMethod = interpolationUsed ? 'interpolated' : 'direct';
    dataQualityNotes.push(...freshnessResult.notes, ...accelerationResult.notes, ...absorptionResult.notes, ...listingFloorResult.notes);
    // 18. Price bands
    const quickSellFloor = fmvBands.quickSellFloor;
    const fairMarketValue = fmvBands.fairMarketValue;
    const strongRetailValue = fmvBands.strongRetailValue;
    // 19. Confidence (upgraded)
    const compCountScore = Math.min(1, compsWithWeights.length / 12);
    const recencyScore = compsWithWeights.length ? compsWithWeights.reduce((sum, c) => sum + c.recencyWeight, 0) / compsWithWeights.length : 0;
    const varianceScore = volatilityScore ? 1 - Math.min(1, volatilityScore / (fmv || 1)) : 1;
    const absorptionScore = absorptionResult.liquidityScore ?? 0;
    const listingAlignmentScore = listingFloorResult.listingFloor && Math.abs(listingFloorResult.listingFloor - blendedFMV) < 0.1 * blendedFMV ? 1 : 0.7;
    const interpolationConfidence = interpolationUsed ? 0.7 : 1;
    const confidence = Math.round(((compCountScore * 0.2) + (freshnessResult.freshnessScore * 0.2) + (varianceScore * 0.15) + (absorptionScore * 0.15) + (listingAlignmentScore * 0.15) + (interpolationConfidence * 0.15)) * 100);
    // 20. Compose CompIQ output
    const compiqOutput = {
        finalFMV: blendedFMV,
        priceRangeLow: priceRangeLow,
        priceRangeHigh: priceRangeHigh,
        quickSellFloor,
        strongRetailValue,
        weightedMedian: clusterResult.weightedMedian,
        clusterCenter: clusterResult.clusterCenter,
        compCount: compsWithWeights.length,
        recentDirectCompCount: compsWithWeights.length,
        freshnessScore: freshnessResult.freshnessScore,
        accelerationScore: accelerationResult.accelerationScore,
        absorptionRate: absorptionResult.absorptionRate,
        supplyPressure: absorptionResult.supplyPressure,
        listingFloor: listingFloorResult.listingFloor,
        listingGap: listingFloorResult.listingGap,
        directWeight,
        interpolationWeight,
        pricingMethod,
        confidence,
        dataQualityNotes,
        marketContext: {
            freshness: freshnessResult.freshnessTier,
            acceleration: accelerationResult.accelerationDirection,
            supplyPressure: absorptionResult.supplyPressure,
            listingSignal: listingFloorResult.marketResetSignal ? 'upward reset' : (listingFloorResult.listingFloor != null ? 'normal' : 'unknown')
        }
    };
    // 21. Logging
    (0, predictionLogger_1.logPrediction)({
        finalFMV: blendedFMV,
        quickSellFloor,
        strongRetailValue,
        freshnessScore: freshnessResult.freshnessScore,
        accelerationScore: accelerationResult.accelerationScore,
        absorptionRate: absorptionResult.absorptionRate,
        listingFloor: listingFloorResult.listingFloor,
        pricingMethod,
        confidence,
        timestamp: new Date().toISOString(),
    });
    // 12. Parallel info
    const parallelInfo = (0, parallelResolver_1.resolveParallel)(payload);
    // 13. Player & News
    const liquidityScore = (0, liquidityEngine_1.getLiquidityScore)(payload);
    const absorptionRate = (0, liquidityEngine_1.getAbsorptionRate)(payload);
    const playerSignal = (0, playerSignalEngine_1.getPlayerSignal)(payload);
    const newsSignal = (0, eventImpactEngine_1.getNewsSignal)(payload);
    // 13b. Market Impact Layer (mocked inputs for now)
    const perfImpact = (0, performanceImpactEngine_1.getPerformanceImpact)(payload.stats || null);
    const rankingImpact = (0, rankingImpactEngine_1.getRankingImpact)(payload.rankingData || null);
    const awardsImpact = (0, awardsImpactEngine_1.getAwardsImpact)(payload.awardsData || null);
    const hobbyBuzzImpact = (0, hobbyBuzzEngine_1.getHobbyBuzzImpact)(payload.hobbyBuzzData || null);
    const marketImpact = (0, marketImpactAggregator_1.aggregateMarketImpact)([
        perfImpact,
        rankingImpact,
        awardsImpact,
        hobbyBuzzImpact
    ]);
    // 14. Decision (pass CompIQ output)
    const decision = (0, decisionEngine_1.makeDecision)({
        payload,
        weighted: {
            estimatedValue: blendedFMV,
            priceRangeLow,
            priceRangeHigh,
            quickSellFloor,
            strongRetailValue,
            weightedMedian: clusterResult.weightedMedian,
            clusterCenter: clusterResult.clusterCenter
        },
        trends: { trendDirection, trendStrength },
        supply,
        liquidityScore: absorptionResult.liquidityScore,
        absorptionRate: absorptionResult.absorptionRate,
        playerSignal,
        newsSignal,
        confidence,
        parallelInfo,
        comps: compsWithWeights,
        volatility,
        velocity,
        liquidityTier,
        usedInterpolation: interpolationUsed,
        marketImpact,
        marketContext: compiqOutput.marketContext,
        dataQualityNotes: compiqOutput.dataQualityNotes
    });
    // 16. Format for frontend
    return (0, cardDecisionViewModel_1.formatCardDecisionViewModel)({ ...decision, compiq: compiqOutput });
}
