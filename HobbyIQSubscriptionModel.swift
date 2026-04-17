// HobbyIQSubscriptionModel.swift
// Reusable subscription model for iOS UI and feature gating
// No Stripe, Apple-only

import Foundation

enum HobbyIQTier: String, CaseIterable, Identifiable {
    case free = "FREE"
    case pro = "PRO"
    case allStar = "ALL_STAR"
    
    var id: String { rawValue }
}

struct HobbyIQEntitlement {
    let tier: HobbyIQTier
    let searchesPerDay: Int? // nil = unlimited
    let portfolioEnabled: Bool
    let alertsEnabled: Bool
    let advancedAlertsEnabled: Bool
    let premiumInsightsEnabled: Bool
}

extension HobbyIQTier {
    var entitlement: HobbyIQEntitlement {
        switch self {
        case .free:
            return HobbyIQEntitlement(
                tier: .free,
                searchesPerDay: 3,
                portfolioEnabled: false,
                alertsEnabled: false,
                advancedAlertsEnabled: false,
                premiumInsightsEnabled: false
            )
        case .pro:
            return HobbyIQEntitlement(
                tier: .pro,
                searchesPerDay: nil, // unlimited
                portfolioEnabled: true,
                alertsEnabled: true,
                advancedAlertsEnabled: false,
                premiumInsightsEnabled: false
            )
        case .allStar:
            return HobbyIQEntitlement(
                tier: .allStar,
                searchesPerDay: nil, // unlimited
                portfolioEnabled: true,
                alertsEnabled: true,
                advancedAlertsEnabled: true,
                premiumInsightsEnabled: true
            )
        }
    }
}
