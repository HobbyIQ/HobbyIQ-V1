// StoreKitSubscriptionManager.swift
// HobbyIQ StoreKit 2 Subscription Manager
// Supports: hobbyiq.pro, hobbyiq.allstar (auto-renewable)
// No Stripe, no backend billing

import Foundation
import StoreKit

@MainActor
final class StoreKitSubscriptionManager: ObservableObject {
    static let shared = StoreKitSubscriptionManager()
    
    // MARK: - Product IDs
    private let proProductID = "hobbyiq.pro"
    private let allStarProductID = "hobbyiq.allstar"
    
    // MARK: - Published Properties
    @Published private(set) var products: [Product] = []
    @Published private(set) var currentTier: Tier = .free
    @Published private(set) var isLoading: Bool = false
    
    // MARK: - Tier Enum
    enum Tier: String {
        case free = "FREE"
        case pro = "PRO"
        case allStar = "ALL_STAR"
    }
    
    private init() { }
    
    // MARK: - Load Products
    func loadProducts() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await Product.products(for: [proProductID, allStarProductID])
            products = loaded.sorted { $0.displayName < $1.displayName }
        } catch {
            print("[StoreKit] Failed to load products: \(error)")
            products = []
        }
    }
    
    // MARK: - Purchase
    func purchase(_ product: Product) async -> Bool {
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await refreshEntitlements()
                    await transaction.finish()
                    return true
                default:
                    return false
                }
            default:
                return false
            }
        } catch {
            print("[StoreKit] Purchase failed: \(error)")
            return false
        }
    }
    
    // MARK: - Restore Purchases
    func restorePurchases() async {
        for await _ in Transaction.currentEntitlements {
            // Just iterating triggers entitlement update
        }
        await refreshEntitlements()
    }
    
    // MARK: - Refresh Entitlements
    func refreshEntitlements() async {
        var activeIDs = Set<String>()
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.revocationDate == nil,
               transaction.expirationDate == nil || (transaction.expirationDate != nil && transaction.expirationDate! > Date()) {
                activeIDs.insert(transaction.productID)
            }
        }
        if activeIDs.contains(allStarProductID) {
            currentTier = .allStar
        } else if activeIDs.contains(proProductID) {
            currentTier = .pro
        } else {
            currentTier = .free
        }
    }
}
