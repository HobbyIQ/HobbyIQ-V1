//
//  DashboardView.swift
//  HobbyIQ
//

import SwiftUI

struct DashboardView: View {
    @Binding var selectedTab: MainTab
    @StateObject private var viewModel = DashboardViewModel()
    @State private var showPortfolioPreview = false
    @State private var showDailyPreview = false
    @FocusState private var isAskFocused: Bool

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 18) {
                header
                askSection
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 32)
        }
        .background(HobbyIQTheme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .task {
            await viewModel.load()
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            HobbyIQLogoView(size: 42)

            VStack(alignment: .leading, spacing: 4) {
                Text("HobbyIQ")
                    .font(.title2.bold())
                    .foregroundStyle(.white)
                Text("Ask anything and get a quick snapshot of what matters.")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.textSecondary)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var askSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HobbyIQUniversalAskBar(text: $viewModel.askQuery, isLoading: viewModel.isSubmittingAsk) {
                submitAsk()
            }
            .focused($isAskFocused)

            if let askResponse = viewModel.askResponse, askResponse.isEmpty == false {
                HobbyIQSurfaceCard {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Quick Answer")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.green)
                        Text(askResponse)
                            .font(.subheadline)
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .loading:
            HobbyIQLoadingStateView(
                title: "Loading your snapshot",
                message: "This is where the live HobbyIQ home view will plug in later."
            )
        case .error(let message):
            HobbyIQErrorStateView(title: "Dashboard unavailable", message: message) {
                Task { await viewModel.load() }
            }
        case .loaded(let snapshot):
            VStack(spacing: 18) {
                snapshotSection(items: snapshot.snapshotItems)
                quickViewSection(insights: snapshot.insights, trends: snapshot.trends)
                previewSection(
                    title: "DailyIQ Preview",
                    subtitle: "A few names worth checking today.",
                    items: Array(snapshot.dailyPreview.prefix(3)),
                    actionTitle: "Open DailyIQ",
                    isExpanded: $showDailyPreview
                ) {
                    selectedTab = .daily
                }
                portfolioPreviewSection(snapshot.portfolioPreview)
                previewSection(
                    title: "CompIQ / PlayerIQ Preview",
                    subtitle: "A couple fast starting points.",
                    items: Array(snapshot.compPlayerPreview.prefix(2)),
                    actionTitle: "Open CompIQ",
                    isExpanded: .constant(true)
                ) {
                    selectedTab = .comp
                }
                quickActionsSection(actions: snapshot.quickActions)
            }
        }
    }

    private func snapshotSection(items: [DashboardSnapshotItem]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(title: "Snapshot", subtitle: "The fastest read on what matters right now.")

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 12),
                    GridItem(.flexible(), spacing: 12)
                ],
                spacing: 12
            ) {
                ForEach(items.prefix(4)) { item in
                    HobbyIQSnapshotCard(title: item.title, summary: item.summary, badge: item.badge)
                }
            }
        }
    }

    private func quickViewSection(insights: [DashboardInsight], trends: [DashboardTrend]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(title: "Today at a Glance", subtitle: "A simple read without too much noise.")

            VStack(spacing: 10) {
                ForEach(insights.prefix(3)) { insight in
                    HobbyIQPreviewRow(title: insight.title, subtitle: insight.summary, tag: insight.tone.badgeTitle)
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(trends.prefix(4)) { trend in
                        HobbyIQTrendChip(title: trend.title, value: trend.value)
                    }
                }
            }
        }
    }

    private func portfolioPreviewSection(_ preview: DashboardPortfolioPreview) -> some View {
        HobbyIQDisclosureSection(
            title: "PortfolioIQ Preview",
            subtitle: "A quick check on value, ROI, and cards needing attention.",
            isExpanded: $showPortfolioPreview
        ) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    PortfolioSummaryTile(title: "Value", value: preview.totalValue.currencyString)
                    PortfolioSummaryTile(title: "ROI", value: preview.roi.percentString)
                }

                if preview.attentionCards.isEmpty {
                    HobbyIQDetailRow(left: "Portfolio", right: "Nothing pressing")
                } else {
                    ForEach(preview.attentionCards.prefix(3)) { item in
                        HobbyIQPreviewRow(title: item.title, subtitle: item.subtitle, tag: item.tag)
                    }
                }

                Button {
                    selectedTab = .portfolio
                } label: {
                    Text("Open PortfolioIQ")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.green)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func previewSection(
        title: String,
        subtitle: String,
        items: [DashboardPreviewItem],
        actionTitle: String,
        isExpanded: Binding<Bool>,
        action: @escaping () -> Void
    ) -> some View {
        HobbyIQDisclosureSection(
            title: title,
            subtitle: subtitle,
            isExpanded: isExpanded
        ) {
            VStack(spacing: 12) {
                if items.isEmpty {
                    HobbyIQDetailRow(left: title, right: "Nothing to show yet")
                } else {
                    ForEach(items) { item in
                        HobbyIQPreviewRow(title: item.title, subtitle: item.subtitle, tag: item.tag)
                    }
                }

                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.green)
                    .buttonStyle(.plain)
            }
        }
    }

    private func quickActionsSection(actions: [DashboardQuickAction]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader(title: "Quick Actions", subtitle: "Fast shortcuts into the rest of the app.")

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 12),
                    GridItem(.flexible(), spacing: 12)
                ],
                spacing: 12
            ) {
                ForEach(actions) { action in
                    HobbyIQQuickActionCard(
                        title: action.title,
                        subtitle: action.subtitle,
                        systemName: action.systemName
                    ) {
                        handleQuickAction(action.id)
                    }
                }
            }
        }
    }

    private func sectionHeader(title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.title3.bold())
                .foregroundStyle(.white)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func submitAsk() {
        isAskFocused = false
        Task { await viewModel.submitAsk() }
    }

    private func handleQuickAction(_ id: String) {
        switch id {
        case "search-card":
            selectedTab = .comp
        case "search-player":
            selectedTab = .player
        case "daily-brief":
            selectedTab = .daily
        case "add-card":
            selectedTab = .portfolio
        default:
            break
        }
    }
}

#Preview {
    NavigationStack {
        DashboardView(selectedTab: .constant(.dashboard))
    }
}
