//
//  SubscriptionStore.swift
//  HobbyIQ
//

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

    var accentColorName: String {
        switch self {
        case .none:
            return "secondary"
        case .free:
            return "accent"
        case .pro:
            return "accent"
        case .allStar:
            return "caution"
        }
    }
}

struct SubscriptionPlan: Identifiable {
    let tier: AppAccessTier
    let price: String
    let period: String
    let headline: String
    let detail: String

    var id: AppAccessTier { tier }
}

@MainActor
final class SubscriptionStore: ObservableObject {
    @Published private(set) var currentTier: AppAccessTier
    @Published private(set) var availableProducts: [String: Product] = [:]
    @Published private(set) var isPreparingStore = false
    @Published private(set) var isProcessingPurchase = false
    @Published private(set) var isRestoringPurchases = false
    @Published var purchaseMessage: String?

    let plans: [SubscriptionPlan] = [
        SubscriptionPlan(
            tier: .free,
            price: "$0",
            period: "",
            headline: "Try the product with mock intelligence",
            detail: "Explore the app experience before subscribing."
        ),
        SubscriptionPlan(
            tier: .pro,
            price: "$12.99",
            period: "/ month",
            headline: "Best for active collectors",
            detail: "Full CompIQ, PlayerIQ, PortfolioIQ, and DailyIQ access."
        ),
        SubscriptionPlan(
            tier: .allStar,
            price: "$29.99",
            period: "/ quarter",
            headline: "Lower effective monthly cost",
            detail: "Extended access for power users tracking multiple plays."
        )
    ]

    private let storageKey = "com.hobbyiq.subscriptionTier"

    private let productIdentifiers: [AppAccessTier: String] = [
        .pro: "com.hobbyiq.pro.monthly",
        .allStar: "com.hobbyiq.allstar.quarterly"
    ]

    init() {
        let storedValue = UserDefaults.standard.string(forKey: storageKey)
        self.currentTier = storedValue.flatMap(AppAccessTier.init(rawValue:)) ?? .none
    }

    var hasUnlockedApp: Bool {
        currentTier != .none
    }

    var currentPlanDisplayName: String {
        currentTier.title
    }

    var appStoreSubscriptionsURL: URL? {
        URL(string: "https://apps.apple.com/account/subscriptions")
    }

    func prepareStore() async {
        guard isPreparingStore == false else { return }

        isPreparingStore = true
        defer { isPreparingStore = false }

        await loadProducts()
        await refreshEntitlements()
    }

    func continueFree() {
        setTier(.free)
        purchaseMessage = nil
    }

    func purchase(_ tier: AppAccessTier) async {
        guard tier != .none else { return }

        if tier == .free {
            continueFree()
            return
        }

        isProcessingPurchase = true
        purchaseMessage = nil
        defer { isProcessingPurchase = false }

        if let productID = productIdentifiers[tier], let product = availableProducts[productID] {
            do {
                let result = try await product.purchase()
                switch result {
                case .success(.verified):
                    setTier(tier)
                    purchaseMessage = "\(tier.title) unlocked."
                case .success(.unverified):
                    purchaseMessage = "Purchase could not be verified."
                case .pending:
                    purchaseMessage = "Purchase is pending approval."
                case .userCancelled:
                    purchaseMessage = "Purchase canceled."
                @unknown default:
                    purchaseMessage = "Purchase state is unavailable right now."
                }
                return
            } catch {
                purchaseMessage = "Purchase failed. Using preview unlock for internal testing."
            }
        }

        try? await Task.sleep(for: .seconds(0.9))
        setTier(tier)
        purchaseMessage = "\(tier.title) preview unlocked for internal testing."
    }

    func restorePurchases() async {
        guard isRestoringPurchases == false else { return }

        isRestoringPurchases = true
        purchaseMessage = nil
        defer { isRestoringPurchases = false }

        do {
            try await AppStore.sync()
            await refreshEntitlements()

            if currentTier == .none {
                purchaseMessage = "No previous purchases were found. You can continue with Free access."
            } else {
                purchaseMessage = "\(currentTier.title) restored."
            }
        } catch {
            purchaseMessage = "Restore could not be completed right now."
        }
    }

    func presentPaywall() {
        setTier(.none)
        purchaseMessage = nil
    }

    func refreshEntitlements() async {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }

            if let matchedTier = productIdentifiers.first(where: { $0.value == transaction.productID })?.key {
                setTier(matchedTier)
                return
            }
        }
    }

    private func loadProducts() async {
        let ids = Array(productIdentifiers.values)
        guard ids.isEmpty == false else { return }

        do {
            let products = try await Product.products(for: ids)
            availableProducts = Dictionary(uniqueKeysWithValues: products.map { ($0.id, $0) })
        } catch {
            availableProducts = [:]
        }
    }

    private func setTier(_ tier: AppAccessTier) {
        currentTier = tier
        UserDefaults.standard.set(tier.rawValue, forKey: storageKey)
    }
}
