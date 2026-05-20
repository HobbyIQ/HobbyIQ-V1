//
//  PaywallView.swift
//  HobbyIQ
//

import SwiftUI

struct PaywallView: View {
    @ObservedObject var sessionViewModel: AppSessionViewModel
    @State private var selectedTier: SubscriptionTier = .pro

    var body: some View {
        ZStack {
            HobbyIQBackground()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 24) {
                    Spacer(minLength: 24)

                    VStack(spacing: 12) {
                        HobbyIQLogoView(size: 68)

                        Text("Unlock HobbyIQ")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)

                        Text("Get into card decisions, player reads, DailyIQ, and portfolio tracking with one clean subscription.")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.textSecondary)
                            .multilineTextAlignment(.center)
                    }

                    HobbyIQSurfaceCard(background: HobbyIQTheme.bgSecondary) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("What you get")
                                .font(.headline)
                                .foregroundStyle(.white)

                            paywallFeature("CompIQ card decisions")
                            paywallFeature("PlayerIQ market view")
                            paywallFeature("DailyIQ prospect movers")
                            paywallFeature("PortfolioIQ tracking")
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Choose your access")
                            .font(.headline)
                            .foregroundStyle(.white)

                        VStack(spacing: 12) {
                            ForEach(SubscriptionTier.allCases) { tier in
                                paywallTierCard(tier)
                                    .onTapGesture {
                                        withAnimation(.easeInOut(duration: 0.18)) {
                                            selectedTier = tier
                                        }
                                    }
                            }
                        }
                    }

                    VStack(spacing: 12) {
                        Button {
                            Task { await sessionViewModel.purchase(selectedTier) }
                        } label: {
                            Text(selectedTier == .free ? "Continue with Free" : "Continue with \(selectedTier.title)")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(sessionViewModel.isLoading)

                        Button("Restore Purchases") {
                            Task { await sessionViewModel.restorePurchases() }
                        }
                        .buttonStyle(SecondaryButton())
                        .disabled(sessionViewModel.isLoading)

                        Button("Log Out") {
                            Task { await sessionViewModel.signOut() }
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                        .buttonStyle(.plain)
                    }

                    if let errorMessage = sessionViewModel.errorMessage {
                        ErrorStateView(title: "Access unavailable", message: errorMessage, retryTitle: "Try Again") {
                            sessionViewModel.resetError()
                        }
                    }

                    Text("Subscriptions are managed by Apple. Restore Purchases to recover access.")
                        .font(.footnote)
                        .foregroundStyle(HobbyIQTheme.textMuted)
                        .multilineTextAlignment(.center)

                    Text("Terms • Privacy • Subscriptions handled by Apple")
                        .font(.footnote)
                        .foregroundStyle(HobbyIQTheme.textSecondary)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
    }

    private func paywallFeature(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(HobbyIQTheme.green)

            Text(text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)

            Spacer()
        }
    }

    private func paywallTierCard(_ tier: SubscriptionTier) -> some View {
        let isSelected = selectedTier == tier

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(tier.title)
                    .font(.headline)
                    .foregroundStyle(.white)

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(tier == .allStar ? .yellow : HobbyIQTheme.green)
                }
            }

            Text(tier.priceText)
                .font(.title3.bold())
                .foregroundStyle(.white)

            Text(tier.headline)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(isSelected ? HobbyIQTheme.cardElevated : HobbyIQTheme.card)
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(isSelected ? (tier == .allStar ? Color.yellow.opacity(0.5) : HobbyIQTheme.green.opacity(0.5)) : HobbyIQTheme.stroke, lineWidth: 1.6)
        )
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

#Preview {
    PaywallView(sessionViewModel: AppSessionViewModel())
}
