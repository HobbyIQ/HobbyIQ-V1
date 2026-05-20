//
//  ProfitListView.swift
//  HobbyIQ
//

import SwiftUI

struct ProfitListView: View {
    @StateObject private var viewModel = ProfitIQViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ProfitIQ")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(AppColors.textPrimary)
                    Text("Simple next steps for cards in your portfolio.")
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)
                }

                if viewModel.isLoading && viewModel.cards.isEmpty {
                    LoadingStateView(title: "Loading ProfitIQ...", message: "Checking every active card in your portfolio.")
                } else if let errorMessage = viewModel.errorMessage, viewModel.cards.isEmpty {
                    HobbyIQErrorStateView(
                        title: "Could not load ProfitIQ",
                        message: errorMessage,
                        retry: { Task { await viewModel.refresh() } }
                    )
                } else if groupedCards.isEmpty {
                    HobbyIQEmptyStateView(
                        title: "No ProfitIQ cards yet",
                        message: "Add inventory to see what to sell, watch, or hold.",
                        systemImage: "chart.line.uptrend.xyaxis"
                    )
                } else {
                    if let errorMessage = viewModel.errorMessage {
                        HobbyIQErrorStateView(
                            title: "ProfitIQ needs another try",
                            message: errorMessage,
                            retry: { Task { await viewModel.refresh() } }
                        )
                    }

                    ForEach(groupedCards, id: \.title) { group in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(group.title)
                                .font(.headline)
                                .foregroundStyle(AppColors.textPrimary)

                            ForEach(group.cards) { card in
                                NavigationLink {
                                    ProfitIQCardDetailView(viewModel: viewModel, card: card)
                                } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(card.playerName)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(AppColors.textPrimary)
                                            Text(card.cardName)
                                                .font(.caption)
                                                .foregroundStyle(AppColors.textSecondary)
                                            HStack(spacing: 6) {
                                                signalBadge(title: card.signal.displayTitle, color: signalColor(for: card.signal))
                                                Text(card.roi.portfolioPercentString)
                                                    .font(.caption.weight(.semibold))
                                                    .foregroundStyle(AppColors.textMuted)
                                            }
                                        }

                                        Spacer()

                                        VStack(alignment: .trailing, spacing: 4) {
                                            Text(card.profitLoss.portfolioSignedCurrencyString)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(profitColor(for: card.profitLoss))
                                            Text(card.listPrice.portfolioCurrencyString)
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(AppColors.textMuted)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .appCardStyle(background: AppColors.backgroundElevated, radius: AppCardRadius.large)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Portfolio")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task {
            await viewModel.load()
        }
    }

    private var groupedCards: [(title: String, cards: [ProfitIQCardResult])] {
        [
            ("Sell Now", viewModel.cards.filter { $0.signal == .sellNow }),
            ("Watch", viewModel.cards.filter { $0.signal == .watch }),
            ("Hold", viewModel.cards.filter { $0.signal == .hold }),
            ("CompIQ", viewModel.cards.filter { $0.signal == .compIQ })
        ].filter { $0.cards.isEmpty == false }
    }

    private func signalBadge(title: String, color: Color) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }

    private func signalColor(for signal: SellSignal) -> Color {
        switch signal {
        case .sellNow, .compIQ:
            return AppColors.danger
        case .watch:
            return .orange
        case .hold:
            return AppColors.accent
        }
    }

    private func profitColor(for value: Double) -> Color {
        if value > 0 { return AppColors.accent }
        if value < 0 { return .red }
        return AppColors.textMuted
    }
}
