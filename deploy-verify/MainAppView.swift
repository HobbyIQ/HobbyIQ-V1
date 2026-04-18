// MainAppView.swift
// HobbyIQ feature gating based on Apple StoreKit subscription tier
// No Stripe, no web paywall, StoreKit entitlement is the only source of truth

import SwiftUI

struct MainAppView: View {
    @StateObject private var manager = SubscriptionManager.shared
    @State private var searchesToday: Int = 0 // Replace with your search tracking logic

    var body: some View {
        VStack(spacing: 24) {
            // Search gating
            if manager.currentTier == .free && searchesToday >= 3 {
                Text("Upgrade to PRO or ALL-STAR for unlimited searches.")
                    .foregroundColor(.red)
            } else {
                SearchView()
            }

            // Portfolio gating
            if manager.currentTier == .free {
                LimitedPortfolioView()
            } else {
                FullPortfolioView()
            }

            // Alerts gating
            if manager.currentTier == .pro {
                BasicAlertsView()
            } else if manager.currentTier == .allStar {
                AdvancedAlertsView()
                PremiumInsightsView()
            }

            Spacer()
        }
        .onAppear {
            Task {
                await manager.updateEntitlement()
            }
        }
    }
}

// MARK: - Feature Utility Extensions
extension SubscriptionManager {
    var canUseUnlimitedSearches: Bool {
        currentTier == .pro || currentTier == .allStar
    }
    var canUseFullPortfolio: Bool {
        currentTier == .pro || currentTier == .allStar
    }
    var canUseBasicAlerts: Bool {
        currentTier == .pro || currentTier == .allStar
    }
    var canUseAdvancedAlerts: Bool {
        currentTier == .allStar
    }
    var canUsePremiumInsights: Bool {
        currentTier == .allStar
    }
}
