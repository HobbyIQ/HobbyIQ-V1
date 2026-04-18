// shared/accessGating.ts
// Tier-based access gating logic for HobbyIQ backend/shared logic

import { Tier, ENTITLEMENT_MODELS } from "../types/entitlementAccess";

export function canSearch(tier: Tier, searchesToday: number): boolean {
  const access = ENTITLEMENT_MODELS[tier];
  if (access.searchesPerDay === 'unlimited') return true;
  return searchesToday < access.searchesPerDay;
}

export function canAddToPortfolio(tier: Tier, currentPortfolioSize: number): boolean {
  const access = ENTITLEMENT_MODELS[tier];
  if (access.portfolioCardLimit === 'unlimited') return true;
  return currentPortfolioSize < access.portfolioCardLimit;
}

export function canAccessAdvancedAlerts(tier: Tier): boolean {
  return ENTITLEMENT_MODELS[tier].advancedAlertsEnabled;
}

export function canAccessPremiumInsights(tier: Tier): boolean {
  return ENTITLEMENT_MODELS[tier].premiumInsightsEnabled;
}

export function canAccessPortfolio(tier: Tier): boolean {
  return ENTITLEMENT_MODELS[tier].portfolioEnabled;
}

export function canAccessAlerts(tier: Tier): boolean {
  return ENTITLEMENT_MODELS[tier].alertsEnabled;
}
