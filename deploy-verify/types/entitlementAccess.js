"use strict";
// types/entitlementAccess.ts
// Final shared entitlement model for HobbyIQ tiers
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITLEMENT_MODELS = void 0;
exports.ENTITLEMENT_MODELS = {
    FREE: {
        tier: 'FREE',
        searchesPerDay: 3,
        portfolioCardLimit: 10,
        portfolioEnabled: false,
        alertsEnabled: false,
        advancedAlertsEnabled: false,
        premiumInsightsEnabled: false
    },
    PRO: {
        tier: 'PRO',
        searchesPerDay: 'unlimited',
        portfolioCardLimit: 'unlimited',
        portfolioEnabled: true,
        alertsEnabled: true,
        advancedAlertsEnabled: false,
        premiumInsightsEnabled: false
    },
    ALL_STAR: {
        tier: 'ALL_STAR',
        searchesPerDay: 'unlimited',
        portfolioCardLimit: 'unlimited',
        portfolioEnabled: true,
        alertsEnabled: true,
        advancedAlertsEnabled: true,
        premiumInsightsEnabled: true
    }
};
