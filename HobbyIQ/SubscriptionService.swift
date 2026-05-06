//
//  SubscriptionService.swift
//  HobbyIQ
//

import Foundation

enum SubscriptionTier: String, CaseIterable, Identifiable {
    case free
    case pro
    case allStar

    var id: String { rawValue }

    var title: String {
        switch self {
        case .free: return "Free"
        case .pro: return "Pro"
        case .allStar: return "All-Star"
        }
    }

    var priceText: String {
        switch self {
        case .free: return "$0"
        case .pro: return "$12.99 / month"
        case .allStar: return "$24.99 / month"
        }
    }

    var headline: String {
        switch self {
        case .free: return "Try the core HobbyIQ experience"
        case .pro: return "Best for active collectors"
        case .allStar: return "Best for heavy daily use"
        }
    }
}

protocol SubscriptionServicing {
    func currentTier(for scenario: AppSessionScenario) async throws -> SubscriptionTier?
    func purchase(_ tier: SubscriptionTier) async throws -> SubscriptionTier
    func restorePurchases(for scenario: AppSessionScenario) async throws -> SubscriptionTier?
}

struct SubscriptionService: SubscriptionServicing {
    static let shared = SubscriptionService()

    func currentTier(for scenario: AppSessionScenario) async throws -> SubscriptionTier? {
        try await Task.sleep(for: .milliseconds(350))

        switch scenario {
        case .signedOut, .noAccess:
            return nil
        case .ready:
            return .pro
        }
    }

    func purchase(_ tier: SubscriptionTier) async throws -> SubscriptionTier {
        // TODO: Replace with StoreKit 2 product loading + purchase handling.
        try await Task.sleep(for: .milliseconds(450))
        return tier
    }

    func restorePurchases(for scenario: AppSessionScenario) async throws -> SubscriptionTier? {
        // TODO: Replace with AppStore.sync + transaction verification.
        try await Task.sleep(for: .milliseconds(400))
        return try await currentTier(for: scenario)
    }
}
