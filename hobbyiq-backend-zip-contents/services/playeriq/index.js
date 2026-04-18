"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPlayerIQ = runPlayerIQ;
const scoring_1 = require("./scoring");
const risk_1 = require("./risk");
const summary_1 = require("./summary");
function buildCardMarketSnapshot(player) {
    // Example mock/fallback logic (replace with real market data)
    if (/brady ebel/i.test(player)) {
        return {
            keyCardPrices: {
                "2023 Bowman Chrome Auto": 350,
                "2023 Bowman Chrome Refractor Auto": 600,
            },
            baseAutoRaw: 350,
            baseAutoPsa10: 900,
            refractorAutoRaw: 600,
            colorHighlights: ["Gold /50", "Orange /25"],
            marketTrend: "Upward",
            marketSummary: "Strong demand for top color autos; gem PSA 10s command a premium.",
        };
    }
    else if (/roman anthony/i.test(player)) {
        return {
            keyCardPrices: {
                "2023 Bowman Chrome Auto": 180,
                "2023 Bowman Chrome Refractor Auto": 320,
            },
            baseAutoRaw: 180,
            baseAutoPsa10: 400,
            refractorAutoRaw: 320,
            colorHighlights: ["Gold /50"],
            marketTrend: "Stable",
            marketSummary: "Market is steady; color autos see moderate action.",
        };
    }
    else {
        return {
            keyCardPrices: {},
            baseAutoRaw: null,
            baseAutoPsa10: null,
            refractorAutoRaw: null,
            colorHighlights: [],
            marketTrend: "Unknown",
            marketSummary: "No reliable card market data.",
        };
    }
}
function buildTopGemRateCards(player) {
    // Example mock/fallback logic (replace with real pop report data)
    if (/brady ebel/i.test(player)) {
        return [
            {
                cardName: "2023 Bowman Chrome Auto",
                parallel: "Base Auto",
                estimatedGemRate: 62,
                populationSignal: "Low pop",
                scarcitySignal: "Moderate",
                gradingRecommendation: "Strong PSA 10 upside"
            },
            {
                cardName: "2023 Bowman Chrome Gold Auto",
                parallel: "Gold /50",
                estimatedGemRate: 55,
                populationSignal: "Very low pop",
                scarcitySignal: "High",
                gradingRecommendation: "Grade if clean"
            }
        ];
    }
    else if (/roman anthony/i.test(player)) {
        return [
            {
                cardName: "2023 Bowman Chrome Auto",
                parallel: "Base Auto",
                estimatedGemRate: 48,
                populationSignal: "Moderate",
                scarcitySignal: "Moderate",
                gradingRecommendation: "Grade only best copies"
            }
        ];
    }
    else {
        return [];
    }
}
async function runPlayerIQ(input) {
    const warnings = [];
    if (!input.player)
        warnings.push("Player name is required");
    const scores = (0, scoring_1.scorePlayerIQ)(input);
    const risk = (0, risk_1.getRiskBand)(scores);
    const summaryBlock = (0, summary_1.buildPlayerIQSummary)(input, scores, risk);
    // Card market snapshot
    const cardMarketSnapshot = buildCardMarketSnapshot(input.player);
    // Top gem-rate cards
    const topGemRateCards = buildTopGemRateCards(input.player);
    // Next actions
    const nextActions = [];
    if (warnings.length)
        nextActions.push("Refine your search with a full player name");
    else
        nextActions.push("View comps", "Add to portfolio");
    return {
        success: true,
        player: input.player,
        organization: input.organization || null,
        level: input.level || null,
        overallScore: scores.overall,
        talentScore: scores.talent,
        marketScore: scores.market,
        riskScore: risk.riskScore,
        riskLabel: risk.riskLabel,
        summary: summaryBlock.summary,
        strengths: summaryBlock.strengths,
        risks: summaryBlock.risks,
        recommendation: summaryBlock.recommendation,
        confidence: summaryBlock.confidence,
        cardMarketSnapshot,
        topGemRateCards,
        warnings,
        nextActions,
    };
}
