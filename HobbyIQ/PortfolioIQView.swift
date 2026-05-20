//
//  PortfolioIQView.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

struct PortfolioIQView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    let onSwitchToInventory: (PortfolioInventoryFilter) -> Void

    @State private var selectedCard: InventoryCard?
    @State private var showingLedger = false
    @State private var selectedPeriod: PerformancePeriod = .month

    var body: some View {
        NavigationView {
            ZStack {
                background

                if vm.summary == nil && vm.isLoading {
                    loadingState
                } else if vm.summary == nil, let errorMessage = vm.errorMessage {
                    errorState(message: errorMessage)
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(spacing: 16) {
                            header

                            if let errorMessage = vm.errorMessage {
                                warningBanner(message: errorMessage)
                            }

                            performanceSection
                            priorityActionsSection
                            topMoversSection
                        }
                        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                        .padding(.top, 8)
                        .padding(.bottom, 24)
                    }
                    .refreshable {
                        await vm.refresh()
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 88)
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingLedger) {
                PortfolioLedgerSheet(entries: vm.ledgerEntries)
            }
            .sheet(item: $selectedCard) { card in
                PortfolioHoldingDetailSheet(
                    viewModel: vm,
                    card: card,
                    onUpdated: {
                        Task { await vm.refresh() }
                    }
                )
            }
            .onAppear {
                if vm.summary == nil {
                    Task { await vm.load() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var background: some View {
        HobbyIQBackground()
    }

    private var loadingState: some View {
        ProgressView()
            .tint(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.orange)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Color(hex: 0xD1D5DB))
                .multilineTextAlignment(.center)

            Button("Retry") {
                Task { await vm.load() }
            }
            .buttonStyle(.bordered)
            .tint(Color(hex: 0x3B82F6))
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Hero Card

    private var header: some View {
        let summary = vm.heroSummary
        let pnlColor: Color = summary.unrealizedPnL >= 0 ? .green : .red

        return VStack(spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("PortfolioIQ")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    HStack(spacing: 6) {
                        Circle()
                            .fill(HobbyIQTheme.Colors.hobbyGreen)
                            .frame(width: 7, height: 7)
                        Text(vm.heroSummary.lastRefreshText)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                }

                Spacer()

                Button {
                    showingLedger = true
                } label: {
                    Image(systemName: "book.closed")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(width: 34, height: 34)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                        )
                }
                .buttonStyle(.plain)
            }

            // Hero value
            VStack(spacing: 6) {
                Text(summary.totalValue.portfolioCurrencyText)
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .minimumScaleFactor(0.7)

                HStack(spacing: 4) {
                    Image(systemName: summary.unrealizedPnL >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .font(.caption2.weight(.bold))
                    Text(summary.unrealizedPnL.portfolioSignedCurrencyText)
                        .font(.subheadline.weight(.semibold))
                    Text("•")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(summary.roi.portfolioSignedPercentText + " " + Labels.roi)
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(pnlColor)
            }
            .frame(maxWidth: .infinity)

            // Quiet supporting line
            Text("Cost basis \(portfolioCurrencyString(summary.costBasis)) · \(summary.totalCards) cards")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 4)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.1), radius: 20, x: 0, y: 10)
    }

    // MARK: - Performance Section

    private var performanceSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.performance)

            // Segmented control
            HStack(spacing: 0) {
                ForEach(PerformancePeriod.allCases) { period in
                    Button {
                        selectedPeriod = period
                    } label: {
                        Text(period.title)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(selectedPeriod == period ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(selectedPeriod == period ? HobbyIQTheme.Colors.electricBlue.opacity(0.25) : Color.clear)
                            .clipShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
            )

            // Performance card
            performanceCard(for: selectedPeriod)
        }
    }

    private func performanceCard(for period: PerformancePeriod) -> some View {
        let stats: PortfolioPeriodStats? = {
            switch period {
            case .month: return vm.monthStats
            case .year: return vm.yearStats
            default: return nil
            }
        }()

        let resolvedStats = stats ?? PortfolioPeriodStats(
            totalSold: 0,
            totalProfit: 0,
            totalExpenses: nil,
            netProfit: nil,
            margin: 0
        )
        let netProfit = resolvedStats.netProfit ?? resolvedStats.totalProfit
        let netColor: Color = {
            if netProfit == 0 { return HobbyIQTheme.Colors.mutedText }
            return netProfit > 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
        }()

        return VStack(spacing: 8) {
            Text(resolvedStats.netProfitFormatted)
                .font(.title2.bold())
                .foregroundStyle(netColor)
                .minimumScaleFactor(0.7)

            Text(resolvedStats.marginFormatted)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(netColor.opacity(0.8))

            Text("Sold \(resolvedStats.totalSoldFormatted) · Fees \(resolvedStats.totalExpensesFormatted)")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Priority Actions

    private var priorityActionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.priorityActions)

            if vm.priorityActions.isEmpty {
                portfolioEmptyState
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(vm.priorityActions.prefix(3).enumerated()), id: \.element.id) { index, action in
                        Button {
                            let filter: PortfolioInventoryFilter
                            switch action.kind {
                            case .sellWatch:
                                filter = .sellWatch
                            case .highRisk:
                                filter = .losers
                            case .stalePricing:
                                filter = .stale
                            }
                            onSwitchToInventory(filter)
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: actionIconName(for: action.kind))
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(actionColor(for: action.kind))
                                    .frame(width: 32, height: 32)
                                    .background(actionColor(for: action.kind).opacity(0.15))
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                                Text(action.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                                Spacer()

                                Text("\(action.cardCount)")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color(hex: 0x232937))
                                    .clipShape(Capsule(style: .continuous))

                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)

                        if index < min(vm.priorityActions.count, 3) - 1 {
                            Divider()
                                .overlay(Color.white.opacity(0.06))
                                .padding(.leading, 56)
                        }
                    }
                }
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    // MARK: - Top Movers

    private var topMoversSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.topMovers)

            if vm.topMovers.isEmpty {
                portfolioEmptyState
                    .padding(.vertical, 4)
            } else {
                let gainers = Array(vm.topMovers.filter { $0.profitLoss >= 0 }.prefix(3))
                let losers = Array(vm.topMovers.filter { $0.profitLoss < 0 }.prefix(3))

                VStack(spacing: 0) {
                    if !gainers.isEmpty {
                        moverSubheader(title: Labels.gainers, icon: "arrow.up.right", color: .green)

                        ForEach(Array(gainers.enumerated()), id: \.element.id) { index, mover in
                            Button {
                                selectedCard = vm.inventoryCards.first { $0.playerName == mover.playerName && $0.cardName == mover.cardName }
                            } label: {
                                moverRow(mover: mover)
                            }
                            .buttonStyle(.plain)

                            if index < gainers.count - 1 || !losers.isEmpty {
                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 12)
                            }
                        }
                    }

                    if !losers.isEmpty {
                        moverSubheader(title: Labels.losers, icon: "arrow.down.right", color: .red)

                        ForEach(Array(losers.enumerated()), id: \.element.id) { index, mover in
                            Button {
                                selectedCard = vm.inventoryCards.first { $0.playerName == mover.playerName && $0.cardName == mover.cardName }
                            } label: {
                                moverRow(mover: mover)
                            }
                            .buttonStyle(.plain)

                            if index < losers.count - 1 {
                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 12)
                            }
                        }
                    }
                }
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    private func moverSubheader(title: String, icon: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private func moverRow(mover: PortfolioMover) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(mover.playerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(mover.cardName)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            Text(mover.profitLoss.portfolioSignedCurrencyText)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(mover.profitLoss >= 0 ? .green : .red)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - Helpers

    private var portfolioEmptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Text("No data yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)

            Text("Add cards to your inventory to see actions and movers.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func warningBanner(message: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 6) {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0xD1D5DB))

                Button("Retry") {
                    Task { await vm.refresh() }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color(hex: 0x3B82F6))
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.orange.opacity(0.24), lineWidth: 1.6)
        )
        .cornerRadius(14)
        .padding(.horizontal)
    }

    private func sectionHeader(_ title: String) -> some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)

            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(1.2)
                .fixedSize()

            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
        }
    }

    private func actionIconName(for kind: PortfolioPriorityActionKind) -> String {
        switch kind {
        case .sellWatch: return "exclamationmark.circle.fill"
        case .highRisk: return "flame.fill"
        case .stalePricing: return "clock.arrow.circlepath"
        }
    }

    private func actionColor(for kind: PortfolioPriorityActionKind) -> Color {
        switch kind {
        case .sellWatch: return .orange
        case .highRisk: return .red
        case .stalePricing: return Color(hex: 0x3B82F6)
        }
    }
}

