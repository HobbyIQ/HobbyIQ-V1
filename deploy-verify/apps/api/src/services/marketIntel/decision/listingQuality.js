"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessListingQuality = assessListingQuality;
function assessListingQuality(listing) {
    // TODO: Use real listing data
    return {
        title: listing.title,
        marketplace: listing.marketplace || "eBay",
        listingPrice: listing.price,
        photoQualityScore: 0.8,
        titleQualityScore: 0.9,
        cardPresentationScore: 0.85,
        underexposedOpportunityScore: 0.7,
        riskFlags: [],
        qualityLabel: "good",
        fitTags: ["best_value"],
        notes: ["Photo and title are clear; seller feedback strong."],
        listingUrl: listing.url
    };
}
