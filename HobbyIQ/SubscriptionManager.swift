//
//  SubscriptionManager.swift
//  HobbyIQ
//

import Combine
import Foundation
import StoreKit
import os

enum AppAccessTier: String, CaseIterable, Identifiable {
    case none
    case free
    case collector
    case investor
    case proSeller = "pro_seller"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none:
            return "Locked"
        case .free:
            return "Free"
        case .collector:
            return "Collector"
        case .investor:
            return "Investor"
        case .proSeller:
            return "Pro Seller"
        }
    }

    var systemImage: String {
        switch self {
        case .none:
            return "lock.fill"
        case .free:
            return "sparkles"
        case .collector:
            return "rectangle.stack.fill"
        case .investor:
            return "chart.line.uptrend.xyaxis.circle.fill"
        case .proSeller:
            return "star.circle.fill"
        }
    }

    var rank: Int {
        switch self {
        case .none: return 0
        case .free: return 1
        case .collector: return 2
        case .investor: return 3
        case .proSeller: return 4
        }
    }
}

struct EntitlementState: Equatable {
    let plan: AppAccessTier
    let features: Set<String>
    let caps: EntitlementCaps

    static let empty = EntitlementState(
        plan: .none,
        features: [],
        caps: EntitlementCaps(
            priceChecksPerDay: .limited(0),
            holdingsCap: .limited(0),
            scansPerMonth: .limited(0),
            priceAlerts: .limited(0)
        )
    )
}

// MARK: - Gated Features & Caps (canonical backend mirror)

enum GatedFeature {
    static let predictions = "predictions"
    static let watchlist = "watchlist"
    static let advancedAlerts = "advancedAlerts"
    static let dailyIQBriefs = "dailyIQBriefs"
    static let trendIQComposite = "trendIQComposite"
    static let ebayIntegration = "ebayIntegration"
    static let marketTrendIndexes = "marketTrendIndexes"
    static let trendIQLayer3Full = "trendIQLayer3Full"
    static let erpReconciliation = "erpReconciliation"

    static let all: [String] = [
        predictions, watchlist, advancedAlerts, dailyIQBriefs,
        trendIQComposite, ebayIntegration, marketTrendIndexes,
        trendIQLayer3Full, erpReconciliation,
    ]

    static func minimumTier(for feature: String) -> AppAccessTier {
        for tier in [AppAccessTier.collector, .investor, .proSeller] {
            if TierMatrix.features[tier]?.contains(feature) == true { return tier }
        }
        return .proSeller
    }

    static func displayName(for feature: String) -> String {
        switch feature {
        case predictions: return "Predictions"
        case watchlist: return "Watchlist"
        case advancedAlerts: return "Advanced Alerts"
        case dailyIQBriefs: return "DailyIQ Briefs"
        case trendIQComposite: return "TrendIQ Composite"
        case ebayIntegration: return "eBay Integration"
        case marketTrendIndexes: return "Market Trend Indexes"
        case trendIQLayer3Full: return "TrendIQ Layer 3"
        case erpReconciliation: return "ERP Reconciliation"
        default: return feature
        }
    }
}

enum GatedCap: String, CaseIterable {
    case priceChecksPerDay
    case holdingsCap
    case scansPerMonth
    case priceAlerts

    var displayName: String {
        switch self {
        case .priceChecksPerDay: return "Price Checks"
        case .holdingsCap: return "Holdings"
        case .scansPerMonth: return "Scans"
        case .priceAlerts: return "Price Alerts"
        }
    }

    func upgradeTier(from currentTier: AppAccessTier) -> AppAccessTier? {
        switch self {
        case .priceChecksPerDay, .scansPerMonth:
            return currentTier.rank < AppAccessTier.collector.rank ? .collector : nil
        case .holdingsCap:
            if currentTier.rank < AppAccessTier.collector.rank { return .collector }
            if currentTier.rank < AppAccessTier.investor.rank { return .investor }
            return nil
        case .priceAlerts:
            if currentTier.rank < AppAccessTier.collector.rank { return .collector }
            if currentTier.rank < AppAccessTier.investor.rank { return .investor }
            if currentTier.rank < AppAccessTier.proSeller.rank { return .proSeller }
            return nil
        }
    }
}

extension CapValue {
    var displayText: String {
        switch self {
        case .limited(let n): return "\(n)"
        case .unlimited: return "Unlimited"
        }
    }

    var isUnlimited: Bool {
        if case .unlimited = self { return true }
        return false
    }
}

