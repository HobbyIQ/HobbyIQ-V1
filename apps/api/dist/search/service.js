"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSearch = handleSearch;
const classifier_1 = require("./classifier");
const intentClassifier_1 = require("../utils/intentClassifier");
// Dummy engine imports (replace with real ones)
// import { getPlayerIQ } from '../engines/playeriq';
// import { getCompIQ } from '../engines/compiq';
// import { getDecision } from '../engines/decision';
// import { getGeneralAnalysis } from '../engines/hobbyiq';
/**
 * Main search service for HobbyIQ. Routes query to correct engine/module.
 */
async function handleSearch(req) {
    // Minimal validation
    if (!req || typeof req.query !== 'string' || !req.query.trim()) {
        return {
            ok: false,
            intent: 'unknown',
            data: null,
            error: 'Missing or empty query input.'
        };
    }
    // Classify intent and extract player/card
    const intent = (0, classifier_1.classifySearchRequest)(req);
    const playerOrCard = (0, intentClassifier_1.extractPlayerOrCard)(req.query);
    // Fallback for unclear intent
    if (intent === 'unknown') {
        return {
            ok: false,
            intent,
            data: null,
            error: 'Could not determine intent. Please rephrase your question.'
        };
    }
    // Route to downstream engine (mocked for now)
    try {
        let data = null;
        const q = req.query;
        switch (intent) {
            case 'playeriq': {
                const player = playerOrCard || 'the player';
                data = {
                    title: `Scouting report for ${player}`,
                    summary: `${player} shows strong potential. See below for details.`,
                    bullets: [
                        `${player} is a top prospect in the current market.`,
                        `Athleticism and skillset are above average for their level.`,
                        `Keep an eye on recent performance and call-up news.`
                    ],
                    nextActions: [
                        `Check recent stats for ${player}.`,
                        `Compare with similar prospects.`,
                        `Monitor for news or injury updates.`
                    ]
                };
                break;
            }
            case 'compiq': {
                const card = playerOrCard || 'this card';
                data = {
                    title: `Current value for ${card}`,
                    summary: `Recent sales suggest ${card} is trading at a strong price point.`,
                    bullets: [
                        `Market value is based on recent comps and auction results.`,
                        `Parallel, grade, and scarcity affect price.`,
                        `Check eBay and Goldin for latest sales.`
                    ],
                    value: 123.45,
                    nextActions: [
                        `View latest eBay sales for ${card}.`,
                        `Compare with similar cards or parallels.`,
                        `Estimate value for different grades.`
                    ]
                };
                break;
            }
            case 'compare': {
                // Try to extract two sides of the comparison
                const compareMatch = q.match(/(.*?)(?: vs\.? | versus | vs | compare |better than)(.*)/i);
                const left = compareMatch && compareMatch[1] ? compareMatch[1].trim() : 'Option 1';
                const right = compareMatch && compareMatch[2] ? compareMatch[2].trim() : 'Option 2';
                data = {
                    title: `Comparison: ${left} vs ${right}`,
                    summary: `Comparing ${left} and ${right} based on recent market trends and player outlook.`,
                    bullets: [
                        `${left}: Check recent sales, player performance, and scarcity.`,
                        `${right}: Review comps, demand, and news.`,
                        `Consider which has more upside for your collection or investment.`
                    ],
                    nextActions: [
                        `Look up latest sales for both cards.`,
                        `Compare population reports and print runs.`,
                        `Ask about long-term outlook for each.`
                    ]
                };
                break;
            }
            case 'buy_sell_decision': {
                const card = playerOrCard || 'this card';
                data = {
                    title: `Buy/Sell/Hold Decision for ${card}`,
                    summary: `Based on current trends, now may be a good time to review your position in ${card}.`,
                    bullets: [
                        `Consider recent price movement and demand.`,
                        `Evaluate your cost basis and goals.`,
                        `Monitor for news or upcoming events.`
                    ],
                    decision: 'buy',
                    rationale: `Market signals suggest ${card} could see further upside.`,
                    nextActions: [
                        `Set a price alert for ${card}.`,
                        `Review your portfolio exposure.`,
                        `Check for upcoming games or news.`
                    ]
                };
                break;
            }
            case 'general_card_analysis': {
                const card = playerOrCard || 'this card';
                data = {
                    title: `Analysis for ${card}`,
                    summary: `${card} has unique features. See below for details.`,
                    bullets: [
                        `Check for serial numbering, parallels, and grade.`,
                        `Review population reports for rarity.`,
                        `Compare with similar cards from the same set.`
                    ],
                    nextActions: [
                        `Ask for a price estimate for ${card}.`,
                        `Look up recent sales data.`,
                        `Check grading population reports.`
                    ]
                };
                break;
            }
            default:
                data = null;
        }
        // Graceful handling if downstream returns no data
        if (!data) {
            return {
                ok: false,
                intent,
                data: null,
                error: 'No data found for this query.'
            };
        }
        // Consistent API response envelope
        return {
            ok: true,
            intent,
            data,
            error: null
        };
    }
    catch (err) {
        return {
            ok: false,
            intent,
            data: null,
            error: err?.message || 'Internal error.'
        };
    }
}
