//
//  ActionIQView.swift
//  HobbyIQ
//

import SwiftUI

struct ActionIQView: View {
    @StateObject private var sessionViewModel = AppSessionViewModel()
    @State private var plan: ActionIQPlan?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 16) {
                header
                refreshButton
                stateBanner
                if let plan {
                    summaryCard(plan)
                    actionSection(title: "Sell Now", subtitle: "Move these first.", cards: plan.sellNow, accent: AppColors.danger)
                    actionSection(title: "Watch", subtitle: "Keep an eye on these.", cards: plan.watch, accent: HobbyIQTheme.Colors.warning)
                    actionSection(title: "Hold", subtitle: "Wait for a better spot.", cards: plan.hold, accent: AppColors.accent)
                }
            }
            .padding(AppSpacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("ActionIQ")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    AccountView(sessionViewModel: sessionViewModel)
                } label: {
                    Image(systemName: "person.crop.circle")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(AppColors.textPrimary)
                        .frame(width: 34, height: 34)
                        .background(AppColors.surfaceElevated)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .task {
            await loadPlan()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What Should I Do?")
                .font(.largeTitle.bold())
                .foregroundStyle(AppColors.textPrimary)

            Text(plan?.headline ?? "Fast answers for the hobby")
                .font(.subheadline)
                .foregroundStyle(AppColors.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var refreshButton: some View {
        Button {
            Task { await loadPlan() }
        } label: {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView()
                        .tint(AppColors.background)
                }
                Text(isLoading ? "Checking..." : "Refresh Plan")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(AppColors.background)
            .background(AppColors.accent)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .disabled(isLoading)
    }

    @ViewBuilder
    private var stateBanner: some View {
        if let errorMessage {
            VStack(alignment: .leading, spacing: 8) {
                Text("Could not load your action plan.")
                    .font(.headline)
                    .foregroundStyle(AppColors.textPrimary)
                Text(errorMessage)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(AppColors.danger.opacity(0.14))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(AppColors.danger.opacity(0.28), lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }

        if isLoading {
            LoadingStateView(
                title: "Checking action plan...",
                message: "Looking for the best sell, watch, and hold ideas."
            )
        }
    }

    private func summaryCard(_ plan: ActionIQPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Plan Snapshot")
                .font(.headline)
                .foregroundStyle(AppColors.textPrimary)

            Text(updatedText(from: plan.generatedAt))
                .font(.caption)
                .foregroundStyle(AppColors.textMuted)

            HStack(spacing: 12) {
                actionStat(title: "Sell Now", value: plan.sellNow.count, color: AppColors.danger)
                actionStat(title: "Watch", value: plan.watch.count, color: HobbyIQTheme.Colors.warning)
                actionStat(title: "Hold", value: plan.hold.count, color: AppColors.accent)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(AppColors.backgroundElevated)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func actionStat(title: String, value: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            Text("\(value)")
                .font(.title3.weight(.bold))
                .foregroundStyle(AppColors.textPrimary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppColors.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func actionSection(title: String, subtitle: String, cards: [ActionIQCard], accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(AppColors.textPrimary)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.textSecondary)
            }

            if cards.isEmpty {
                HobbyIQEmptyStateView(
                    title: "Nothing here right now.",
                    message: "This section will fill as the plan updates.",
                    systemImage: "tray"
                )
            } else {
                VStack(spacing: 12) {
                    ForEach(cards) { card in
                        ActionIQCardRow(card: card, accent: accent)
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(AppColors.backgroundElevated)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func loadPlan() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            plan = try await APIService.shared.fetchActionPlan(userId: AuthService.shared.userId ?? "")
        } catch {
            errorMessage = "Could not load your action plan."
            #if DEBUG
            print("ActionIQ error:", error)
            #endif
        }
    }

    private func updatedText(from rawValue: String) -> String {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: rawValue) {
            return "Updated: \(date.formatted(date: .abbreviated, time: .shortened))"
        }
        return "Updated: just now"
    }
}

private struct ActionIQCardRow: View {
    let card: ActionIQCard
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.playerName)
                        .font(.headline)
                        .foregroundStyle(AppColors.textPrimary)
                    Text(card.cardName)
                        .font(.subheadline)
                        .foregroundStyle(AppColors.textSecondary)
                }

                Spacer()

                Text(card.roi.portfolioPercentString)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(card.roi >= 0 ? accent : AppColors.danger)
            }

            HStack {
                Text("Value")
                    .foregroundStyle(AppColors.textMuted)
                Spacer()
                Text(card.currentValue.portfolioCurrencyString)
                    .foregroundStyle(AppColors.textPrimary)
                    .fontWeight(.semibold)
            }

            if let listPrice = card.listPrice {
                HStack {
                    Text("List")
                        .foregroundStyle(AppColors.textMuted)
                    Spacer()
                    Text(listPrice.portfolioCurrencyString)
                        .foregroundStyle(accent)
                        .fontWeight(.semibold)
                }
            }

            if let reasoning = card.reasoning, reasoning.isEmpty == false {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(reasoning.prefix(2).enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•")
                                .foregroundStyle(accent)
                            Text(line)
                                .foregroundStyle(AppColors.textSecondary)
                            Spacer()
                        }
                        .font(.footnote)
                    }
                }
                .padding(12)
                .background(AppColors.surfaceElevated)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(AppColors.surface)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}
