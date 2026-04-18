"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCompIQLiveEstimate = handleCompIQLiveEstimate;
const validation_1 = require("../../shared/validation");
const parallels_1 = require("../../shared/parallels");
const confidence_1 = require("../../shared/confidence");
const explanation_1 = require("../../shared/explanation");
const ebaySupply_1 = require("../../shared/ebaySupply");
const pricingZone_1 = require("../../services/marketIntel/pricingZone");
const supplyDemandTrend_1 = require("../../services/marketIntel/supplyDemandTrend");
const marketLadder_1 = require("../../services/marketIntel/marketLadder");
const buyOpportunity_1 = require("../../services/marketIntel/buyOpportunity");
const thesisEngine_1 = require("../../services/marketIntel/decision/thesisEngine");
const riskAssessment_1 = require("../../services/marketIntel/decision/riskAssessment");
const entryExitPlan_1 = require("../../services/marketIntel/decision/entryExitPlan");
const compQuality_1 = require("../../services/marketIntel/decision/compQuality");
const timeHorizon_1 = require("../../services/marketIntel/decision/timeHorizon");
const liquidityAnalysis_1 = require("../../services/marketIntel/decision/liquidityAnalysis");
const marketTemperature_1 = require("../../services/marketIntel/decision/marketTemperature");
const guardrails_1 = require("../../services/marketIntel/decision/guardrails");
const listingQuality_1 = require("../../services/marketIntel/decision/listingQuality");
const actionPlan_1 = require("../../services/marketIntel/decision/actionPlan");
async function handleCompIQLiveEstimate(input) {
    (0, validation_1.validateCompIQRequest)(input);
    // parseCardQuery is not available; use input.query directly or provide a stub
    const parsed = { player: '', cardSet: '', parallel: '', isAuto: false, productFamily: '' };
    const parallelMultiplier = (0, parallels_1.getParallelMultiplier)(parsed.parallel);
    const normalizedParallel = (0, parallels_1.normalizeParallel)(parsed.parallel);
    // Simulate price logic (replace with real data source)
    const basePrice = 100; // fallback base price
    const rawPrice = basePrice * parallelMultiplier;
    const adjustedRaw = rawPrice * (parsed.isAuto ? 1.2 : 1);
    const estimatedPsa9 = adjustedRaw * 1.5;
    const estimatedPsa10 = adjustedRaw * 2.2;
    const confidenceScore = (0, confidence_1.generateConfidenceScore)(parsed, rawPrice);
    const confidenceLabel = (0, confidence_1.getConfidenceLabel)(confidenceScore);
    const explanation = (0, explanation_1.generateExplanation)(parsed, confidenceScore);
    const warnings = [];
    if (!parsed.player)
        warnings.push("Player not detected");
    if (!parsed.cardSet)
        warnings.push("Set not detected");
    const nextActions = ["Verify card details", "Check recent sales"];
    // eBay supply intelligence for this card/parallel
    const ebaySupply = await (0, ebaySupply_1.getEbaySupplySnapshot)(parsed.player, parsed.cardSet, parsed.parallel);
    // Compose calculation context for market intelligence
    const calcContext = {
        weightedMedian: rawPrice,
        weightedAverage: rawPrice,
        compCount: 5,
        minComp: rawPrice * 0.9,
        maxComp: rawPrice * 1.1,
        liquidityScore: 0.7,
        confidenceScore,
        marketTrend: "flat",
        listings: [
            { title: "Sample Comp 1", price: rawPrice * 0.95, url: "#" },
            { title: "Sample Comp 2", price: rawPrice * 1.05, url: "#" }
        ],
        priceBands: {
            quickExitPrice: rawPrice * 0.9,
            fairMarketValue: rawPrice,
            buyZoneLow: rawPrice * 0.85,
            buyZoneHigh: rawPrice * 0.97,
            holdZoneLow: rawPrice * 0.97,
            holdZoneHigh: rawPrice * 1.07,
            sellZoneLow: rawPrice * 1.07,
            sellZoneHigh: rawPrice * 1.18,
            stretchAsk: rawPrice * 1.25
        },
        cardKey: `${parsed.player || "unknown"}-${parsed.cardSet || "unknown"}-${parsed.parallel || "base"}`
    };
    // Compute market intelligence
    const pricingBands = (0, pricingZone_1.computePriceBands)(calcContext);
    const supplyDemandTrends = (0, supplyDemandTrend_1.computeSupplyDemandTrends)(calcContext);
    const marketLadder = (0, marketLadder_1.buildMarketLadder)(calcContext);
    const goodBuys = (0, buyOpportunity_1.findBuyOpportunities)({ ...calcContext, priceBands: pricingBands });
    const recentComps = [
        {
            date: new Date().toISOString(),
            title: "Sample Comp 1",
            price: rawPrice * 0.95,
            grade: "Raw",
            source: "eBay",
            listingType: "auction",
            acceptedOfferKnown: false,
            weight: 1,
            normalized: true
        },
        {
            date: new Date().toISOString(),
            title: "Sample Comp 2",
            price: rawPrice * 1.05,
            grade: "Raw",
            source: "eBay",
            listingType: "bin",
            acceptedOfferKnown: false,
            weight: 1,
            normalized: true
        }
    ];
    const calculation = {
        weightedMedian: rawPrice,
        weightedAverage: rawPrice,
        compCount: 5,
        minComp: rawPrice * 0.9,
        maxComp: rawPrice * 1.1,
        methodologyNotes: ["Demo calculation. Replace with real comp logic."]
    };
    const marketSignals = {
        liquidityScore: 0.7,
        confidenceScore,
        marketTrend: "flat",
        supplyTrend2Weeks: "flat",
        supplyTrend4Weeks: "flat",
        supplyTrend3Months: "flat",
        demandTrend2Weeks: "flat",
        demandTrend4Weeks: "flat",
        demandTrend3Months: "flat",
        explanation: ["Demo signals. Replace with real logic."]
    };
    // Advanced decision intelligence extension
    const decisionExtension = {
        aiThesis: (0, thesisEngine_1.generateAiThesis)(calcContext),
        riskPanel: (0, riskAssessment_1.assessRisks)(calcContext),
        entryExitPlan: (0, entryExitPlan_1.buildEntryExitPlan)({ ...calcContext, priceBands: pricingBands }),
        compQuality: (0, compQuality_1.gradeCompQuality)(calcContext),
        timeHorizonViews: (0, timeHorizon_1.buildTimeHorizonViews)({ ...calcContext, priceBands: pricingBands }),
        liquidityProfile: (0, liquidityAnalysis_1.buildLiquidityProfile)(calcContext),
        liquidityLadder: (0, liquidityAnalysis_1.buildLiquidityLadder)(calcContext),
        marketTemperature: (0, marketTemperature_1.classifyMarketTemperature)(calcContext),
        guardrailFlags: (0, guardrails_1.validateGuardrails)(calcContext),
        listingQualityAssessments: (goodBuys || []).map(l => (0, listingQuality_1.assessListingQuality)(l)),
        actionPlan: (0, actionPlan_1.buildActionPlan)(calcContext)
    };
    return {
        success: true,
        player: parsed.player || null,
        cardSet: parsed.cardSet || null,
        productFamily: parsed.productFamily || null,
        parallel: parsed.parallel || null,
        normalizedParallel,
        isAuto: parsed.isAuto,
        rawPrice,
        adjustedRaw,
        estimatedPsa9,
        estimatedPsa10,
        confidenceScore,
        confidenceLabel,
        explanation,
        warnings,
        nextActions,
        ebaySupply,
        pricingBands,
        marketSignals,
        marketLadder,
        supplyDemandTrends,
        goodBuys,
        recentComps,
        calculation,
        ...decisionExtension
    };
}
