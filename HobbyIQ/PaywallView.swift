//
//  PaywallView.swift
//  HobbyIQ
//

import SwiftUI

struct PaywallView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    var suggestedTier: AppAccessTier? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var selectedTier: AppAccessTier = .collector

    private var subscriptionManager: SubscriptionManager {
        sessionViewModel.subscriptionManager
    }

    var body: some View {
        ZStack {
            HobbyIQBackground()

            if !subscriptionManager.hasLoadedProducts && subscriptionManager.purchaseState == .loadingProducts {
                loadingState
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 24) {
                        Spacer(minLength: 24)
                        headerSection
                        tierCardsSection
                        actionSection

                        if let errorMessage = sessionViewModel.errorMessage {
                            ErrorStateView(title: "Something went wrong", message: errorMessage, retryTitle: "Try Again") {
                                sessionViewModel.resetError()
                            }
                        }

                        footerSection
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 24)
                }
            }
        }
        .task {
            // CF-LAUNCH-DEFER-STOREKIT (2026-06-12): products are now loaded
            // here just-in-time instead of at launch. Run both in parallel —
            // they're independent (StoreKit vs our /api/entitlements).
            async let entitlements: () = subscriptionManager.prepare()
            async let products: () = subscriptionManager.loadProductsIfNeeded()
            _ = await (entitlements, products)
        }
        .onAppear {
            if let suggested = suggestedTier, suggested.rank > subscriptionManager.currentTier.rank {
                selectedTier = suggested
            } else if subscriptionManager.currentTier.rank >= AppAccessTier.collector.rank {
                let next: AppAccessTier = {
                    switch subscriptionManager.currentTier {
                    case .collector: return .investor
                    case .investor: return .proSeller
                    default: return .collector
                    }
                }()
                selectedTier = next
            } else {
                selectedTier = .collector
            }
        }
    }

    // MARK: - Loading

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .tint(HobbyIQTheme.Colors.electricBlue)
                .scaleEffect(1.2)
            Text("Loading plans...")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: 12) {
            HobbyIQLogoView(size: 68)

            Text(subscriptionManager.currentTier.rank >= AppAccessTier.collector.rank ? "Upgrade Your Plan" : "Unlock HobbyIQ")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            Text("Choose the plan that fits your collecting style.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Tier Cards

    private var tierCardsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose your access")
                .font(.headline)
                .foregroundStyle(.white)

            VStack(spacing: 12) {
                ForEach(subscriptionManager.plans) { plan in
                    paywallTierCard(plan)
                        .onTapGesture {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                selectedTier = plan.tier
                            }
                        }
                }
            }
        }
    }

    // MARK: - Actions

    private var actionSection: some View {
        let isCurrent = selectedTier == subscriptionManager.currentTier
            && selectedTier != .none && selectedTier != .free

        return VStack(spacing: 12) {
            Button {
                if isCurrent {
                    if let url = subscriptionManager.appStoreSubscriptionsURL {
                        UIApplication.shared.open(url)
                    }
                } else {
                    Task {
                        await sessionViewModel.purchase(selectedTier)
                        if subscriptionManager.currentTier.rank >= selectedTier.rank {
                            dismiss()
                        }
                    }
                }
            } label: {
                Text(buttonLabel(for: selectedTier, isCurrent: isCurrent))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(sessionViewModel.isLoading)

            Button("Restore Purchases") {
                Task {
                    await sessionViewModel.restorePurchases()
                    if subscriptionManager.currentTier != .none {
                        dismiss()
                    }
                }
            }
            .buttonStyle(SecondaryButton())
            .disabled(sessionViewModel.isLoading)

            if subscriptionManager.currentTier.rank >= AppAccessTier.collector.rank {
                Button("Manage Subscription") {
                    if let url = subscriptionManager.appStoreSubscriptionsURL {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .buttonStyle(.plain)
            } else {
                Button("Log Out") {
                    Task { await sessionViewModel.signOut() }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.textSecondary)
                .buttonStyle(.plain)
            }
        }
    }

    private var footerSection: some View {
        VStack(spacing: 8) {
            Text("Subscriptions are managed by Apple. Restore Purchases to recover access.")
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.textMuted)
                .multilineTextAlignment(.center)

            Text("Terms • Privacy • Subscriptions handled by Apple")
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
    }

    // MARK: - Helpers

    private func buttonLabel(for tier: AppAccessTier, isCurrent: Bool) -> String {
        if isCurrent { return "Manage \(tier.title)" }
        if tier == .free { return "Continue with Free" }
        return "Continue with \(tier.title)"
    }

    private func paywallTierCard(_ plan: SubscriptionPlan) -> some View {
        let isSelected = selectedTier == plan.tier
        let isTopTier = plan.tier == .proSeller
        let isCurrent = plan.tier == subscriptionManager.currentTier
            && plan.tier != .free && plan.tier != .none
        let highlights = TierMatrix.highlights(for: plan.tier)

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(plan.title)
                    .font(.headline)
                    .foregroundStyle(.white)

                if isCurrent {
                    Text("CURRENT")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                        .clipShape(Capsule())
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(isTopTier ? .yellow : HobbyIQTheme.green)
                }
            }

            Text(subscriptionManager.priceText(for: plan.tier))
                .font(.title3.bold())
                .foregroundStyle(.white)

            Text(plan.detail)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)

            if isSelected && !highlights.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(highlights, id: \.self) { highlight in
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.green)
                            Text(highlight)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.textSecondary)
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(isSelected ? HobbyIQTheme.cardElevated : HobbyIQTheme.card)
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(isSelected ? (isTopTier ? Color.yellow.opacity(0.5) : HobbyIQTheme.green.opacity(0.5)) : HobbyIQTheme.stroke, lineWidth: 1.6)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

// MARK: - Reusable Entitlement Gating UI

struct LockedFeatureOverlay: View {
    let feature: String
    let upgradeAction: () -> Void

    private var requiredTier: AppAccessTier {
        GatedFeature.minimumTier(for: feature)
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.fill")
                .font(.system(size: 28))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Text("Requires \(requiredTier.title)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.center)

            Button(action: upgradeAction) {
                Text("Upgrade to \(requiredTier.title)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.appBackground)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(HobbyIQTheme.Colors.electricBlue)
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(HobbyIQTheme.Colors.appBackground.opacity(0.88))
    }
}

struct CapLimitBanner: View {
    let cap: GatedCap
    let used: Int
    let subscriptionManager: SubscriptionManager
    let upgradeAction: () -> Void

    private var limit: Int? { subscriptionManager.capLimit(cap) }
    private var atLimit: Bool {
        guard let limit else { return false }
        return used >= limit
    }
    private var upgradeTier: AppAccessTier? {
        cap.upgradeTier(from: subscriptionManager.currentTier)
    }

    var body: some View {
        if let limit {
            HStack(spacing: 10) {
                Image(systemName: atLimit ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.33percent")
                    .foregroundStyle(atLimit ? HobbyIQTheme.Colors.danger : HobbyIQTheme.Colors.electricBlue)

                VStack(alignment: .leading, spacing: 2) {
                    Text("\(cap.displayName): \(used) of \(limit)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    if atLimit, let tier = upgradeTier {
                        Text("Upgrade to \(tier.title) for more")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }

                Spacer()

                if atLimit, upgradeTier != nil {
                    Button(action: upgradeAction) {
                        Text("Upgrade")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .overlay(Capsule().stroke(HobbyIQTheme.Colors.electricBlue, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}

extension View {
    func lockedOverlay(
        feature: String,
        subscriptionManager: SubscriptionManager,
        upgradeAction: @escaping () -> Void
    ) -> some View {
        self.overlay {
            if !subscriptionManager.has(feature) {
                LockedFeatureOverlay(feature: feature, upgradeAction: upgradeAction)
            }
        }
    }
}

#Preview {
    PaywallView(sessionViewModel: AppSessionViewModel())
}
