// SubscriptionView.swift
// HobbyIQ Apple In-App Subscription UI (SwiftUI)
// 3 tiers: FREE, PRO (Most Popular), ALL-STAR
// StoreKit 2 purchase flow only

import SwiftUI
import StoreKit

// Helper: Remove duplicates from array
extension Array where Element: Hashable {
    func removingDuplicates() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

struct SubscriptionView: View {
    @StateObject private var manager = SubscriptionManager.shared


    var body: some View {
        VStack(spacing: 28) {
            Text("Choose Your HobbyIQ Plan")
                .font(.title.bold())
                .foregroundColor(Color.cyan)
                .padding(.top, 24)

            // Tiers
            VStack(spacing: 18) {
                tierCard(
                    name: "FREE",
                    price: "$0",
                    features: ["3 searches/day", "Limited portfolio"].removingDuplicates(),
                    highlight: nil,
                    isCurrent: manager.currentTier == .free,
                    purchaseAction: nil
                )
                tierCard(
                    name: "PRO",
                    price: "$19.99/mo",
                    features: ["Unlimited searches", "Full analyzer", "Portfolio tracking", "Basic alerts"].removingDuplicates(),
                    highlight: "Most Popular",
                    isCurrent: manager.currentTier == .pro,
                    purchaseAction: {
                        if let product = manager.availableProducts.first(where: { $0.id == "hobbyiq.pro" }) {
                            Task { _ = await manager.purchase(product) }
                        }
                    }
                )
                tierCard(
                    name: "ALL-STAR",
                    price: "$39.99/mo",
                    features: ["Everything in Pro", "Advanced alerts", "Deal Analyzer Pro", "Priority insights"].removingDuplicates(),
                    highlight: nil,
                    isCurrent: manager.currentTier == .allStar,
                    purchaseAction: {
                        if let product = manager.availableProducts.first(where: { $0.id == "hobbyiq.allstar" }) {
                            Task { _ = await manager.purchase(product) }
                        }
                    }
                )
            }

            // Restore Purchases
            Button("Restore Purchases") {
                Task { await manager.restorePurchases() }
            }
            .font(.headline)
            .foregroundColor(.cyan)
            .padding(.top, 8)

            // Current Tier
            Text("Current Plan: \(manager.currentTier.rawValue)")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .padding(.top, 12)

            Spacer()
        }
        .padding(.horizontal, 20)
        .background(Color(.systemBackground))
        .onAppear {
            Task {
                await manager.loadProducts()
                await manager.updateEntitlement()
            }
        }
    }

    // MARK: - Tier Card
    @ViewBuilder
    private func tierCard(
        name: String,
        price: String,
        features: [String],
        highlight: String?,
        isCurrent: Bool,
        purchaseAction: (() -> Void)?
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(name)
                    .font(.headline)
                    .foregroundColor(.white)
                if let highlight = highlight {
                    Text(highlight)
                        .font(.caption.bold())
                        .foregroundColor(.black)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.cyan)
                        .cornerRadius(12)
                }
                Spacer()
            }
            Text(price)
                .font(.title2.bold())
                .foregroundColor(.cyan)
            // Defensive: Only show unique, non-empty features
            let uniqueFeatures = features.removingDuplicates().filter { !$0.isEmpty }
            if !uniqueFeatures.isEmpty {
                ForEach(uniqueFeatures, id: \.self) { feature in
                    Text("• \(feature)")
                        .foregroundColor(.white.opacity(0.85))
                        .font(.subheadline)
                }
            }
            if let purchaseAction = purchaseAction {
                Button(isCurrent ? "Current Plan" : "Subscribe with Apple") {
                    purchaseAction()
                }
                .disabled(isCurrent)
                .font(.headline)
                .foregroundColor(.white)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(isCurrent ? Color.gray : Color.cyan)
                .cornerRadius(10)
                .padding(.top, 8)
            } else {
                Button("Current Plan") {}
                    .disabled(true)
                    .font(.headline)
                    .foregroundColor(.white)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                    .background(Color.gray)
                    .cornerRadius(10)
                    .padding(.top, 8)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(18)
        .shadow(color: .black.opacity(0.08), radius: 8, x: 0, y: 4)
    }
}
