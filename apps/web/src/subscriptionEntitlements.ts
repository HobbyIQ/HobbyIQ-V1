/*
App Store Connect Setup Guidance for HobbyIQ Subscriptions

1. Create two auto-renewable subscription products in App Store Connect:
   - Product ID: hobbyiq.pro
   - Product ID: hobbyiq.allstar

2. Both products must be in the same Subscription Group (e.g., "HobbyIQ Premium").

3. Set durations, pricing, and localizations as needed for each product.

4. Enable "Family Sharing" if desired (optional).

5. In the app:
   - Use StoreKit 2 to load and purchase these products.
   - Implement and expose a "Restore Purchases" button (required by Apple).
   - Unlock features based on the current StoreKit entitlement state (do not hardcode unlocks).

6. Test subscriptions and restore flow using the App Store sandbox environment before release.

7. Do not add Stripe or any other web-based billing for iOS users.
*/

// HobbyIQ App StoreKit Subscription Entitlement Model
// This file defines the entitlement logic for Apple App Store subscriptions only.

export type HobbyIQTier = "FREE" | "PRO" | "ALL_STAR";

export interface HobbyIQEntitlement {
  tier: HobbyIQTier;
  searchesPerDay: number | "unlimited";
  portfolioEnabled: boolean;
  alertsEnabled: boolean;
  advancedAlertsEnabled: boolean;
  dailyInsightsEnabled: boolean;
}

// StoreKit product identifiers (example)
export const STOREKIT_PRODUCT_IDS = {
  PRO: "com.hobbyiq.pro",
  ALL_STAR: "com.hobbyiq.allstar"
};

// Entitlement mapping for each tier
export const ENTITLEMENTS: Record<HobbyIQTier, HobbyIQEntitlement> = {
  FREE: {
    tier: "FREE",
    searchesPerDay: 3,
    portfolioEnabled: false,
    alertsEnabled: false,
    advancedAlertsEnabled: false,
    dailyInsightsEnabled: false
  },
  PRO: {
    tier: "PRO",
    searchesPerDay: "unlimited",
    portfolioEnabled: true,
    alertsEnabled: true,
    advancedAlertsEnabled: false,
    dailyInsightsEnabled: false
  },
  ALL_STAR: {
    tier: "ALL_STAR",
    searchesPerDay: "unlimited",
    portfolioEnabled: true,
    alertsEnabled: true,
    advancedAlertsEnabled: true,
    dailyInsightsEnabled: true
  }
};

// Utility: Map StoreKit product ID to tier
export function getTierFromProductId(productId: string): HobbyIQTier {
  switch (productId) {
    case STOREKIT_PRODUCT_IDS.PRO:
      return "PRO";
    case STOREKIT_PRODUCT_IDS.ALL_STAR:
      return "ALL_STAR";
    default:
      return "FREE";
  }
}

// Utility: Get entitlement for a given tier
export function getEntitlementForTier(tier: HobbyIQTier): HobbyIQEntitlement {
  return ENTITLEMENTS[tier];
}

// Example: Get entitlement from StoreKit purchase
// const tier = getTierFromProductId(storeKitProductId);
// const entitlement = getEntitlementForTier(tier);

name: Workflow Test

"on":
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Confirm workflow loads
        run: echo "ok"
