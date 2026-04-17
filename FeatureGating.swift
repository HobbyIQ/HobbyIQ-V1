// FeatureGating.swift
// HobbyIQ feature gating using StoreKitSubscriptionManager as the single source of truth
// No Stripe, no backend billing

import Foundation

struct HobbyIQFeatureAccess {
    let canSearch: Bool
    let maxSearchesPerDay: Int?
    let portfolioEnabled: Bool
    let basicAlertsEnabled: Bool
    let advancedAlertsEnabled: Bool
    let premiumInsightsEnabled: Bool
}

extension StoreKitSubscriptionManager.Tier {
    var featureAccess: HobbyIQFeatureAccess {
        switch self {
        case .free:
            return HobbyIQFeatureAccess(
                canSearch: true,
                maxSearchesPerDay: 3,
                portfolioEnabled: false,
                basicAlertsEnabled: false,
                advancedAlertsEnabled: false,
                premiumInsightsEnabled: false
            )
        case .pro:
            return HobbyIQFeatureAccess(
                canSearch: true,
                maxSearchesPerDay: nil, // unlimited
                portfolioEnabled: true,
                basicAlertsEnabled: true,
                advancedAlertsEnabled: false,
                premiumInsightsEnabled: false
            )
        case .allStar:
            return HobbyIQFeatureAccess(
                canSearch: true,
                maxSearchesPerDay: nil, // unlimited
                portfolioEnabled: true,
                basicAlertsEnabled: true,
                advancedAlertsEnabled: true,
                premiumInsightsEnabled: true
            )
        }
    }
}
