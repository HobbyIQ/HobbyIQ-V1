// RestorePurchasesHelper.swift
// StoreKit 2 Restore Purchases and Entitlement Refresh for HobbyIQ
// No server validation, local only

import Foundation
import StoreKit

@MainActor
final class RestorePurchasesHelper: ObservableObject {
    static let shared = RestorePurchasesHelper()
    
    // Call this for Restore Purchases button
    func restorePurchases() async {
        do {
            try await AppStore.sync()
            await StoreKitSubscriptionManager.shared.refreshEntitlements()
        } catch {
            print("[StoreKit] Restore Purchases failed: \(error)")
        }
    }
    
    // Call this on app launch
    func refreshEntitlementsOnLaunch() async {
        await StoreKitSubscriptionManager.shared.refreshEntitlements()
    }
    
    // Observe subscription changes and update UI automatically
    func observeEntitlementChanges() {
        Task {
            for await _ in Transaction.updates {
                await StoreKitSubscriptionManager.shared.refreshEntitlements()
            }
        }
    }
}
