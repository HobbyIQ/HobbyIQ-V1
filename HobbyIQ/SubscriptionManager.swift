//
//  SubscriptionManager.swift
//  HobbyIQ
//

import Combine
import Foundation
import StoreKit

enum AppAccessTier: String, CaseIterable, Identifiable {
    case none
    case free
    case pro
    case allStar

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none:
            return "Locked"
        case .free:
            return "Free"
        case .pro:
            return "Pro"
        case .allStar:
            return "All-Star"
        }
    }

    var systemImage: String {
        switch self {
        case .none:
            return "lock.fill"
        case .free:
            return "sparkles"
        case .pro:
            return "chart.line.uptrend.xyaxis.circle.fill"
        case .allStar:
            return "star.circle.fill"
        }
    }
}

struct SubscriptionPlan: Identifiable {
    let tier: AppAccessTier
    let title: String
    let detail: String
    let fallbackPrice: String

    var id: AppAccessTier { tier }
}

@MainActor
final class SubscriptionManager: ObservableObject {
    enum PurchaseState: Equatable {
        case idle
        case loadingProducts
        case purchasing
        case restoring
    }

    @Published private(set) var currentTier: AppAccessTier
    @Published private(set) var products: [Product] = []
    @Published private(set) var purchaseState: PurchaseState = .idle
    @Published private(set) var hasLoadedProducts = false
    @Published var statusMessage: String?

    let plans: [SubscriptionPlan] = [
        SubscriptionPlan(
            tier: .free,
            title: "Free",
            detail: "Preview the product with stable mock intelligence and a complete UI experience.",
            fallbackPrice: "$0"
        ),
        SubscriptionPlan(
            tier: .pro,
            title: "Pro",
            detail: "Best for active collectors using CompIQ, PlayerIQ, PortfolioIQ, and DailyIQ every day.",
            fallbackPrice: "$12.99 / month"
        ),
        SubscriptionPlan(
            tier: .allStar,
            title: "All-Star",
            detail: "Extended access for heavier users who want a lower effective monthly cost.",
            fallbackPrice: "$29.99 / quarter"
        )
    ]

    private let storageKey = "com.hobbyiq.subscriptionTier"
    private let productIDsByTier: [AppAccessTier: String] = [
        .pro: "com.hobbyiq.pro.monthly",
        .allStar: "com.hobbyiq.allstar.quarterly"
    ]

    private var updatesTask: Task<Void, Never>?

    init() {
        currentTier = UserDefaults.standard.string(forKey: storageKey)
            .flatMap(AppAccessTier.init(rawValue:)) ?? .none

        updatesTask = observeTransactionUpdates()
    }

    deinit {
        updatesTask?.cancel()
    }

    var hasUnlockedApp: Bool {
        currentTier != .none
    }

    var isBusy: Bool {
        purchaseState != .idle
    }

    var currentPlanDisplayName: String {
        currentTier.title
    }

    var appStoreSubscriptionsURL: URL? {
        URL(string: "https://apps.apple.com/account/subscriptions")
    }

    func prepare() async {
        await loadProducts()
        await refreshEntitlements()
    }

    func continueFree() {
        setTier(.free)
        statusMessage = nil
    }

    func purchase(_ tier: AppAccessTier) async {
        guard tier != .none else { return }

        if tier == .free {
            continueFree()
            return
        }

        purchaseState = .purchasing
        statusMessage = nil
        defer { purchaseState = .idle }

        guard let productID = productIDsByTier[tier],
              let product = products.first(where: { $0.id == productID }) else {
            setTier(tier)
            statusMessage = "\(tier.title) preview unlocked for internal testing."
            return
        }

        do {
            let result = try await product.purchase()
            switch result {
            case .success(.verified(let transaction)):
                await transaction.finish()
                await refreshEntitlements()
                statusMessage = "\(tier.title) unlocked."
            case .success(.unverified):
                statusMessage = "Purchase could not be verified."
            case .pending:
                statusMessage = "Purchase is pending approval."
            case .userCancelled:
                statusMessage = "Purchase canceled."
            @unknown default:
                statusMessage = "Purchase state is unavailable right now."
            }
        } catch {
            statusMessage = "Purchase failed. You can still continue with Free access for testing."
        }
    }

    func restorePurchases() async {
        purchaseState = .restoring
        statusMessage = nil
        defer { purchaseState = .idle }

        do {
            try await AppStore.sync()
            await refreshEntitlements()

            if currentTier == .none {
                statusMessage = "No previous purchases were found."
            } else {
                statusMessage = "\(currentTier.title) restored."
            }
        } catch {
            statusMessage = "Restore could not be completed right now."
        }
    }

    func presentPaywall() {
        setTier(.none)
        statusMessage = nil
    }

    func priceText(for tier: AppAccessTier) -> String {
        guard tier != .free else { return "$0" }
        guard let productID = productIDsByTier[tier],
              let product = products.first(where: { $0.id == productID }) else {
            return plans.first(where: { $0.tier == tier })?.fallbackPrice ?? ""
        }
        return product.displayPrice
    }

    private func loadProducts() async {
        guard hasLoadedProducts == false else { return }

        purchaseState = .loadingProducts
        defer {
            if purchaseState == .loadingProducts {
                purchaseState = .idle
            }
        }

        do {
            let ids = Array(productIDsByTier.values)
            products = try await Product.products(for: ids)
                .sorted { left, right in
                    left.price < right.price
                }
        } catch {
            products = []
        }

        hasLoadedProducts = true
    }

    private func refreshEntitlements() async {
        var resolvedTier: AppAccessTier = .none

        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }

            if let matchedTier = productIDsByTier.first(where: { $0.value == transaction.productID })?.key {
                if matchedTier == .allStar {
                    resolvedTier = .allStar
                    break
                }

                if resolvedTier != .allStar {
                    resolvedTier = matchedTier
                }
            }
        }

        if resolvedTier == .none, currentTier == .free {
            return
        }

        setTier(resolvedTier)
    }

    private func observeTransactionUpdates() -> Task<Void, Never> {
        Task {
            for await update in Transaction.updates {
                guard case .verified(let transaction) = update else { continue }
                await transaction.finish()
                await refreshEntitlements()
            }
        }
    }

    private func setTier(_ tier: AppAccessTier) {
        currentTier = tier
        UserDefaults.standard.set(tier.rawValue, forKey: storageKey)
    }
}
