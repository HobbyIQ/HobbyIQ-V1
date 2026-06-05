//
//  PortfolioIQView.swift
//  HobbyIQ
//

import SwiftUI
import UIKit

struct PortfolioIQView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    let onSwitchToInventory: (PortfolioInventoryFilter) -> Void

    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var selectedCard: InventoryCard?
    @State private var showingLedger = false
    @State private var showingMovementDetail = false
    @State private var selectedPeriod: PerformancePeriod = .month
    @State private var showCalibration = false
    @State private var showWeeklyBrief = false
    @State private var showBatchReprice = false
    @State private var showCardIdentify = false
    @State private var topMoversExpanded = false
    @State private var priorityActionsExpanded = false

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

                            if vm.hasMovementSignals {
                                movementPulseCard
                            }

                            PortfolioHealthCard()

                            portfolioToolsRow

                            topMoversSection
                            priorityActionsSection
                            performanceSection
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
                PortfolioLedgerSheet(viewModel: vm)
            }
            .sheet(isPresented: $showingMovementDetail) {
                PortfolioMovementDetailView(viewModel: vm) { card in
                    showingMovementDetail = false
                    selectedCard = card
                }
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
            .sheet(isPresented: $showCalibration) {
                CalibrationView()
                    .environmentObject(sessionViewModel)
            }
            .sheet(isPresented: $showWeeklyBrief) {
                WeeklyBriefView()
                    .environmentObject(sessionViewModel)
            }
            .sheet(isPresented: $showBatchReprice) {
                BatchRepriceView()
                    .environmentObject(sessionViewModel)
            }
            .scanFlow(isPresented: $showCardIdentify, sessionViewModel: sessionViewModel)
            .onAppear {
                if vm.summary == nil {
                    Task { await vm.load() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var portfolioToolsRow: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                portfolioToolButton(title: "Weekly Brief", icon: "newspaper", action: { showWeeklyBrief = true })
                portfolioToolButton(title: "Calibration", icon: "scope", action: { showCalibration = true })
            }
            HStack(spacing: 8) {
                portfolioToolButton(title: "Reprice All", icon: "arrow.triangle.2.circlepath", action: { showBatchReprice = true })
                portfolioToolButton(title: "Scan Card", icon: "camera.viewfinder", action: { showCardIdentify = true })
            }
        }
    }

    private func portfolioToolButton(title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
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
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(width: 44, height: 44)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open ledger")
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

    // MARK: - Movement Pulse

    private var movementPulseCard: some View {
        let pulse = vm.movementPulseSummary
        let composite = vm.portfolioComposite
        let impliedPct = vm.portfolioImpliedPct
        let directionColor: Color = impliedPct >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
        let arrowIcon = impliedPct >= 0 ? "arrow.up.right" : "arrow.down.right"

        return Button {
            showingMovementDetail = true
        } label: {
            VStack(spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: "waveform.path.ecg")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("MOVEMENT PULSE")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(1.2)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
                }

                HStack(spacing: 4) {
                    Image(systemName: arrowIcon)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(directionColor)
                    Text(String(format: "%+.1f%%", impliedPct))
                        .font(.title2.weight(.bold).monospacedDigit())
                        .foregroundStyle(directionColor)
                }

                HStack(spacing: 12) {
                    if pulse.rising > 0 {
                        pulseChip(count: pulse.rising, label: "rising", color: HobbyIQTheme.Colors.successGreen)
                    }
                    if pulse.falling > 0 {
                        pulseChip(count: pulse.falling, label: "falling", color: HobbyIQTheme.Colors.danger)
                    }
                    if pulse.stable > 0 {
                        pulseChip(count: pulse.stable, label: "stable", color: HobbyIQTheme.Colors.mutedText)
                    }
                }

                HIQMetricLabel(
                    title: "Portfolio Composite",
                    value: String(format: "%.3f", composite),
                    help: "A blended movement score across your active cards. 1.000 is neutral; above 1.000 means recent price signals lean positive overall, below 1.000 means they lean negative.",
                    alignment: .center,
                    valueFont: HobbyIQTheme.Typography.captionEmphasis
                )
                .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
            .portfolioSectionShell()
        }
        .buttonStyle(.plain)
    }

    private func pulseChip(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Text("\(count)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(color.opacity(0.8))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.12))
        .clipShape(Capsule(style: .continuous))
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
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(selectedPeriod == period ? HobbyIQTheme.Colors.electricBlue.opacity(0.25) : Color.clear)
                            .clipShape(Capsule(style: .continuous))
                            .contentShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show \(period.title) performance")
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
        let collapseLimit = 3
        let totalCount = vm.priorityActions.count
        let visibleActions = priorityActionsExpanded
            ? vm.priorityActions
            : Array(vm.priorityActions.prefix(collapseLimit))
        let canExpand = totalCount > collapseLimit

        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.priorityActions)

            if vm.priorityActions.isEmpty {
                portfolioEmptyState
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(visibleActions.enumerated()), id: \.element.id) { index, action in
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
                            .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)

                        if index < visibleActions.count - 1 {
                            Divider()
                                .overlay(Color.white.opacity(0.06))
                                .padding(.leading, 56)
                        }
                    }

                    if canExpand {
                        Divider()
                            .overlay(Color.white.opacity(0.06))
                        seeAllRow(
                            isExpanded: priorityActionsExpanded,
                            hiddenCount: max(0, totalCount - collapseLimit),
                            totalCount: totalCount,
                            noun: "actions"
                        ) {
                            withAnimation(.easeInOut(duration: 0.22)) { priorityActionsExpanded.toggle() }
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
        let hasSignals = vm.hasMovementSignals
        let upLabel = hasSignals ? "TRENDING UP" : Labels.gainers
        let downLabel = hasSignals ? "TRENDING DOWN" : Labels.losers
        let upColor: Color = hasSignals ? HobbyIQTheme.Colors.successGreen : .green
        let downColor: Color = hasSignals ? HobbyIQTheme.Colors.danger : .red

        let allRising = vm.topMovers.filter { ($0.movementDirection == "up") || (!hasSignals && $0.profitLoss >= 0) }
        let allFalling = vm.topMovers.filter { ($0.movementDirection == "down") || (!hasSignals && $0.profitLoss < 0) }
        let collapseLimit = 3
        let totalCount = allRising.count + allFalling.count
        let rising = topMoversExpanded ? allRising : Array(allRising.prefix(collapseLimit))
        let falling = topMoversExpanded ? allFalling : Array(allFalling.prefix(collapseLimit))
        let canExpand = totalCount > (rising.count + falling.count) || topMoversExpanded
        let hiddenCount = max(0, totalCount - collapseLimit * 2)

        return VStack(alignment: .leading, spacing: 10) {
            sectionHeader(Labels.topMovers)

            if vm.topMovers.isEmpty {
                portfolioEmptyState
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 0) {
                    if !rising.isEmpty {
                        moverSubheader(title: upLabel, icon: "arrow.up.right", color: upColor)

                        ForEach(Array(rising.enumerated()), id: \.element.id) { index, mover in
                            Button {
                                selectedCard = vm.inventoryCards.first { $0.playerName == mover.playerName && $0.cardName == mover.cardName }
                            } label: {
                                moverRow(mover: mover, hasSignals: hasSignals)
                            }
                            .buttonStyle(.plain)

                            if index < rising.count - 1 || !falling.isEmpty {
                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 12)
                            }
                        }
                    }

                    if !falling.isEmpty {
                        moverSubheader(title: downLabel, icon: "arrow.down.right", color: downColor)

                        ForEach(Array(falling.enumerated()), id: \.element.id) { index, mover in
                            Button {
                                selectedCard = vm.inventoryCards.first { $0.playerName == mover.playerName && $0.cardName == mover.cardName }
                            } label: {
                                moverRow(mover: mover, hasSignals: hasSignals)
                            }
                            .buttonStyle(.plain)

                            if index < falling.count - 1 {
                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 12)
                            }
                        }
                    }

                    if canExpand {
                        Divider()
                            .overlay(Color.white.opacity(0.06))
                        seeAllRow(
                            isExpanded: topMoversExpanded,
                            hiddenCount: hiddenCount,
                            totalCount: totalCount,
                            noun: "movers"
                        ) {
                            withAnimation(.easeInOut(duration: 0.22)) { topMoversExpanded.toggle() }
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

    // MARK: - See-all footer

    private func seeAllRow(isExpanded: Bool, hiddenCount: Int, totalCount: Int, noun: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(isExpanded
                     ? "Show less"
                     : "See all \(totalCount) \(noun)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Spacer()
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Show less" : "See all \(totalCount) \(noun)")
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

    private func moverRow(mover: PortfolioMover, hasSignals: Bool = false) -> some View {
        let isUp: Bool = hasSignals
            ? (mover.movementDirection == "up")
            : (mover.profitLoss >= 0)
        let valueColor: Color = isUp ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
        let arrowIcon = isUp ? "arrow.up.right" : "arrow.down.right"

        return HStack(spacing: 0) {
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

            if hasSignals, let pct = mover.movementImpliedPct {
                HStack(spacing: 6) {
                    Image(systemName: arrowIcon)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(valueColor)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(String(format: "%+.1f%%", pct))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(valueColor)
                        Text(mover.dollarImpact.portfolioSignedCurrencyText)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: arrowIcon)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(valueColor)
                    Text(mover.profitLoss.portfolioSignedCurrencyText)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(valueColor)
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
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

                Button {
                    Task { await vm.refresh() }
                } label: {
                    Text("Retry")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color(hex: 0x3B82F6))
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry loading portfolio")
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

private enum LedgerTab: String, CaseIterable {
    case entries = "Entries"
    case pnl = "P&L"
}

private enum LedgerPnLGrouping: String, CaseIterable {
    case month = "Month"
    case player = "Player"
    case source = "Source"
}

private struct PortfolioLedgerSheet: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    @State private var selectedEntry: PortfolioLedgerEntry?
    @State private var showExportOptions = false
    @State private var includeUnreconciled = false
    @State private var exportFileURL: URL?
    @State private var showShareSheet = false
    @State private var selectedTab: LedgerTab = .entries
    @State private var pnlGrouping: LedgerPnLGrouping = .month
    @State private var pnlIncludeUnreconciled = false
    @State private var entryToDismiss: PortfolioLedgerEntry?
    @State private var dismissReason = ""
    @State private var dismissError: String?

    private var entries: [PortfolioLedgerEntry] { viewModel.ledgerEntries }
    private var totals: PortfolioLedgerTotals? { viewModel.ledgerTotals }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !entries.isEmpty {
                    Picker("View", selection: $selectedTab) {
                        ForEach(LedgerTab.allCases, id: \.self) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if entries.isEmpty {
                            PortfolioLedgerEmptyState()
                        } else if selectedTab == .entries {
                            if let totals {
                                ledgerTotalsCard(totals)
                            }

                            let reconciliation = entries.filter { $0.needsReconciliation == true && $0.dismissedAt == nil }
                            if !reconciliation.isEmpty {
                                ledgerAttentionSection(reconciliation)
                            }

                            ForEach(entries) { entry in
                                Button { selectedEntry = entry } label: {
                                    ledgerRow(entry)
                                }
                                .buttonStyle(.plain)
                            }
                        } else {
                            pnlView
                        }
                    }
                    .padding(16)
                }
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Ledger")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if !entries.isEmpty {
                        Button { showExportOptions = true } label: {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                }
            }
            .sheet(item: $selectedEntry) { entry in
                LedgerEntryDetailSheet(entry: entry, viewModel: viewModel)
            }
            .confirmationDialog("Export Tax CSV", isPresented: $showExportOptions) {
                Button("Export (exclude unreconciled)") {
                    exportFileURL = viewModel.exportLedgerCSV(includeUnreconciled: false)
                    if exportFileURL != nil { showShareSheet = true }
                }
                Button("Export (include unreconciled, flagged)") {
                    exportFileURL = viewModel.exportLedgerCSV(includeUnreconciled: true)
                    if exportFileURL != nil { showShareSheet = true }
                }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(isPresented: $showShareSheet) {
                if let url = exportFileURL {
                    LedgerShareSheet(url: url)
                }
            }
        }
    }

    // MARK: - P&L View

    private var pnlFilteredEntries: [PortfolioLedgerEntry] {
        pnlIncludeUnreconciled ? entries : entries.filter { $0.needsReconciliation != true }
    }

    @ViewBuilder
    private var pnlView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("Group by", selection: $pnlGrouping) {
                    ForEach(LedgerPnLGrouping.allCases, id: \.self) { g in
                        Text(g.rawValue).tag(g)
                    }
                }
                .pickerStyle(.segmented)
            }

            Toggle(isOn: $pnlIncludeUnreconciled) {
                HStack(spacing: 4) {
                    Text("Include unreconciled")
                        .font(.caption)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    if pnlIncludeUnreconciled {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.orange)
                    }
                }
            }
            .tint(HobbyIQTheme.Colors.electricBlue)

            let grouped = groupedPnL(pnlFilteredEntries, by: pnlGrouping)
            ForEach(grouped, id: \.key) { group in
                pnlGroupCard(group)
            }

            if pnlFilteredEntries.isEmpty {
                Text("No entries match the current filter.")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
            }
        }
    }

    private struct PnLGroup {
        let key: String
        let count: Int
        let grossProceeds: Double
        let totalFees: Double
        let netProceeds: Double
        let costBasis: Double
        let realizedPnL: Double
        let hasUnreconciled: Bool
    }

    private func groupedPnL(_ entries: [PortfolioLedgerEntry], by grouping: LedgerPnLGrouping) -> [PnLGroup] {
        let dict = Dictionary(grouping: entries) { entry -> String in
            switch grouping {
            case .month:
                return monthKey(from: entry)
            case .player:
                return entry.playerName.isEmpty ? "Unknown" : entry.playerName
            case .source:
                return (entry.source ?? "manual").capitalized
            }
        }

        return dict.map { key, items in
            PnLGroup(
                key: key,
                count: items.count,
                grossProceeds: items.compactMap(\.grossProceeds).reduce(0, +),
                totalFees: items.compactMap(\.totalGranularFees).reduce(0, +),
                netProceeds: items.compactMap(\.netProceeds).reduce(0, +),
                costBasis: items.compactMap(\.costBasisSold).reduce(0, +),
                realizedPnL: items.compactMap(\.realizedProfitLoss).reduce(0, +),
                hasUnreconciled: items.contains { $0.needsReconciliation == true }
            )
        }
        .sorted { $0.key > $1.key }
    }

    private func monthKey(from entry: PortfolioLedgerEntry) -> String {
        guard let soldAt = entry.soldAt, !soldAt.isEmpty else { return entry.dateText }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        guard let date = fmtFrac.date(from: soldAt) ?? fmtStd.date(from: soldAt) else { return entry.dateText }
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM"
        return df.string(from: date)
    }

    private func pnlGroupCard(_ group: PnLGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                HStack(spacing: 6) {
                    Text(group.key)
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                    if group.hasUnreconciled && pnlIncludeUnreconciled {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.orange)
                    }
                }
                Spacer()
                Text("\(group.count) sale\(group.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }

            HStack(spacing: 0) {
                pnlMetric(label: "Revenue", value: group.grossProceeds)
                Spacer(minLength: 0)
                pnlMetric(label: "Fees", value: group.totalFees)
                Spacer(minLength: 0)
                pnlMetric(label: "Cost", value: group.costBasis)
                Spacer(minLength: 0)
                VStack(spacing: 2) {
                    Text("P&L")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Text(group.realizedPnL.portfolioSignedCurrencyText)
                        .font(.caption.bold())
                        .foregroundStyle(group.realizedPnL >= 0 ? .green : .red)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func pnlMetric(label: String, value: Double) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Text(value.portfolioCurrencyText)
                .font(.caption.bold())
                .foregroundStyle(.white)
        }
    }

    private func ledgerTotalsCard(_ totals: PortfolioLedgerTotals) -> some View {
        HStack(spacing: 0) {
            ledgerTotalItem(label: "Gross", value: totals.grossProceeds)
            Spacer(minLength: 0)
            ledgerTotalItem(label: "Net", value: totals.netProceeds)
            Spacer(minLength: 0)
            ledgerTotalItem(label: "P&L", value: totals.realizedProfitLoss, signed: true)
        }
        .frame(maxWidth: .infinity)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func ledgerTotalItem(label: String, value: Double?, signed: Bool = false) -> some View {
        VStack(spacing: 4) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            if let value {
                Text(signed ? value.portfolioSignedCurrencyText : value.portfolioCurrencyText)
                    .font(.subheadline.bold())
                    .foregroundStyle(signed ? (value >= 0 ? Color.green : Color.red) : .white)
            } else {
                Text("—")
                    .font(.subheadline.bold())
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
        }
    }

    private func ledgerAttentionSection(_ entries: [PortfolioLedgerEntry]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Needs your attention")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text("(\(entries.count))")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.orange.opacity(0.7))
            }

            ForEach(entries) { entry in
                HStack(spacing: 8) {
                    Button { selectedEntry = entry } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "cart.badge.questionmark")
                                .font(.caption)
                                .foregroundStyle(.orange)
                            Text(entry.playerName)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white)
                            Spacer(minLength: 0)
                            Text("Incomplete fees")
                                .font(.caption2)
                                .foregroundStyle(.orange.opacity(0.8))
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(Color(hex: 0x9CA3AF))
                        }
                    }
                    .buttonStyle(.plain)

                    Button {
                        dismissReason = ""
                        entryToDismiss = entry
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Color(hex: 0x9CA3AF).opacity(0.6))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
        .alert("Dismiss Entry", isPresented: Binding(
            get: { entryToDismiss != nil },
            set: { if !$0 { entryToDismiss = nil } }
        )) {
            TextField("Reason (optional)", text: $dismissReason)
            Button("Dismiss") {
                guard let entry = entryToDismiss else { return }
                Task {
                    do {
                        try await viewModel.dismissLedgerEntry(id: entry.id, reason: dismissReason)
                    } catch {
                        dismissError = error.localizedDescription
                    }
                    entryToDismiss = nil
                }
            }
            Button("Cancel", role: .cancel) { entryToDismiss = nil }
        } message: {
            Text("Acknowledge this entry's incomplete fees. You can undo this from the sale details.")
        }
        .alert("Dismiss Failed", isPresented: Binding(
            get: { dismissError != nil },
            set: { if !$0 { dismissError = nil } }
        )) {
            Button("OK") { dismissError = nil }
        } message: {
            Text(dismissError ?? "")
        }
    }

    private func ledgerRow(_ entry: PortfolioLedgerEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(entry.playerName)
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                        if entry.isEbaySource {
                            Text("eBay")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color(hex: 0x3665F3).opacity(0.8))
                                .clipShape(Capsule())
                        }
                        if entry.needsReconciliation == true {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(.orange)
                        }
                    }
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

            HStack(spacing: 8) {
                Text(entry.dateText)
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                if entry.isEbaySource, let total = entry.totalGranularFees {
                    Text("Fees: \(total.portfolioCurrencyText)")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }
}

// MARK: - Ledger Entry Detail

private struct LedgerEntryDetailSheet: View {
    let entry: PortfolioLedgerEntry
    let viewModel: PortfolioIQViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var gradingCostText = ""
    @State private var suppliesCostText = ""
    @State private var isSavingCosts = false
    @State private var costSaveError: String?
    @State private var isUndismissing = false
    @State private var undismissError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerSection
                    transactionSection
                    if entry.isEbaySource {
                        ebayFeeBreakdownSection
                    }
                    costBasisEditSection
                    profitSection
                    if entry.dismissedAt != nil {
                        undismissSection
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Sale Details")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
        }
        .onAppear {
            gradingCostText = entry.gradingCost.map { String(format: "%.2f", $0) } ?? ""
            suppliesCostText = entry.suppliesCost.map { String(format: "%.2f", $0) } ?? ""
        }
    }

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(entry.playerName)
                    .font(.title3.bold())
                    .foregroundStyle(.white)
                if entry.isEbaySource {
                    Text("eBay")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color(hex: 0x3665F3).opacity(0.8))
                        .clipShape(Capsule())
                }
            }
            if !entry.cardName.isEmpty {
                Text(entry.cardName)
                    .font(.subheadline)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
            if entry.needsReconciliation == true && entry.dismissedAt == nil {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                    Text("Needs reconciliation — some fees are pending")
                        .font(.caption2)
                }
                .foregroundStyle(.orange)
                .padding(.top, 2)
            }
            if entry.dismissedAt != nil {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2)
                    Text("Dismissed")
                        .font(.caption2.weight(.semibold))
                    if let reason = entry.dismissedReason, !reason.isEmpty {
                        Text("— \(reason)")
                            .font(.caption2)
                    }
                }
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var transactionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Transaction")
            detailRow("Sale Price", value: entry.salePrice.portfolioCurrencyText)
            if let gross = entry.grossProceeds {
                detailRow("Gross Proceeds", value: gross.portfolioCurrencyText)
            }
            if let net = entry.netProceeds {
                detailRow("Net Proceeds", value: net.portfolioCurrencyText)
            }
            if let netPayout = entry.netPayout {
                detailRow("eBay Net Payout", value: netPayout.portfolioCurrencyText)
            }
            detailRow("Date", value: entry.dateText)
            if let orderId = entry.ebayOrderId {
                detailRow("eBay Order", value: orderId)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var ebayFeeBreakdownSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("eBay Fee Breakdown")
            feeRow("Final Value Fee", fee: entry.finalValueFee)
            feeRow("Payment Processing", fee: entry.paymentProcessingFee)
            feeRow("Promoted Listing", fee: entry.promotedListingFee)
            feeRow("Ad Fee", fee: entry.adFee)
            feeRow("Shipping Cost", fee: entry.actualShippingCost)
            feeRow("Other Fees", fee: entry.otherFees)

            if let total = entry.totalGranularFees {
                Divider().overlay(Color(hex: 0x9CA3AF).opacity(0.3))
                detailRow("Total Known Fees", value: total.portfolioCurrencyText, bold: true)
            }

            if entry.hasAnyNullFee {
                HStack(spacing: 4) {
                    Image(systemName: "clock.fill")
                        .font(.system(size: 10))
                    Text("Some fees are pending — eBay has not reported them yet")
                        .font(.caption2)
                }
                .foregroundStyle(.orange.opacity(0.8))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var costBasisEditSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Cost Basis")
            if let cost = entry.costBasisSold {
                detailRow("Purchase Cost", value: cost.portfolioCurrencyText)
            }
            costEditRow("Grading Cost", text: $gradingCostText) {
                await saveCost(field: "gradingCost", text: gradingCostText, original: entry.gradingCost)
            }
            costEditRow("Supplies Cost", text: $suppliesCostText) {
                await saveCost(field: "suppliesCost", text: suppliesCostText, original: entry.suppliesCost)
            }
            if isSavingCosts {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini)
                    Text("Saving...")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }
            }
            if let err = costSaveError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func costEditRow(_ label: String, text: Binding<String>, onCommit: @escaping () async -> Void) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            HStack(spacing: 2) {
                Text("$")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                TextField("—", text: text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 80)
                    .onSubmit { Task { await onCommit() } }
            }
        }
    }

    private func saveCost(field: String, text: String, original: Double?) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let newValue: Double?? = trimmed.isEmpty ? .some(nil) : {
            guard let v = Double(trimmed), v >= 0 else { return nil }
            return .some(v)
        }()

        guard let patchValue = newValue else {
            costSaveError = "Enter a valid amount (0 or greater)"
            return
        }

        let originalFormatted = original.map { String(format: "%.2f", $0) } ?? ""
        if trimmed == originalFormatted { return }

        isSavingCosts = true
        costSaveError = nil
        do {
            if field == "gradingCost" {
                try await viewModel.updateLedgerEntryCosts(id: entry.id, gradingCost: patchValue, suppliesCost: nil)
            } else {
                try await viewModel.updateLedgerEntryCosts(id: entry.id, gradingCost: nil, suppliesCost: patchValue)
            }
        } catch {
            costSaveError = error.localizedDescription
            if field == "gradingCost" {
                gradingCostText = originalFormatted
            } else {
                suppliesCostText = originalFormatted
            }
        }
        isSavingCosts = false
    }

    private var undismissSection: some View {
        VStack(spacing: 8) {
            Button {
                Task {
                    isUndismissing = true
                    undismissError = nil
                    do {
                        try await viewModel.undismissLedgerEntry(id: entry.id)
                        dismiss()
                    } catch {
                        undismissError = error.localizedDescription
                    }
                    isUndismissing = false
                }
            } label: {
                HStack(spacing: 6) {
                    if isUndismissing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.uturn.backward.circle")
                            .font(.caption)
                    }
                    Text("Undo Dismiss")
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .disabled(isUndismissing)
            if let err = undismissError {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .portfolioCardSurface(cornerRadius: 18)
    }

    private var profitSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            detailSectionHeader("Profit / Loss")
            HStack {
                Text("Realized P&L")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(hex: 0x9CA3AF))
                Spacer()
                Text(entry.profit.portfolioSignedCurrencyText)
                    .font(.headline.bold())
                    .foregroundStyle(entry.profit >= 0 ? .green : .red)
            }
            if let pct = entry.realizedProfitLossPct {
                HStack {
                    Text("ROI")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Spacer()
                    Text(String(format: "%+.1f%%", pct))
                        .font(.subheadline.bold())
                        .foregroundStyle(pct >= 0 ? .green : .red)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .portfolioCardSurface(cornerRadius: 18)
    }

    private func detailSectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .textCase(.uppercase)
    }

    private func detailRow(_ label: String, value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            Text(value)
                .font(.subheadline.weight(bold ? .bold : .medium))
                .foregroundStyle(.white)
        }
    }

    private func feeRow(_ label: String, fee: Double?) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(hex: 0x9CA3AF))
            Spacer()
            if let fee {
                Text(fee.portfolioCurrencyText)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
            } else {
                Text("Pending")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.orange.opacity(0.15))
                    .clipShape(Capsule())
            }
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

