"use strict";
// shared/accessGating.ts
// Tier-based access gating logic for HobbyIQ backend/shared logic
Object.defineProperty(exports, "__esModule", { value: true });
exports.canSearch = canSearch;
exports.canAddToPortfolio = canAddToPortfolio;
exports.canAccessAdvancedAlerts = canAccessAdvancedAlerts;
exports.canAccessPremiumInsights = canAccessPremiumInsights;
exports.canAccessPortfolio = canAccessPortfolio;
exports.canAccessAlerts = canAccessAlerts;
const entitlementAccess_1 = require("../types/entitlementAccess");
function canSearch(tier, searchesToday) {
    const access = entitlementAccess_1.ENTITLEMENT_MODELS[tier];
    if (access.searchesPerDay === 'unlimited')
        return true;
    return searchesToday < access.searchesPerDay;
}
function canAddToPortfolio(tier, currentPortfolioSize) {
    const access = entitlementAccess_1.ENTITLEMENT_MODELS[tier];
    if (access.portfolioCardLimit === 'unlimited')
        return true;
    return currentPortfolioSize < access.portfolioCardLimit;
}
function canAccessAdvancedAlerts(tier) {
    return entitlementAccess_1.ENTITLEMENT_MODELS[tier].advancedAlertsEnabled;
}
function canAccessPremiumInsights(tier) {
    return entitlementAccess_1.ENTITLEMENT_MODELS[tier].premiumInsightsEnabled;
}
function canAccessPortfolio(tier) {
    return entitlementAccess_1.ENTITLEMENT_MODELS[tier].portfolioEnabled;
}
function canAccessAlerts(tier) {
    return entitlementAccess_1.ENTITLEMENT_MODELS[tier].alertsEnabled;
}