// MARK: - Performance Period

private enum PerformancePeriod: String, CaseIterable, Identifiable {
    case today = "Today"
    case week = "Week"
    case month = "Month"
    case year = "Year"
    case all = "All"

    var id: String { rawValue }
    var title: String { rawValue }
}

// MARK: - Supporting Views

private struct PortfolioLedgerSheet: View {
    let entries: [PortfolioLedgerEntry]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if entries.isEmpty {
                        PortfolioLedgerEmptyState()
                    } else {
                        ForEach(entries) { entry in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(entry.playerName)
                                            .font(.subheadline.bold())
                                            .foregroundStyle(.white)
                                        Text(entry.cardName)
                                            .font(.caption)
                                            .foregroundStyle(Color(hex: 0x9CA3AF))
                                    }

                                    Spacer(minLength: 0)

                                    VStack(alignment: .trailing, spacing: 4) {
                                        Text(entry.salePrice.portfolioCurrencyText)
                                            .font(.subheadline.bold())
                                            .foregroundStyle(.white)
                                        Text(entry.profit.portfolioSignedCurrencyText)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(entry.profit >= 0 ? .green : .red)
                                    }
                                }

                                Text(entry.dateText)
                                    .font(.caption2)
                                    .foregroundStyle(Color(hex: 0x9CA3AF))
                            }
                            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                            .portfolioCardSurface(cornerRadius: 18)
                        }
                    }
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Ledger")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
        }
    }
}

