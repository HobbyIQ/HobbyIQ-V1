"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.universalRouter = universalRouter;
exports.routeUniversalSearch = universalRouter;
const intentClassifier_1 = require("../utils/intentClassifier");
const compiq_1 = require("./compiq");
const playerPerformance_1 = require("../services/playerPerformance");
const service_1 = require("./decision/service");
const service_2 = require("./selliq/service");
function toNormalizedResponse({ query, intent, title = "", summary = "", result = {}, bullets = [], nextActions = [], ...rest }) {
    return {
        success: true,
        query,
        intent,
        title,
        summary,
        result,
        bullets,
        nextActions,
        ...rest,
    };
}
async function universalRouter(req) {
    const parsed = (0, intentClassifier_1.parseQuery)(req.query);
    const intent = (0, intentClassifier_1.classifyIntent)(req.query);
    if (intent === "comp") {
        // Route to CompIQ engine, pass parsed context
        const comp = await (0, compiq_1.compiqEngine)({ ...req, context: parsed });
        return toNormalizedResponse({
            query: req.query,
            intent: "compiq",
            title: "CompIQ Price Estimate",
            summary: comp.directAnswer || "Estimated value and recommendation.",
            result: comp,
            bullets: comp.why || [],
            nextActions: [comp.action || ""]
        });
    }
    else if (intent === "playeriq") {
        // Route to real PlayerIQ (player performance), use parsed.player if available
        let player = null;
        let summary = "";
        let bullets = [];
        let action = "";
        try {
            const playerId = parsed.player || req.query.split(" ")[0];
            player = await (0, playerPerformance_1.getPlayerPerformance)(playerId);
            summary = player && player.stats && player.stats.summary ? player.stats.summary : "Player analysis summary.";
            bullets = player && player.stats && player.stats.bullets ? player.stats.bullets : [];
            action = player && player.stats && player.stats.action ? player.stats.action : "Monitor for breakout.";
        }
        catch (e) {
            summary = "No player data available.";
            bullets = [e.message || "Player data unavailable."];
            action = "Try a different player.";
        }
        return toNormalizedResponse({
            query: req.query,
            intent: "playeriq",
            title: "PlayerIQ Analysis",
            summary,
            result: player,
            bullets,
            nextActions: [action]
        });
    }
    else if (intent === "compare") {
        // Compare: fetch comp stats for left and right if possible
        let leftComp = null, rightComp = null;
        let leftSummary = "", rightSummary = "";
        if (parsed.left) {
            leftComp = await (0, compiq_1.compiqEngine)({ ...req, query: parsed.left });
            leftSummary = leftComp.directAnswer || "";
        }
        if (parsed.right) {
            rightComp = await (0, compiq_1.compiqEngine)({ ...req, query: parsed.right });
            rightSummary = rightComp.directAnswer || "";
        }
        return toNormalizedResponse({
            query: req.query,
            intent: "compare",
            title: "Comparison",
            summary: `${leftSummary} vs ${rightSummary}`,
            result: { left: leftComp, right: rightComp },
            bullets: [],
            nextActions: []
        });
    }
    else if (intent === "decision" || intent === "buy" || intent === "sell") {
        // Route to Decision Engine and/or SellIQ
        // Map UniversalSearchRequest to DecisionEngineInput (stub: use dummy values or extract from req/context)
        const context = req.context || {};
        const decisionInput = {
            compIQ: context.compIQ ?? 50,
            playerIQ: context.playerIQ ?? 50,
            dailyIQ: context.dailyIQ ?? 50,
            supplyScore: context.supplyScore ?? 50,
            scarcityScore: context.scarcityScore ?? 50,
            liquidityScore: context.liquidityScore ?? 50,
            negativePressureScore: context.negativePressureScore ?? 0,
            pricingTrend: context.pricingTrend ?? 0
        };
        const decisionResult = (0, service_1.runDecisionEngine)(decisionInput);
        const sellResult = (0, service_2.runSellIQ)({ ...context, decisionRecommendation: decisionResult.recommendation });
        const action = decisionResult.recommendation || (sellResult && sellResult.action) || "Hold";
        const bullets = decisionResult.explanation || ["No reason provided."];
        return toNormalizedResponse({
            query: req.query,
            intent,
            title: "Decision Engine",
            summary: decisionResult.recommendation,
            result: { decisionResult, sellResult },
            bullets,
            nextActions: [action]
        });
    }
    else if (intent === "general") {
        // General card analysis: use CompIQ for real sold data
        const comp = await (0, compiq_1.compiqEngine)(req);
        const general = {
            directAnswer: comp.directAnswer || "No FMV available.",
            why: comp.why || ["No comp data."],
            action: comp.action || "Hold for now.",
            keyNumbers: comp.keyNumbers,
            expandable: comp.expandable
        };
        return toNormalizedResponse({
            query: req.query,
            intent: "general",
            title: "General Card Analysis",
            summary: general.directAnswer || "General analysis summary.",
            result: general,
            bullets: general.why || [],
            nextActions: [general.action || ""]
        });
    }
    else {
        return toNormalizedResponse({
            query: req.query,
            intent: "unknown",
            title: "Unrecognized Query",
            summary: "Sorry, I couldn't understand your question.",
            result: {},
            bullets: ["No matching engine found for your query."],
            nextActions: ["Try rephrasing your search."]
        });
    }
}
