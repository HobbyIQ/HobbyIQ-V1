// SubscriptionManager.swift
// HobbyIQ StoreKit 2 Subscription Layer
// Supports: hobbyiq.pro, hobbyiq.allstar (auto-renewable)
// No Stripe, no backend billing

import Foundation
import StoreKit

@MainActor
class SubscriptionManager: ObservableObject {
    static let shared = SubscriptionManager()
    
    // Product IDs
    private let proProductID = "hobbyiq.pro"
    private let allStarProductID = "hobbyiq.allstar"
    
    // Published properties for UI
    @Published var availableProducts: [Product] = []
    @Published var currentTier: HobbyIQTier = .free
    @Published var purchasedProductIDs: Set<String> = []
    
    private init() { }
    
    // Load products from StoreKit
    func loadProducts() async {
        do {
            let storeProducts = try await Product.products(for: [proProductID, allStarProductID])
            availableProducts = storeProducts
        } catch {
            print("Failed to load products: \(error)")
        }
    }
    
    // Purchase a product
    func purchase(_ product: Product) async -> Bool {
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await updateEntitlement()
                    await transaction.finish()
                    return true
                default:
                    return false
                }
            default:
                return false
            }
        } catch {
            print("Purchase failed: \(error)")
            return false
        }
    }
    
    // Restore purchases
    func restorePurchases() async {
        for await _ in Transaction.currentEntitlements {
            // Just iterating triggers entitlement update
        }
        await updateEntitlement()
    }
    
    // Update current tier based on active entitlements
    func updateEntitlement() async {
        var activeIDs = Set<String>()
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result,
               transaction.revocationDate == nil,
               transaction.expirationDate == nil || (transaction.expirationDate != nil && transaction.expirationDate! > Date()) {
                activeIDs.insert(transaction.productID)
            }
        }
        purchasedProductIDs = activeIDs
        if activeIDs.contains(allStarProductID) {
            currentTier = .allStar
        } else if activeIDs.contains(proProductID) {
            currentTier = .pro
        } else {
            currentTier = .free
        }
    }
}

// HobbyIQTier enum
enum HobbyIQTier: String {
    case free = "FREE"
    case pro = "PRO"
    case allStar = "ALL_STAR"
}