enum TierMatrix {
    static let features: [AppAccessTier: Set<String>] = [
        .free: [],
        .collector: [GatedFeature.predictions, GatedFeature.watchlist],
        .investor: [GatedFeature.predictions, GatedFeature.watchlist, GatedFeature.advancedAlerts,
                    GatedFeature.dailyIQBriefs, GatedFeature.trendIQComposite,
                    GatedFeature.ebayIntegration, GatedFeature.marketTrendIndexes],
        .proSeller: Set(GatedFeature.all),
    ]

    static let caps: [AppAccessTier: [GatedCap: CapValue]] = [
        .free: [.priceChecksPerDay: .limited(5), .holdingsCap: .limited(25),
                .scansPerMonth: .limited(10), .priceAlerts: .limited(0)],
        .collector: [.priceChecksPerDay: .unlimited, .holdingsCap: .limited(250),
                     .scansPerMonth: .unlimited, .priceAlerts: .limited(10)],
        .investor: [.priceChecksPerDay: .unlimited, .holdingsCap: .unlimited,
                    .scansPerMonth: .unlimited, .priceAlerts: .limited(30)],
        .proSeller: [.priceChecksPerDay: .unlimited, .holdingsCap: .unlimited,
                     .scansPerMonth: .unlimited, .priceAlerts: .unlimited],
    ]

    static func highlights(for tier: AppAccessTier) -> [String] {
        guard tier != .none else { return [] }

        var items: [String] = []

        let previousTier: AppAccessTier? = {
            switch tier {
            case .collector: return .free
            case .investor: return .collector
            case .proSeller: return .investor
            default: return nil
            }
        }()

        if let prev = previousTier, prev.rank >= AppAccessTier.collector.rank {
            items.append("Everything in \(prev.title)")
        }

        if tier == .free {
            items.append("CompIQ card decisions")
            items.append("PlayerIQ market view")
        }

        if let tierCaps = caps[tier] {
            let prevCaps = previousTier.flatMap { caps[$0] }
            for cap in GatedCap.allCases {
                guard let value = tierCaps[cap] else { continue }
                let changed = prevCaps.flatMap { $0[cap] } != value
                guard changed else { continue }
                if case .limited(0) = value { continue }
                items.append(capHighlight(value, cap))
            }
        }

        let tierFeatures = features[tier] ?? []
        let previousFeatures = previousTier.flatMap { features[$0] } ?? []
        let newFeatures = tierFeatures.subtracting(previousFeatures)
        for feature in GatedFeature.all where newFeatures.contains(feature) {
            items.append(GatedFeature.displayName(for: feature))
        }

        return items
    }

    private static func capHighlight(_ value: CapValue, _ cap: GatedCap) -> String {
        let suffix: String = {
            switch cap {
            case .priceChecksPerDay: return "/day"
            case .scansPerMonth: return "/month"
            default: return ""
            }
        }()
        return "\(value.displayText) \(cap.displayName.lowercased())\(suffix)"
    }
}

struct SubscriptionPlan: Identifiable {
    let tier: AppAccessTier
    let title: String
    let detail: String
    let fallbackPrice: String
    let price: String
    let period: String
    let headline: String

    var id: AppAccessTier { tier }

    init(
        tier: AppAccessTier,
        title: String,
        detail: String,
        fallbackPrice: String
    ) {
        self.tier = tier
        self.title = title
        self.detail = detail
        self.fallbackPrice = fallbackPrice
        self.price = fallbackPrice
        self.period = ""
        self.headline = title
    }

    init(
        tier: AppAccessTier,
        price: String,
        period: String,
        headline: String,
        detail: String
    ) {
        self.tier = tier
        self.title = headline
        self.detail = detail
        self.fallbackPrice = "\(price)\(period)"
        self.price = price
        self.period = period
        self.headline = headline
    }
}

/// Lifecycle of the backend entitlements fetch. Distinct from the user's
/// tier so a transient failure can be observed without conflating it with
/// "user is on the free tier."
enum EntitlementLoadState: Equatable {
    case idle           // never attempted (pre-launch / signed-out)
    case loading        // fetch in flight
    case loaded         // fetch succeeded; currentTier reflects backend truth
    case failed(String) // fetch failed; currentTier preserved from cache; gating floors
}

@MainActor
final class SubscriptionManager: ObservableObject {
    static let shared = SubscriptionManager()

    enum PurchaseState: Equatable {
        case idle
        case loadingProducts
        case purchasing
        case restoring
    }

