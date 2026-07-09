//
//  MarketTrendView.swift
//  HobbyIQ
//

import SwiftUI

struct MarketTrendView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var showUpgradePaywall = false
    @State private var topMoversResponse: TopMoversResponse?
    @State private var isLoadingMovers = false
    @State private var selectedWindow = "7d"
    @State private var playerSearch = ""
    @State private var singleTrend: MarketTrendResponse?
    @State private var isLoadingSingle = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private let windows = ["1d", "7d", "30d"]

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                heroCard
                windowPicker

                if let error {
                    errorBanner(error)
                }

                topMoversSection
                playerSearchSection
                singleTrendSection
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Back")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.marketTrendIndexes,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.marketTrendIndexes)
            )
        }
        .task { await loadTopMovers() }
        .onChange(of: selectedWindow) { _, _ in
            Task { await loadTopMovers() }
        }
    }

    // MARK: - Hero

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Market Trends")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Track market momentum across players and segments.")
                .font(HobbyIQTheme.Typography.body)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.18), radius: 18, x: 0, y: 10)
    }

    // MARK: - Window Picker

    private var windowPicker: some View {
        HStack(spacing: 6) {
            ForEach(windows, id: \.self) { window in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selectedWindow = window
                    }
                } label: {
                    Text(window)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(
                            selectedWindow == window
                                ? HobbyIQTheme.Colors.pureWhite
                                : HobbyIQTheme.Colors.mutedText
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(
                            selectedWindow == window
                                ? HobbyIQTheme.Colors.electricBlue
                                : HobbyIQTheme.Colors.steelGray.opacity(0.4)
                        )
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.8))
        .clipShape(Capsule())
    }

    // MARK: - Top Movers

    @ViewBuilder
    private var topMoversSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "flame.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(Labels.topMovers)
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let pool = topMoversResponse?.poolSize {
                    HStack(spacing: 4) {
                        Text("\(pool) tracked")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        HIQHelpButton(
                            title: "Pool Size",
                            message: "How many players we're actively tracking sales data for in this window. A larger pool means the movers list is being chosen from a wider set."
                        )
                    }
                }
            }

            if isLoadingMovers {
                HStack(spacing: 12) {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    Text("Loading movers...")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                }
            }

            if let window = topMoversResponse?.window, let label = window.pct30dLabel {
                Text(label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let movers = topMoversResponse?.movers, !movers.isEmpty {
                ForEach(movers) { mover in
                    moverRow(mover)
                }
            } else if !isLoadingMovers {
                Text("No movers available for this window.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func moverRow(_ mover: TopMover) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(mover.playerName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                if let conf = mover.confidence {
                    HStack(spacing: 4) {
                        Text(conf)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                            .clipShape(Capsule())
                        HIQHelpButton(
                            title: "Confidence",
                            message: "How much we trust this trend signal based on sample size, recency, and price consistency. \"Very High\" / \"High\" are most reliable; \"Low\" means lighter evidence."
                        )
                    }
                }
            }

            if let delta = mover.delta {
                deltaRow(delta)
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func deltaRow(_ delta: MarketDelta) -> some View {
        HStack(spacing: 16) {
            if let pct1d = delta.pct1d {
                deltaPill(label: "1d", value: pct1d)
            }
            if let pct7d = delta.pct7d {
                deltaPill(label: "7d", value: pct7d)
            }
            if let pct30d = delta.pct30d {
                deltaPill(label: "30d", value: pct30d)
            }
            Spacer()
            if let vol = delta.volume7d {
                VStack(spacing: 2) {
                    Text("Vol 7d")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("\(vol)")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
        }
    }

    private func deltaPill(label: String, value: Double) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(String(format: "%+.1f%%", value))
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(deltaColor(value))
        }
    }

    private func deltaColor(_ value: Double) -> Color {
        if value > 0 { return HobbyIQTheme.Colors.successGreen }
        if value < 0 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    // MARK: - Player Search

    private var playerSearchSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("Player Trend")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            HobbyIQSearchField(text: $playerSearch, placeholder: "Player name...")
                .onSubmit { Task { await searchPlayerTrend() } }

            HIQPrimaryButton(title: isLoadingSingle ? "Loading..." : "Look Up", systemImage: "chart.line.uptrend.xyaxis") {
                Task { await searchPlayerTrend() }
            }
            .disabled(playerSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoadingSingle)
            .opacity(playerSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.6 : 1)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    // MARK: - Single Trend Result

    @ViewBuilder
    private var singleTrendSection: some View {
        if let trend = singleTrend {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "chart.bar.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text(trend.playerName ?? "Player")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    if let conf = trend.confidence {
                        HStack(spacing: 4) {
                            Text(conf)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                                .clipShape(Capsule())
                            HIQHelpButton(
                                title: "Confidence",
                                message: "How much we trust this trend signal based on sample size, recency, and price consistency. \"Very High\" / \"High\" are most reliable; \"Low\" means lighter evidence."
                            )
                        }
                    }
                }

                if let delta = trend.delta {
                    deltaRow(delta)

                    if let avg1d = delta.avg1d {
                        trendDataRow(label: "Avg 1d", value: avg1d.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                    }
                    if let avg7d = delta.avg7d {
                        trendDataRow(label: "Avg 7d", value: avg7d.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                    }
                    if let avg30d = delta.avg30d {
                        trendDataRow(label: "Avg 30d", value: avg30d.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                    }
                    if let vol1d = delta.volume1d {
                        trendDataRow(label: "Volume 1d", value: "\(vol1d)")
                    }
                    if let vol7d = delta.volume7d {
                        trendDataRow(label: "Volume 7d", value: "\(vol7d)")
                    }
                    if let vol30d = delta.volume30d {
                        trendDataRow(label: "Volume 30d", value: "\(vol30d)")
                    }
                }

                if let window = trend.window, let label = window.pct30dLabel {
                    trendDataRow(label: "Window", value: label)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    private func trendDataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.danger)
            Text(message)
                .font(.footnote)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.danger.opacity(0.25))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Data Loading

    private func loadTopMovers() async {
        isLoadingMovers = true
        error = nil
        defer { isLoadingMovers = false }

        do {
            topMoversResponse = try await APIService.shared.fetchTopMovers(window: selectedWindow)
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    private func searchPlayerTrend() async {
        let trimmed = playerSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isLoadingSingle = true
        error = nil
        defer { isLoadingSingle = false }

        do {
            singleTrend = try await APIService.shared.fetchMarketTrend(playerName: trimmed)
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

#Preview {
    NavigationStack {
        MarketTrendView()
    }
    .environmentObject(AppSessionViewModel())
    .preferredColorScheme(.dark)
}