// MARK: - Share Sheet

private struct LedgerShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
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

// MARK: - Movement Detail View

struct PortfolioMovementDetailView: View {
    @ObservedObject var viewModel: PortfolioIQViewModel
    let onSelectCard: (InventoryCard) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var sortMode: MovementSortMode = .magnitude
    @State private var filterMode: MovementFilterMode = .all

    private enum MovementSortMode: String, CaseIterable {
        case magnitude = "Magnitude"
        case dollarImpact = "$ Impact"
        case value = "Value"
        case name = "Name"
    }

    private enum MovementFilterMode: String, CaseIterable {
        case all = "All"
        case rising = "Rising"
        case falling = "Falling"
    }

    private var filteredCards: [InventoryCard] {
        let active = viewModel.inventoryCards.filter { $0.status.lowercased() != "sold" }
        let withSignals = active.filter { $0.movementDirection != nil }

        let filtered: [InventoryCard]
        switch filterMode {
        case .all: filtered = withSignals
        case .rising: filtered = withSignals.filter { $0.movementDirection == "up" }
        case .falling: filtered = withSignals.filter { $0.movementDirection == "down" }
        }

        switch sortMode {
        case .magnitude:
            return filtered.sorted { abs($0.movementImpliedPct ?? 0) > abs($1.movementImpliedPct ?? 0) }
        case .dollarImpact:
            return filtered.sorted { abs($0.dollarImpact) > abs($1.dollarImpact) }
        case .value:
            return filtered.sorted { $0.currentValue > $1.currentValue }
        case .name:
            return filtered.sorted { $0.playerName.localizedCompare($1.playerName) == .orderedAscending }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Picker("Filter", selection: $filterMode) {
                        ForEach(MovementFilterMode.allCases, id: \.self) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    Menu {
                        ForEach(MovementSortMode.allCases, id: \.self) { mode in
                            Button {
                                sortMode = mode
                            } label: {
                                if sortMode == mode {
                                    Label(mode.rawValue, systemImage: "checkmark")
                                } else {
                                    Text(mode.rawValue)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .frame(width: 34, height: 34)
                            .background(HobbyIQTheme.Colors.cardNavy)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)

                ScrollView {
                    LazyVStack(spacing: 0) {
                        if filteredCards.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "waveform.path.ecg")
                                    .font(.system(size: 30, weight: .semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Text("No movement signals")
                                    .font(.headline.bold())
                                    .foregroundStyle(.white)
                                Text("Cards will show movement data after their next reprice.")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(40)
                        } else {
                            ForEach(filteredCards) { card in
                                Button {
                                    onSelectCard(card)
                                } label: {
                                    movementDetailRow(card: card)
                                }
                                .buttonStyle(.plain)

                                Divider()
                                    .overlay(Color.white.opacity(0.06))
                                    .padding(.leading, 12)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Movement Signals")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AppColors.textSecondary)
                }
            }
        }
    }

    private func movementDetailRow(card: InventoryCard) -> some View {
        HStack(spacing: 10) {
            cardThumbnail(urlString: card.imageFrontUrl)

            VStack(alignment: .leading, spacing: 2) {
                Text(card.playerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(card.cardName)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(card.currentValueFormatted)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    if let fmv = card.fairMarketValueFormatted, fmv != card.currentValueFormatted {
                        Text("FMV \(fmv)")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                    }
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                if let chipText = card.movementChipText {
                    Text(chipText)
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(card.movementChipColor)
                }
                Text(card.dollarImpact.portfolioSignedCurrencyText)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                if card.movementIsStale {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 9))
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 10)
    }
}

#Preview {
    PortfolioIQView(
        vm: PortfolioIQViewModel(initialSummary: .previewSample),
        onSwitchToInventory: { _ in }
    )
    .environmentObject(AppState())
}
