"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findBuyOpportunities = findBuyOpportunities;
function findBuyOpportunities(context) {
    // Example: fallback mock opportunity
    if (!context.listings || context.listings.length === 0)
        return [];
    return context.listings.filter(l => l.price < context.priceBands.buyZoneHigh).map(l => ({
        title: l.title,
        marketplace: "eBay",
        listingPrice: l.price,
        estimatedFmv: context.weightedMedian,
        buyZoneLow: context.priceBands.buyZoneLow,
        buyZoneHigh: context.priceBands.buyZoneHigh,
        estimatedUpsidePct: Math.round(((context.weightedMedian - l.price) / l.price) * 100),
        buyScore: 80,
        reason: "Below FMV and in buy zone",
        riskNotes: ["Liquidity and trend positive"],
        listingUrl: l.url
    }));
}