private struct PortfolioLedgerEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "book.closed")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Text("No sales yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)
            Text("When you mark cards sold, the ledger will appear here.")
                .font(.caption)
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(hex: 0x1A1D24))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - Preview Data

private extension PortfolioSummaryResponse {
    static var previewSample: PortfolioSummaryResponse {
        PortfolioSummaryResponse(
            inventory: PortfolioInventorySummary(
                totalCost: 960,
                totalCurrentValue: 1240,
                totalProfitLoss: 280,
                roi: 29.2,
                activeCount: 4
            ),
            accountSnapshot: PortfolioAccountSnapshot(
                userId: "demo",
                totalCards: 4,
                totalValue: 1240,
                totalCost: 960,
                totalProfitLoss: 280,
                roi: 29.2,
                generatedAt: "2024-04-29T14:22:00Z"
            ),
            inventoryDetails: [
                PortfolioCardDetail(
                    id: "1",
                    playerName: "Dylan Crews",
                    cardName: "2025 Bowman Chrome Blue Auto /150",
                    cost: 220,
                    currentValue: 310,
                    profitLoss: 90,
                    roi: 40.9,
                    purchasePlatform: "eBay",
                    notes: nil,
                    lastPricedAt: "2024-04-29T14:22:00Z",
                    signal: "hold",
                    format: "Chrome",
                    sellReason: nil
                ),
                PortfolioCardDetail(
                    id: "2",
                    playerName: "Paul Skenes",
                    cardName: "2024 Topps Chrome Refractor",
                    cost: 180,
                    currentValue: 260,
                    profitLoss: 80,
                    roi: 44.4,
                    purchasePlatform: "Whatnot",
                    notes: nil,
                    lastPricedAt: "2024-04-29T14:22:00Z",
                    signal: "strong_hold",
                    format: "Refractor",
                    sellReason: nil
                )
            ],
            bestCardsToSellNow: [
                PortfolioBestSellCard(
                    id: "best-1",
                    playerName: "Dylan Crews",
                    cardName: "2025 Bowman Chrome Blue Auto /150",
                    cost: 220,
                    currentValue: 310,
                    profitLoss: 90,
                    roi: 40.9,
                    signal: "strong_sell",
                    format: "Chrome",
                    recommendation: "Take the offer if you see one in range."
                ),
                PortfolioBestSellCard(
                    id: "best-2",
                    playerName: "Riley Greene",
                    cardName: "2024 Topps Finest Gold /50",
                    cost: 120,
                    currentValue: 170,
                    profitLoss: 50,
                    roi: 41.7,
                    signal: "sell",
                    format: "Finest",
                    recommendation: "Good spot to trim into strength."
                )
            ],
            month: SummaryPeriod(
                totalSold: 1240,
                totalProfit: 280,
                totalExpenses: 32,
                netProfit: 248,
                margin: 20.0
            ),
            year: SummaryPeriod(
                totalSold: 6410,
                totalProfit: 1320,
                totalExpenses: 180,
                netProfit: 1140,
                margin: 17.8
            )
        )
    }
}

#Preview {
    PortfolioIQView(
        vm: PortfolioIQViewModel(initialSummary: .previewSample),
        onSwitchToInventory: { _ in }
    )
    .environmentObject(AppState())
}
