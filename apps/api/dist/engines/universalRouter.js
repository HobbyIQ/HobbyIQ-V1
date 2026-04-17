"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeUniversalSearch = routeUniversalSearch;
const intentClassifier_1 = require("../utils/intentClassifier");
const compiq_1 = require("./compiq");
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
async function routeUniversalSearch(req) {
    const intent = (0, intentClassifier_1.classifyIntent)(req.query);
    if (intent === "comp") {
        const comp = await (0, compiq_1.compiqEngine)(req);
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
        // const player = await playeriqEngine(req);
        const player = {
            directAnswer: "Player is trending up.",
            why: ["Recent stats are strong.", "Increased playing time."],
            action: "Monitor for breakout."
        };
        return toNormalizedResponse({
            query: req.query,
            intent: "playeriq",
            title: "PlayerIQ Analysis",
            summary: player.directAnswer || "Player analysis summary.",
            result: player,
            bullets: player.why || [],
            nextActions: [player.action || ""]
        });
    }
    else if (intent === "compare") {
        // const compare = await compareEngine(req);
        const compare = {
            directAnswer: "Blue auto is more valuable than purple auto.",
            why: ["Lower print run.", "Higher demand."],
            action: "Prefer blue auto."
        };
        return toNormalizedResponse({
            query: req.query,
            intent: "compare",
            title: "Comparison Result",
            summary: compare.directAnswer || "Comparison summary.",
            result: compare,
            bullets: compare.why || [],
            nextActions: [compare.action || ""]
        });
    }
    else if (intent === "buy" || intent === "sell" || intent === "decision") {
        // const decision = await buySellEngine(req);
        const decision = {
            directAnswer: "Strong Buy recommendation.",
            why: ["All signals positive.", "Market momentum is high."],
            action: "Consider buying now."
        };
        return toNormalizedResponse({
            query: req.query,
            intent: intent,
            title: "Buy/Sell Decision",
            summary: decision.directAnswer || "Buy/sell analysis.",
            result: decision,
            bullets: decision.why || [],
            nextActions: [decision.action || ""]
        });
    }
    else if (intent === "general") {
        // const general = await generalAnalysisEngine(req);
        const general = {
            directAnswer: "This card is a solid hold.",
            why: ["Stable price.", "No major news."],
            action: "Hold for now."
        };
        return toNormalizedResponse({
            query: req.query,
            intent: "general",
            title: "General Analysis",
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