    @Published private(set) var currentTier: AppAccessTier
    @Published private(set) var entitlementState: EntitlementState?
    @Published private(set) var entitlementLoadState: EntitlementLoadState = .idle
    @Published private(set) var products: [Product] = []
    @Published private(set) var purchaseState: PurchaseState = .idle
    @Published private(set) var hasLoadedProducts = false
    @Published var statusMessage: String?

    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "entitlements")
    private var entitlementRetryAttempts = 0
    private let maxEntitlementRetryAttempts = 3
    private var entitlementRetryTask: Task<Void, Never>?

    let plans: [SubscriptionPlan] = [
        SubscriptionPlan(
            tier: .free,
            title: "Free",
            detail: "Explore the product with a complete UI experience.",
            fallbackPrice: "$0"
        ),
        SubscriptionPlan(
            tier: .collector,
            title: "Collector",
            detail: "Best for active collectors tracking cards and comps every day.",
            fallbackPrice: "$9.99 / month"
        ),
        SubscriptionPlan(
            tier: .investor,
            title: "Investor",
            detail: "Full access to trends, advanced alerts, DailyIQ, and eBay integration.",
            fallbackPrice: "$19.99 / month"
        ),
        SubscriptionPlan(
            tier: .proSeller,
            title: "Pro Seller",
            detail: "Everything in Investor plus ERP reconciliation and unlimited alerts.",
            fallbackPrice: "$29.99 / month"
        ),
    ]

    private let storageKey = "com.hobbyiq.subscriptionTier"

    private let productIDsByTier: [AppAccessTier: String] = [
        .collector: "com.hobbyiq.collector.monthly",
        .investor: "com.hobbyiq.investor.monthly",
        .proSeller: "com.hobbyiq.proseller.monthly",
    ]

    private var updatesTask: Task<Void, Never>?
    private let api = APIService.shared

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
        await refreshEntitlementsFromBackend()
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
            setTier(.free)
            statusMessage = "\(tier.title) is not available right now. Free access remains enabled."
            return
        }

        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verificationResult):
                await handlePurchaseResult(verificationResult)
            case .pending:
                statusMessage = "Purchase is pending approval."
            case .userCancelled:
                statusMessage = "Purchase canceled."
            @unknown default:
                statusMessage = "Purchase state is unavailable right now."
            }
        } catch {
            statusMessage = "Purchase failed. You can still continue with Free access."
        }
    }

    func restorePurchases() async {
        purchaseState = .restoring
        statusMessage = nil
        defer { purchaseState = .idle }

        do {
            try await AppStore.sync()

            // Verify any current entitlements the backend may not know about
            for await result in Transaction.currentEntitlements {
                guard case .verified(let transaction) = result else { continue }
                let jws = result.jwsRepresentation
                let response = try? await api.verifySubscription(jws: jws)
                if response?.success == true {
                    await transaction.finish()
                }
            }

            await refreshEntitlementsFromBackend()

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
        entitlementState = nil
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

    // MARK: - Entitlement Gating

    /// Tier to use for FEATURE GATING (`has` / `cap` / `.lockedOverlay`) only.
    /// Never `.none` — floors to `.free` so a transient entitlements-load blip
    /// cannot deny-all free-available surfaces. Paid features still rely on
    /// backend 402/403 enforcement, so the floor cannot wrongly UNLOCK
    /// anything — it only stops wrongly LOCKING free ones.
    ///
    /// Do NOT use this for launch / paywall routing — those must continue to
    /// read `currentTier` so a genuinely-new user with no cache still flows
    /// through the paywall on first launch.
    var effectiveGatingTier: AppAccessTier {
        currentTier == .none ? .free : currentTier
    }

    func has(_ feature: String) -> Bool {
        if let state = entitlementState {
            return state.features.contains(feature)
        }
        return TierMatrix.features[effectiveGatingTier]?.contains(feature) ?? false
    }

    func cap(for cap: GatedCap) -> CapValue {
        if let state = entitlementState {
            switch cap {
            case .priceChecksPerDay: return state.caps.priceChecksPerDay
            case .holdingsCap: return state.caps.holdingsCap
            case .scansPerMonth: return state.caps.scansPerMonth
            case .priceAlerts: return state.caps.priceAlerts
            }
        }
        return TierMatrix.caps[effectiveGatingTier]?[cap] ?? .limited(0)
    }

    func capAllows(_ cap: GatedCap, used: Int) -> Bool {
        switch self.cap(for: cap) {
        case .unlimited: return true
        case .limited(let limit): return used < limit
        }
    }

    func capLimit(_ cap: GatedCap) -> Int? {
        switch self.cap(for: cap) {
        case .unlimited: return nil
        case .limited(let limit): return limit
        }
    }

    // MARK: - Purchase Verification

    private func handlePurchaseResult(_ verificationResult: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = verificationResult else {
            statusMessage = "Purchase could not be verified."
            return
        }

        let jws = verificationResult.jwsRepresentation

        do {
            let verifyResponse = try await api.verifySubscription(jws: jws)
            guard verifyResponse.success else {
                statusMessage = verifyResponse.error ?? "Subscription verification failed."
                return
            }

            await transaction.finish()
            await refreshEntitlementsFromBackend()
            statusMessage = "\(currentTier.title) unlocked."
        } catch {
            statusMessage = verifyErrorMessage(from: error)
            // Transaction stays unfinished — Transaction.updates will retry
        }
    }

    // MARK: - Backend Entitlements

    /// Public entry point for "refresh now" recoveries (app foreground,
    /// pull-to-refresh, etc). Resets the retry counter so a previously
    /// exhausted retry chain can try again.
    func refreshEntitlementsFromForeground() async {
        guard AuthService.shared.isLoggedIn else { return }
        entitlementRetryAttempts = 0
        entitlementRetryTask?.cancel()
        entitlementRetryTask = nil
        await refreshEntitlementsFromBackend()
    }

    private func refreshEntitlementsFromBackend() async {
        guard AuthService.shared.isLoggedIn else { return }

        entitlementLoadState = .loading
        do {
            let response = try await api.fetchEntitlements()
            let tier = AppAccessTier(rawValue: response.plan) ?? .free
            entitlementState = EntitlementState(
                plan: tier,
                features: Set(response.features),
                caps: response.caps
            )
            setTier(tier)
            entitlementLoadState = .loaded
            entitlementRetryAttempts = 0
        } catch {
            // PRESERVATION GUARD: do NOT mutate currentTier here. A transient
            // failure must never downgrade a known user — currentTier already
            // holds the cached value restored from UserDefaults at init (or
            // the last successful setTier). Routing falls back to that cache
            // (paywall ONLY when truly no cache = brand-new user); gating
            // falls back via `effectiveGatingTier` (floors .none → .free).
            let message = (error as NSError).localizedDescription
            logger.error("entitlement load failed: \(message, privacy: .public)")
            entitlementLoadState = .failed(message)
            scheduleEntitlementRetry()
        }
    }

    /// Retries the entitlements fetch with 1s, 2s, 4s backoff up to
    /// `maxEntitlementRetryAttempts`. After the chain exhausts, settles into
    /// `.failed` and stops — foreground refresh is the recovery path.
    private func scheduleEntitlementRetry() {
        guard entitlementRetryAttempts < maxEntitlementRetryAttempts else {
            logger.error("entitlement retry attempts exhausted; settled into failed state until next foreground")
            return
        }
        let attempt = entitlementRetryAttempts
        entitlementRetryAttempts += 1
        let delaySeconds = pow(2.0, Double(attempt))  // 1, 2, 4
        entitlementRetryTask?.cancel()
        entitlementRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.refreshEntitlementsFromBackend()
        }
    }

    private func verifyAndRefreshTransaction(_ verificationResult: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = verificationResult else { return }

        let jws = verificationResult.jwsRepresentation
        do {
            let verifyResponse = try await api.verifySubscription(jws: jws)
            guard verifyResponse.success else { return }
            await transaction.finish()
            await refreshEntitlementsFromBackend()
        } catch {
            // Transient failure — transaction stays unfinished, will retry via Transaction.updates
        }
    }

    // MARK: - Private

    private func loadProducts() async {
        guard !hasLoadedProducts else { return }

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

    private func observeTransactionUpdates() -> Task<Void, Never> {
        Task {
            for await update in Transaction.updates {
                await verifyAndRefreshTransaction(update)
            }
        }
    }

    private func setTier(_ tier: AppAccessTier) {
        currentTier = tier
        UserDefaults.standard.set(tier.rawValue, forKey: storageKey)
    }

    private func verifyErrorMessage(from error: Error) -> String {
        if let apiError = error as? APIServiceError,
           case .httpError(let code, _) = apiError {
            switch code {
            case 422:
                return "This subscription could not be recognized. Contact support if this persists."
            case 502, 503:
                return "Apple's verification service is temporarily unavailable. Try again shortly."
            default:
                return APIService.errorMessage(from: error)
            }
        }
        return "Verification failed. Your purchase is safe — try restoring purchases."
    }
}
