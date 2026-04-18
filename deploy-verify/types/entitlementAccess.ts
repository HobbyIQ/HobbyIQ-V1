// types/entitlementAccess.ts
// Final shared entitlement model for HobbyIQ tiers

export type Tier = 'FREE' | 'PRO' | 'ALL_STAR';

export interface EntitlementAccess {
  tier: Tier;
  searchesPerDay: number | 'unlimited';
  portfolioCardLimit: number | 'unlimited';
  portfolioEnabled: boolean;
  alertsEnabled: boolean;
  advancedAlertsEnabled: boolean;
  premiumInsightsEnabled: boolean;
}

export const ENTITLEMENT_MODELS: Record<Tier, EntitlementAccess> = {
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
