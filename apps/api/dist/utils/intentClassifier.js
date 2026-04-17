"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPlayerOrCard = extractPlayerOrCard;
exports.classifyIntent = classifyIntent;
// Extract player/card name using lightweight heuristics
function extractPlayerOrCard(query) {
    if (!query)
        return null;
    // Look for patterns like "[Firstname Lastname] [card details]"
    const playerMatch = query.match(/([A-Z][a-z]+ [A-Z][a-z]+|[A-Z][a-z]+)$/);
    if (playerMatch)
        return playerMatch[1];
    // Try to find a capitalized word (for single names)
    const single = query.match(/([A-Z][a-z]+)/);
    return single ? single[1] : null;
}
// Improved intent classifier
function classifyIntent(query) {
    if (!query || typeof query !== 'string' || !query.trim())
        return "unknown";
    const q = query.toLowerCase();
    // Compare intent (strongest match, now supports color/parallel compare)
    if (/(compare|vs\.?|versus|better than|difference|head to head|who wins|which is better|vs | vs )/i.test(q) || /\b(blue|gold|purple|auto|shimmer|refractor|base) vs (blue|gold|purple|auto|shimmer|refractor|base)\b/i.test(q)) {
        return "compare";
    }
    // Buy/Sell/Decision intent (expanded)
    if (/(should i (buy|sell|hold|trade|keep|move|exit)|is now a good time|recommendation|decision|keep or sell|move|exit|buy or sell|sell now|hold now|is [a-z]+ [a-z]+ a buy|is [a-z]+ [a-z]+ a sell|is [a-z]+ a buy|is [a-z]+ a sell|buy candidate|sell candidate|add to pc|move on from|hold candidate)/i.test(q)) {
        return "buy_sell_decision";
    }
    // PlayerIQ intent (player ability, scouting, prospecting, "is X a buy" now handled above)
    if (/(how (good|talented) is|is [a-z]+ [a-z]+ (good|talented)|player profile|scouting report|prospect|rookie|potential|talent|future star|should i draft|breakout candidate|mlb debut|call up)/i.test(q)) {
        return "playeriq";
    }
    // CompIQ intent (value, price, worth, FMV, "what is X worth")
    if (/(worth|value|fmv|price|how much|what is.*worth|what is.*value|what is.*price|sell for|buy for|market value|current value|recent sales|comp(s)?|comparable sales|last sold|recently sold|ebay|auction)/i.test(q)) {
        return "compiq";
    }
    // General card analysis (card features, set, year, parallel, serial, etc)
    if (/(auto|refractor|shimmer|mojo|gold|blue|purple|green|orange|red|black|superfractor|chrome|paper|serial|psa|bgs|sgc|graded|raw|numbered|parallel|variation|ssp|sp|insert|rookie card|rc|patch|jersey|on card|sticker|mint|gem|pop report|population|print run|year|\d{2,4})/i.test(q)) {
        return "general_card_analysis";
    }
    // Fallback
    return "unknown";
}
