//
//  ERPViews.swift
//  HobbyIQ
//

import Charts
import SwiftUI
import UIKit

// MARK: - ERP Hub

enum FinancialsPeriod: String, CaseIterable, Identifiable {
    case thisMonth = "This month"
    case year = "Year"
    case all = "All"

    var id: String { rawValue }
    var title: String { rawValue }

    /// Maps the hub's period selector to the `groupBy` token accepted by
    /// `/api/portfolio/erp/pnl`.
    var pnlGroupBy: String {
        switch self {
        case .thisMonth: return "month"
        case .year: return "year"
        case .all: return "all"
        }
    }

    /// Maps to the `bucket` accepted by `/api/portfolio/erp/analytics/timeseries`
    /// (month|quarter only). "All" widens to quarter buckets to keep the chart legible.
    var trendBucket: String {
        switch self {
        case .all: return "quarter"
        default: return "month"
        }
    }
}

enum FinancialsDestination: String, Identifiable {
    case reconcile, pnl, expenses, trades, tax, sales, purchases, inventoryAnalytics
    var id: String { rawValue }
}

struct ERPHubView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var showUpgradePaywall = false
    @State private var selectedPeriod: FinancialsPeriod = .thisMonth
    @State private var selectedSide: SideBreakdown = .buy
    @State private var pnl: ERPPnlResponse?
    @State private var timeseries: ERPTimeseriesResponse?
    @State private var unreconciledCount: Int = 0
    @State private var recentSales: [PortfolioLedgerEntry] = []

    private enum SideBreakdown: String, CaseIterable, Identifiable {
        case buy = "Buy side"
        case sell = "Sell side"
        var id: String { rawValue }
    }
    @State private var isLoading = false
    @State private var loadFailed = false
    @State private var isSyncing = false
    @State private var syncToast: String?
    @State private var presentedDestination: FinancialsDestination?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard
                periodSelector
                reconcileFlatBanner
                cogsMetricsSection
                actionPillsGrid
                recentSalesSection
                quietSyncAction
                if let syncToast {
                    Text(syncToast)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable { await loadAll() }
        .toolbar(.hidden, for: .navigationBar)
        .themedNavigationSurface()
        .task { await loadAll() }
        .onChange(of: selectedPeriod) { _, _ in Task { await loadAll() } }
        .onReceive(NotificationCenter.default.publisher(for: .portfolioSaleRecorded)) { _ in
            #if DEBUG
            print("[Financials] received .portfolioSaleRecorded → reloading hub")
            #endif
            Task { await loadAll() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .portfolioPurchaseRecorded)) { _ in
            #if DEBUG
            print("[Financials] received .portfolioPurchaseRecorded → reloading hub")
            #endif
            Task { await loadAll() }
        }
        .lockedOverlay(
            feature: GatedFeature.erpReconciliation,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.erpReconciliation)
            )
        }
        .navigationDestination(item: $presentedDestination) { destination in
            FinancialsDestinationView(destination: destination)
        }
    }

    // MARK: Period selector

    private var periodSelector: some View {
        HStack(spacing: 0) {
            ForEach(FinancialsPeriod.allCases) { period in
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
                .accessibilityLabel("Show \(period.title) financials")
            }
        }
        .padding(3)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(Capsule(style: .continuous))
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    // MARK: Hero card (Phase 1 + Phase 2)

    private var trendPoints: [ERPTimeseriesPoint] { timeseries?.points ?? [] }

    private var heroCard: some View {
        let net = pnl?.totals?.realizedPnL ?? 0
        return HIQHeroCard(
            title: "Financials",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: net.portfolioCurrencyText,
            delta: { heroDeltaLine },
            sparkline: { heroSparkline },
            meta: { heroMetadata }
        )
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    @ViewBuilder
    private var heroDeltaLine: some View {
        if let (current, prior) = currentAndPriorPoints(),
           let cur = current.pnl {
            let priorNet = prior.pnl ?? 0
            let deltaValue = cur - priorNet
            let pct: Double? = abs(priorNet) < 0.01 ? nil : (deltaValue / abs(priorNet)) * 100
            let isPositive = deltaValue >= 0
            HStack(spacing: 4) {
                Image(systemName: isPositive ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption2.weight(.bold))
                Text(deltaValue.portfolioSignedCurrencyText + " vs last month")
                    .font(.subheadline.weight(.semibold))
                if let pct {
                    Text("·")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(pct.portfolioSignedPercentText)
                        .font(.subheadline.weight(.semibold))
                }
            }
            .foregroundStyle(isPositive ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
        }
    }

    /// Returns (current, prior) from the timeseries points, sorted by
    /// period ascending. Nil when we have fewer than 2 points — the
    /// delta line is omitted in that case per the phase 2 spec.
    private func currentAndPriorPoints() -> (ERPTimeseriesPoint, ERPTimeseriesPoint)? {
        let sorted = trendPoints.sorted { $0.period < $1.period }
        guard sorted.count >= 2 else { return nil }
        return (sorted[sorted.count - 1], sorted[sorted.count - 2])
    }

    @ViewBuilder
    private var heroSparkline: some View {
        if trendPoints.count >= 2 {
            ERPHubTrendChart(points: trendPoints)
                .frame(height: 60)
                .accessibilityLabel("Net profit trend for \(selectedPeriod.title)")
        }
    }

    private var heroMetadata: some View {
        let totals = pnl?.totals
        let count = totals?.count ?? 0
        let gross = (totals?.grossProceeds ?? 0).portfolioCurrencyText
        let fees = (totals?.totalFees ?? 0).portfolioCurrencyText
        let expenses = (totals?.totalExpenses ?? 0).portfolioCurrencyText
        return Text("\(count) sale\(count == 1 ? "" : "s") · \(gross) sold · \(fees) fees · \(expenses) expenses")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.85)
    }

    // MARK: Reconcile flat banner (Phase 4)

    private var reconcileFlatBanner: some View {
        Button {
            presentedDestination = .reconcile
        } label: {
            HStack(spacing: 12) {
                Image(systemName: unreconciledCount > 0 ? "exclamationmark.circle.fill" : "checkmark.seal.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(unreconciledCount > 0 ? HobbyIQTheme.Colors.warning : HobbyIQTheme.Colors.successGreen)
                    .frame(width: 38, height: 38)
                    .background((unreconciledCount > 0 ? HobbyIQTheme.Colors.warning : HobbyIQTheme.Colors.successGreen).opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(unreconciledCount > 0
                         ? "\(unreconciledCount) \(unreconciledCount == 1 ? "sale needs" : "sales need") reconciling"
                         : "All caught up")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(unreconciledCount > 0 ? "Tap to review fees and net payouts." : "No sales need reconciling.")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(HobbyIQTheme.Colors.cardNavy)
            // Phase 4: no green/warning accent border — the hero card is
            // the only element on the page with the gradient accent.
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(unreconciledCount > 0
                            ? "\(unreconciledCount) sales need reconciling"
                            : "All sales caught up")
    }

    // MARK: Buy / Sell side metrics toggle (Scope 3, Surface #6 + follow-up)

    @ViewBuilder
    private var cogsMetricsSection: some View {
        if shouldShowSideBreakdown {
            VStack(alignment: .leading, spacing: 10) {
                sideBreakdownTabs
                let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
                LazyVGrid(columns: columns, spacing: 8) {
                    switch selectedSide {
                    case .buy: buySideCards
                    case .sell: sellSideCards
                    }
                }
            }
        }
    }

    private var sideBreakdownTabs: some View {
        HStack(spacing: 0) {
            ForEach(SideBreakdown.allCases) { side in
                Button {
                    selectedSide = side
                } label: {
                    Text(side.rawValue)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(selectedSide == side ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(selectedSide == side ? HobbyIQTheme.Colors.electricBlue.opacity(0.25) : Color.clear)
                        .clipShape(Capsule(style: .continuous))
                        .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show \(side.rawValue) metrics")
            }
        }
        .padding(3)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(Capsule(style: .continuous))
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var buySideCards: some View {
        let cogs = pnl?.cogs
        cogsMetricCard(
            label: "Purchase spend",
            value: (cogs?.purchaseSpend ?? 0).portfolioCurrencyText,
            subtitle: cogs?.purchaseCount.map { "\($0) purchase\($0 == 1 ? "" : "s")" }
        )
        cogsMetricCard(
            label: "Cash flow",
            value: (cogs?.cashFlow ?? 0).portfolioSignedCurrencyText,
            subtitle: "In minus out",
            valueColor: (cogs?.cashFlow ?? 0) >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
        )
        cogsMetricCard(
            label: "Gross margin",
            value: cogs?.grossMarginPct.map { String(format: "%+.1f%%", $0) } ?? "—",
            subtitle: cogs?.grossMarginPct == nil ? "No sales yet" : "Realized ÷ gross",
            valueColor: {
                guard let pct = cogs?.grossMarginPct else { return HobbyIQTheme.Colors.pureWhite }
                return pct >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
            }()
        )
        cogsMetricCard(
            label: "Inventory (at cost)",
            value: (cogs?.inventoryOnHandCost ?? 0).portfolioCurrencyText,
            subtitle: cogs?.inventoryOnHandCount.map { "\($0) on hand" }
        )
    }

    @ViewBuilder
    private var sellSideCards: some View {
        let totals = pnl?.totals
        let net = totals?.netPnL ?? totals?.realizedPnL ?? 0
        let netColor: Color = {
            if net > 0 { return HobbyIQTheme.Colors.successGreen }
            if net < 0 { return HobbyIQTheme.Colors.danger }
            return HobbyIQTheme.Colors.pureWhite
        }()
        cogsMetricCard(
            label: "Net profit",
            value: net.portfolioSignedCurrencyText,
            subtitle: totals?.count.map { "\($0) sale\($0 == 1 ? "" : "s")" } ?? "No sales yet",
            valueColor: netColor
        )
        cogsMetricCard(
            label: "Sold (gross)",
            value: (totals?.grossProceeds ?? 0).portfolioCurrencyText,
            subtitle: "Ticket total"
        )
        cogsMetricCard(
            label: "Fees",
            value: (totals?.totalFees ?? 0).portfolioCurrencyText,
            subtitle: "Platform + processing"
        )
        cogsMetricCard(
            label: "Expenses",
            value: (totals?.totalExpenses ?? 0).portfolioCurrencyText,
            subtitle: "Operating"
        )
    }

    /// Renders the toggle whenever either side has real signal — a fresh
    /// account with $0 across the board keeps the placeholder grid out
    /// of the way per the original `shouldShowCogs` gate.
    private var shouldShowSideBreakdown: Bool {
        let hasBuy = (pnl?.cogs?.purchaseSpend ?? 0) > 0
            || (pnl?.cogs?.inventoryOnHandCost ?? 0) > 0
            || pnl?.cogs?.grossMarginPct != nil
        let hasSell = (pnl?.totals?.count ?? 0) > 0
            || (pnl?.totals?.grossProceeds ?? 0) > 0
            || (pnl?.totals?.realizedPnL ?? 0) != 0
        return hasBuy || hasSell
    }

    private func cogsMetricCard(
        label: String,
        value: String,
        subtitle: String? = nil,
        valueColor: Color = HobbyIQTheme.Colors.pureWhite
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.4)
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(valueColor)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Action pills grid (Phase 3)

    private var actionPillsGrid: some View {
        let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        return LazyVGrid(columns: columns, spacing: 8) {
            HIQActionPill(title: "P&L", icon: "chart.bar.fill", action: { presentedDestination = .pnl })
            HIQActionPill(title: "Expenses", icon: "creditcard.fill", action: { presentedDestination = .expenses })
            HIQActionPill(title: "Reconcile", icon: "checkmark.seal.fill", action: { presentedDestination = .reconcile })
            HIQActionPill(title: "Trades", icon: "arrow.triangle.swap", action: { presentedDestination = .trades })
            HIQActionPill(title: "Reports", icon: "doc.text.fill", action: { presentedDestination = .tax })
            HIQActionPill(title: "Sales", icon: "bag.fill", action: { presentedDestination = .sales })
            HIQActionPill(title: "Purchases", icon: "cart.fill", action: { presentedDestination = .purchases })
            HIQActionPill(title: "Inventory", icon: "square.stack.3d.up.fill", action: { presentedDestination = .inventoryAnalytics })
        }
    }

    // MARK: Recent sales section (Phase 5)

    @ViewBuilder
    private var recentSalesSection: some View {
        if recentSales.isEmpty == false {
            VStack(alignment: .leading, spacing: 10) {
                HIQSectionHeader("Recent sales")
                VStack(spacing: 4) {
                    ForEach(recentSales.prefix(5)) { entry in
                        HIQCompactSaleRow(entry: entry)
                    }
                }
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    // MARK: Quiet sync action

    private var quietSyncAction: some View {
        Button {
            Task { await syncFinances() }
        } label: {
            HStack(spacing: 6) {
                if isSyncing {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue).controlSize(.small)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold))
                }
                Text(isSyncing ? "Syncing…" : "Sync eBay finances")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(isSyncing)
        .accessibilityLabel(isSyncing ? "Syncing eBay finances" : "Sync eBay finances")
    }

    // MARK: Data

    private func loadAll() async {
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            async let p = APIService.shared.fetchErpPnl(groupBy: selectedPeriod.pnlGroupBy, includeExpenses: true)
            async let t = APIService.shared.fetchErpTimeseries(bucket: selectedPeriod.trendBucket)
            async let u = APIService.shared.fetchUnreconciled()
            // Phase 5: reuse the existing ledger endpoint (same one
            // powering PortfolioIQ's Ledger sheet) for the "Recent sales"
            // list — no new networking.
            async let l = APIService.shared.fetchPortfolioLedger()
            let (pr, tr, ur, lr) = try await (p, t, u, l)
            pnl = pr
            timeseries = tr
            unreconciledCount = ur.count ?? ur.entries.count
            let ledgerEntries = (lr.entries ?? [])
                .filter { ($0.soldAt ?? "").isEmpty == false && $0.dismissedAt == nil }
                .sorted { ($0.soldAt ?? "") > ($1.soldAt ?? "") }
            recentSales = Array(ledgerEntries.prefix(5))
            #if DEBUG
            print("[Financials] hub load ok: entryCount=\(pr.totals?.count ?? 0) realizedPnL=\(pr.totals?.realizedPnL ?? 0) grossProceeds=\(pr.totals?.grossProceeds ?? 0) feesTotal=\(pr.totals?.totalFees ?? 0) groups=\(pr.groups?.count ?? 0) unreconciled=\(unreconciledCount) recentSales=\(recentSales.count)")
            #endif
        } catch {
            #if DEBUG
            print("[Financials] hub load error: \(APIService.errorMessage(from: error))")
            #endif
            loadFailed = true
        }
    }

    private func syncFinances() async {
        isSyncing = true
        syncToast = nil
        defer { isSyncing = false }
        do {
            let response = try await APIService.shared.refetchFinances()
            syncToast = response.message ?? "Updated \(response.updated ?? 0) entries"
            await loadAll()
        } catch {
            #if DEBUG
            print("[Financials] sync error: \(APIService.errorMessage(from: error))")
            #endif
            syncToast = "Couldn't sync — try again."
        }
    }
}

// MARK: - Destination Wrapper

/// Hosts a Financials sub-screen as a pushed destination on the parent
/// tab's NavigationStack, so the shell tab bar stays visible.
private struct FinancialsDestinationView: View {
    let destination: FinancialsDestination

    var body: some View {
        content
            .background { HobbyIQBackground() }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
    }

    private var title: String {
        switch destination {
        case .reconcile: return "Reconcile"
        case .pnl: return "P&L"
        case .expenses: return "Expenses"
        case .trades: return "Trades"
        case .tax: return "Tax & exports"
        // Scope 3 screens carry their own hero cards, so the nav bar
        // suppresses the redundant title (back chevron lives in the tile).
        case .sales, .purchases, .inventoryAnalytics: return ""
        }
    }

    @ViewBuilder
    private var content: some View {
        switch destination {
        case .reconcile: ERPReconciliationView()
        case .pnl: ERPPnlView()
        case .expenses: ERPExpensesView()
        case .trades: ERPTradesView()
        case .tax: ERPTaxView()
        case .sales: ERPSalesListView()
        case .purchases: ERPPurchasesListView()
        case .inventoryAnalytics: ERPInventoryAnalyticsView()
        }
    }
}

// MARK: - Hero Trend Chart

private struct ERPHubTrendChart: View {
    let points: [ERPTimeseriesPoint]

    var body: some View {
        Chart(points) { point in
            LineMark(
                x: .value("Period", point.period),
                y: .value("Net profit", point.pnl ?? 0)
            )
            .foregroundStyle(HobbyIQTheme.Gradients.dashboardStroke)
            .interpolationMethod(.monotone)
            .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))

            AreaMark(
                x: .value("Period", point.period),
                y: .value("Net profit", point.pnl ?? 0)
            )
            .foregroundStyle(
                LinearGradient(
                    colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.22), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartPlotStyle { plot in
            plot.padding(.vertical, 4)
        }
    }
}

// MARK: - Sales List (Financials → Sales)

/// Sort options for the full "All sales" list. `.byMonth` groups by
/// `soldAt` month with an HIQSectionHeader per group; the others render a
/// single flat list.
enum ERPSalesSortMode: String, CaseIterable, Identifiable {
    case newest = "Newest first"
    case oldest = "Oldest first"
    case highest = "Highest sale"
    case lowest = "Lowest sale"
    case player = "By player"
    case byMonth = "By month"

    var id: String { rawValue }
}

/// Full-list "All sales" screen pushed from the Financials Sales pill.
/// Same theme + layout language as the hub: HobbyIQBackground, sort
/// dropdown up top styled like a themed pill, then either a flat
/// `HIQCompactSaleRow` list or one grouped section per month.
struct ERPSalesListView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var sales: [PortfolioLedgerEntry] = []
    @State private var sortMode: ERPSalesSortMode = .newest
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroCard
                sortRow
                content
            }
            .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
            .padding(.vertical, 16)
        }
        .background { HobbyIQBackground() }
        .refreshable { await load() }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
    }

    // MARK: Totals hero

    private var heroCard: some View {
        let totalGross = sales.reduce(0.0) { $0 + salePrice(of: $1) }
        let totalNet = sales.reduce(0.0) { $0 + ($1.netProceeds ?? 0) }
        let totalPL = sales.reduce(0.0) { $0 + ($1.realizedProfitLoss ?? 0) }
        let avgSale = sales.isEmpty ? 0 : totalGross / Double(sales.count)

        return HIQHeroCard(
            title: "Sales",
            statusDate: Self.shortDate.string(from: Date()),
            heroValue: totalGross.portfolioCurrencyText,
            titleAlignment: .center,
            leading: {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        .frame(width: 36, height: 36)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.96))
                        .clipShape(Circle())
                        .overlay(
                            Circle()
                                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.4)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to Financials")
            },
            delta: {
                if sales.isEmpty == false, abs(totalPL) > 0.005 {
                    let isPositive = totalPL >= 0
                    HStack(spacing: 4) {
                        Image(systemName: isPositive ? "arrow.up.right" : "arrow.down.right")
                            .font(.caption2.weight(.bold))
                        Text(totalPL.portfolioSignedCurrencyText + " realized")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(isPositive ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                }
            },
            meta: {
                if sales.isEmpty == false {
                    Text("\(sales.count) sale\(sales.count == 1 ? "" : "s") · avg \(avgSale.portfolioCurrencyText) · net \(totalNet.portfolioCurrencyText)")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                }
            }
        )
    }

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    // MARK: Sort row

    private var sortRow: some View {
        HStack {
            Text("\(sales.count) sale\(sales.count == 1 ? "" : "s")")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Spacer()

            Menu {
                Picker("Sort by", selection: $sortMode) {
                    ForEach(ERPSalesSortMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(sortMode.rawValue)
                        .font(.caption.weight(.semibold))
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
            }
            .accessibilityLabel("Sort sales")
        }
    }

    // MARK: Content switch

    @ViewBuilder
    private var content: some View {
        if isLoading && sales.isEmpty {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if let errorMessage {
            errorState(errorMessage)
        } else if sales.isEmpty {
            emptyState
        } else if sortMode == .byMonth {
            monthGroupedList
        } else {
            flatList
        }
    }

    private var flatList: some View {
        VStack(spacing: 4) {
            ForEach(sortedSales) { entry in
                HIQCompactSaleRow(entry: entry)
            }
        }
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var monthGroupedList: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(monthGroups, id: \.key) { group in
                VStack(alignment: .leading, spacing: 10) {
                    HIQSectionHeader(group.key)
                    VStack(spacing: 4) {
                        ForEach(group.entries) { entry in
                            HIQCompactSaleRow(entry: entry)
                        }
                    }
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "bag.badge.questionmark")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            Text("No sales yet")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Mark a card sold from Inventory to see it here.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text("Couldn't load sales")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity)
        .background(HobbyIQTheme.Colors.warning.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Sorting / grouping

    private var sortedSales: [PortfolioLedgerEntry] {
        switch sortMode {
        case .newest:
            return sales.sorted { ($0.soldAt ?? "") > ($1.soldAt ?? "") }
        case .oldest:
            return sales.sorted { ($0.soldAt ?? "") < ($1.soldAt ?? "") }
        case .highest:
            return sales.sorted { salePrice(of: $0) > salePrice(of: $1) }
        case .lowest:
            return sales.sorted { salePrice(of: $0) < salePrice(of: $1) }
        case .player:
            return sales.sorted { $0.playerName.localizedCaseInsensitiveCompare($1.playerName) == .orderedAscending }
        case .byMonth:
            return sales
        }
    }

    private struct MonthGroup: Identifiable {
        let key: String     // display label, e.g. "July 2026"
        let sortKey: String // ISO-ish key for descending sort, e.g. "2026-07"
        let entries: [PortfolioLedgerEntry]
        var id: String { sortKey }
    }

    private var monthGroups: [MonthGroup] {
        let bucketed = Dictionary(grouping: sales) { monthKey(for: $0.soldAt) }
        return bucketed
            .map { pair -> MonthGroup in
                MonthGroup(
                    key: monthLabel(sortKey: pair.key),
                    sortKey: pair.key,
                    entries: pair.value.sorted { ($0.soldAt ?? "") > ($1.soldAt ?? "") }
                )
            }
            .sorted { $0.sortKey > $1.sortKey }
    }

    private func monthKey(for iso: String?) -> String {
        guard let raw = iso, let date = Self.parseISO(raw) else { return "unknown" }
        return Self.monthSortKeyFormatter.string(from: date)
    }

    private func monthLabel(sortKey: String) -> String {
        if sortKey == "unknown" { return "Undated" }
        if let date = Self.monthSortKeyFormatter.date(from: sortKey) {
            return Self.monthDisplayFormatter.string(from: date)
        }
        return sortKey
    }

    private func salePrice(of entry: PortfolioLedgerEntry) -> Double {
        if let gp = entry.grossProceeds, gp > 0 { return gp }
        return (entry.unitSalePrice ?? 0) * Double(entry.quantitySold ?? 1)
    }

    private static let isoWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoStandard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static func parseISO(_ raw: String) -> Date? {
        isoWithFractional.date(from: raw) ?? isoStandard.date(from: raw)
    }

    private static let monthSortKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        return f
    }()

    private static let monthDisplayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        return f
    }()

    // MARK: Data

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchPortfolioLedger()
            sales = (response.entries ?? [])
                .filter { ($0.soldAt ?? "").isEmpty == false && $0.dismissedAt == nil }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - 6.1 Reconciliation Dashboard

struct ERPReconciliationView: View {
    // CF-PR-E-IOS-PHASE-1B (2026-06-16): the unreconciled list + per-
    // entry mutations now ride ReconcileViewModel. Aging buckets +
    // eBay-finances refetch remain ad-hoc @State siblings — they're
    // axis-1 metadata, not part of the two-axis inbox.
    @StateObject private var reconcileVM = ReconcileViewModel()
    @State private var agingBuckets: [AgingBucket] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isRefetching = false
    @State private var refetchMessage: String?
    @State private var detailEntry: LedgerEntryForErp?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                autoReconcileBanner

                if isLoading || reconcileVM.isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 100)
                }

                if let errorMessage {
                    erpErrorBanner(errorMessage)
                }

                if let vmError = reconcileVM.errorMessage {
                    erpErrorBanner(vmError)
                }

                if let info = reconcileVM.infoMessage {
                    reconcileInfoBanner(info)
                }

                if let refetchMessage {
                    erpSuccessBanner(refetchMessage)
                }

                if !agingBuckets.isEmpty {
                    agingSection
                }

                refetchButton

                ReconcileInboxSubview(
                    entries: reconcileVM.entries,
                    isLoading: reconcileVM.isLoading,
                    onRowTap: { entry in detailEntry = entry }
                )
            }
            .padding(16)
        }
        .task { await loadAll() }
        .navigationDestination(item: $detailEntry) { entry in
            ReconcileDetailView(entry: entry, viewModel: reconcileVM) {
                detailEntry = nil
            }
        }
    }

    private var autoReconcileBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Auto-Reconcile")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Coming soon — automatic fee matching is in development.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
        }
        .padding(14)
        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var agingSection: some View {
        // Only render aging when at least one bucket has entries — empty
        // buckets are aesthetic noise on a clean inbox.
        let visible = agingBuckets.filter { $0.count > 0 }
        return Group {
            if !visible.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    erpSectionHeader("AGING BUCKETS")

                    ForEach(visible) { bucket in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(bucket.displayLabel)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                            Spacer()
                            Text("\(bucket.count)")
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        .padding(12)
                        .background(bucket.cutoffWarning == true ? HobbyIQTheme.Colors.danger.opacity(0.08) : HobbyIQTheme.Colors.cardNavy)
                        .overlay {
                            if bucket.cutoffWarning == true {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(HobbyIQTheme.Colors.danger.opacity(0.4), lineWidth: 1.5)
                            } else {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                        if bucket.cutoffWarning == true {
                            HStack(spacing: 4) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption2)
                                Text("Entries older than 60 days — reconcile soon to ensure accurate reporting.")
                                    .font(.caption2)
                            }
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                        }
                    }
                }
            }
        }
    }

    private var refetchButton: some View {
        Button {
            Task { await refetch() }
        } label: {
            HStack(spacing: 6) {
                if isRefetching {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue).controlSize(.small)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.semibold))
                }
                Text(isRefetching ? "Syncing…" : "Sync eBay finances")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(isRefetching)
        .accessibilityLabel(isRefetching ? "Syncing eBay finances" : "Sync eBay finances")
    }

    private func loadAll() async {
        // Aging buckets are supplementary axis-1 metadata — never surface
        // their failure as the main inbox banner. A decode mismatch or
        // 5xx on /unreconciled/aging logs to console only; the inbox
        // continues to render. VM errors (the actual inbox path) render
        // through reconcileVM's own errorMessage publisher.
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        async let inbox: Void = reconcileVM.load()
        do {
            let aging = try await APIService.shared.fetchAgingBuckets()
            agingBuckets = aging.buckets
        } catch {
            #if DEBUG
            print("[Financials] aging fetch failed (non-fatal): \(APIService.errorMessage(from: error))")
            #endif
            agingBuckets = []
        }
        await inbox
    }

    private func refetch() async {
        isRefetching = true
        refetchMessage = nil
        defer { isRefetching = false }

        do {
            let response = try await APIService.shared.refetchFinances()
            refetchMessage = response.message ?? "Updated \(response.updated ?? 0) entries"
            await loadAll()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Override Sheet

private struct ERPOverrideSheet: View {
    let entry: LedgerEntryForErp
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var useNetPayout = true
    @State private var netPayoutText = ""
    @State private var finalValueFeeText = ""
    @State private var paymentProcessingFeeText = ""
    @State private var promotedListingFeeText = ""
    @State private var adFeeText = ""
    @State private var otherFeesText = ""
    @State private var shippingCostText = ""
    @State private var reason = ""
    @State private var isSaving = false
    @State private var localError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(entry.playerName ?? "Unknown")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if let cardName = entry.cardName {
                        Text(cardName)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }

                    if let adjustments = entry.feeAdjustments, !adjustments.isEmpty {
                        auditTrailSection(adjustments)
                    }

                    Picker("Override Mode", selection: $useNetPayout) {
                        Text("Net Payout (preferred)").tag(true)
                        Text("Granular Fees").tag(false)
                    }
                    .pickerStyle(.segmented)

                    if useNetPayout {
                        erpTextField(title: "Net Payout", text: $netPayoutText)
                    } else {
                        erpTextField(title: "Final Value Fee", text: $finalValueFeeText)
                        erpTextField(title: "Payment Processing", text: $paymentProcessingFeeText)
                        erpTextField(title: "Promoted Listing", text: $promotedListingFeeText)
                        erpTextField(title: "Ad Fee", text: $adFeeText)
                        erpTextField(title: "Other Fees", text: $otherFeesText)
                        erpTextField(title: "Shipping Cost", text: $shippingCostText)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Reason (required)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        TextField("Why are you overriding?", text: $reason)
                            .textFieldStyle(.plain)
                            .padding(14)
                            .background(AppColors.surfaceElevated)
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(AppColors.border, lineWidth: 1.6)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }

                    if let localError {
                        Text(localError)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.danger)
                    }

                    Button("Save Override") {
                        Task { await saveOverride() }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isSaving || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(16)
            }
            .background { HobbyIQBackground() }
            .navigationTitle("Manual Override")
            .navigationBarTitleDisplayMode(.inline)
            .themedNavigationSurface()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .onAppear {
            netPayoutText = entry.netPayout.map { String(format: "%.2f", $0) } ?? ""
            finalValueFeeText = entry.finalValueFee.map { String(format: "%.2f", $0) } ?? ""
            paymentProcessingFeeText = entry.paymentProcessingFee.map { String(format: "%.2f", $0) } ?? ""
            promotedListingFeeText = entry.promotedListingFee.map { String(format: "%.2f", $0) } ?? ""
            adFeeText = entry.adFee.map { String(format: "%.2f", $0) } ?? ""
            otherFeesText = entry.otherFees.map { String(format: "%.2f", $0) } ?? ""
            shippingCostText = entry.actualShippingCost.map { String(format: "%.2f", $0) } ?? ""
        }
    }

    private func auditTrailSection(_ adjustments: [FeeAdjustment]) -> some View {
        FeeAdjustmentAuditList(adjustments: adjustments)
    }

    private func saveOverride() async {
        let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedReason.isEmpty else {
            localError = "Reason is required."
            return
        }

        var fees = ERPOverrideFees()
        if useNetPayout {
            guard let np = Double(netPayoutText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                localError = "Enter a valid net payout."
                return
            }
            fees.netPayout = np
        } else {
            fees.finalValueFee = Double(finalValueFeeText.trimmingCharacters(in: .whitespacesAndNewlines))
            fees.paymentProcessingFee = Double(paymentProcessingFeeText.trimmingCharacters(in: .whitespacesAndNewlines))
            fees.promotedListingFee = Double(promotedListingFeeText.trimmingCharacters(in: .whitespacesAndNewlines))
            fees.adFee = Double(adFeeText.trimmingCharacters(in: .whitespacesAndNewlines))
            fees.otherFees = Double(otherFeesText.trimmingCharacters(in: .whitespacesAndNewlines))
            fees.actualShippingCost = Double(shippingCostText.trimmingCharacters(in: .whitespacesAndNewlines))
            let hasAnyFee = [fees.finalValueFee, fees.paymentProcessingFee, fees.promotedListingFee,
                             fees.adFee, fees.otherFees, fees.actualShippingCost].compactMap({ $0 }).count > 0
            guard hasAnyFee else {
                localError = "Enter at least one fee value."
                return
            }
        }

        isSaving = true
        localError = nil
        defer { isSaving = false }

        do {
            _ = try await APIService.shared.submitOverride(
                entryId: entry.id,
                request: ERPOverrideRequest(reason: trimmedReason, fees: fees)
            )
            onSaved()
            dismiss()
        } catch {
            #if DEBUG
            print("[Financials] save error: \(APIService.errorMessage(from: error))")
            #endif
            localError = "Couldn't save — try again."
        }
    }
}

// MARK: - 6.2 P&L + Analytics

struct ERPPnlView: View {
    @State private var selectedTab: PnlTab = .pnl
    @State private var pnlGroupBy = "month"
    @State private var includeExpenses = false
    @State private var analyticsGroupBy = "month"
    @State private var pnl: ERPPnlResponse?
    @State private var analytics: ERPAnalyticsResponse?
    @State private var timeseries: ERPTimeseriesResponse?
    @State private var valuation: ERPValuationResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private enum PnlTab: String, CaseIterable { case pnl = "P&L"; case analytics = "Analytics"; case timeseries = "Timeseries"; case valuation = "Valuation" }
    private let groupOptions = ["month", "player", "source", "category"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("View", selection: $selectedTab) {
                    ForEach(PnlTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 100)
                }

                if let errorMessage { erpErrorBanner(errorMessage) }

                switch selectedTab {
                case .pnl: pnlContent
                case .analytics: analyticsContent
                case .timeseries: timeseriesContent
                case .valuation: valuationContent
                }
            }
            .padding(16)
        }
        .task { await loadAll() }
    }

    @ViewBuilder
    private var pnlContent: some View {
        // Period-aware Sold/Fees/Net summary lives on the Financials hub
        // (single source). This tab is the breakdown view (by month/player/
        // source/category).
        HStack {
            Picker("Group by", selection: $pnlGroupBy) {
                ForEach(groupOptions, id: \.self) { Text($0.capitalized).tag($0) }
            }
            .pickerStyle(.menu)
            Toggle("Expenses", isOn: $includeExpenses)
                .tint(HobbyIQTheme.Colors.electricBlue)
                .font(.caption)
        }
        .onChange(of: pnlGroupBy) { _, _ in Task { await loadPnl() } }
        .onChange(of: includeExpenses) { _, _ in Task { await loadPnl() } }

        if let totals = pnl?.totals {
            erpTotalsCard(totals)
        }

        if let groups = pnl?.groups {
            ForEach(groups) { group in
                erpPnlGroupRow(group)
            }
        }
    }

    @ViewBuilder
    private var analyticsContent: some View {
        Picker("Group by", selection: $analyticsGroupBy) {
            ForEach(groupOptions, id: \.self) { Text($0.capitalized).tag($0) }
        }
        .pickerStyle(.segmented)
        .onChange(of: analyticsGroupBy) { _, _ in Task { await loadAnalytics() } }

        if let groups = analytics?.groups {
            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(group.key)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    HStack(spacing: 16) {
                        erpMetric("Margin", value: group.margin.map { String(format: "%.1f%%", $0) } ?? "—")
                        erpMetric("ROI", value: group.roi.map { String(format: "%.1f%%", $0) } ?? "—")
                        erpMetric("Sell-Thru", value: group.sellThrough.map { String(format: "%.0f%%", $0) } ?? "—")
                    }
                    HStack(spacing: 16) {
                        erpMetric("Avg Days", value: group.avgDaysToSell.map { String(format: "%.0f", $0) } ?? "—")
                        erpMetric("Count", value: "\(group.count ?? 0)")
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            }
        }
    }

    @ViewBuilder
    private var timeseriesContent: some View {
        if let points = timeseries?.points, !points.isEmpty {
            ForEach(points) { point in
                HStack {
                    Text(point.period)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        if let pnl = point.pnl {
                            Text(pnl.portfolioSignedCurrencyText)
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(pnl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                        }
                        if let rev = point.revenue {
                            Text("Rev \(rev.portfolioCurrencyText)")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        } else if !isLoading {
            erpEmptyState(icon: "chart.line.uptrend.xyaxis", title: "No Data", message: "Sell cards to populate the timeseries.")
        }
    }

    @ViewBuilder
    private var valuationContent: some View {
        if let val = valuation {
            HStack(spacing: 0) {
                erpMetricCard("Total Cost", value: val.totalCost?.portfolioCurrencyText ?? "—")
                erpMetricCard("Value", value: val.totalCurrentValue?.portfolioCurrencyText ?? "—")
                erpMetricCard("Unrealized", value: val.totalUnrealizedPnL?.portfolioSignedCurrencyText ?? "—",
                              color: (val.totalUnrealizedPnL ?? 0) >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }

            if let holdings = val.holdings {
                ForEach(holdings) { h in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.playerName ?? "Unknown")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            if let card = h.cardName {
                                Text(card)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .lineLimit(1)
                            }
                            HStack(spacing: 6) {
                                freshnessPill(h.freshness)
                                if h.fullPosition == true {
                                    Text("Full")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 2)
                                        .background(HobbyIQTheme.Colors.electricBlue.opacity(0.15))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text((h.currentValue ?? 0).portfolioCurrencyText)
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            if let pnl = h.unrealizedPnL {
                                Text(pnl.portfolioSignedCurrencyText)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(pnl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                            }
                        }
                    }
                    .padding(12)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }

    private func loadAll() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let p = APIService.shared.fetchErpPnl(groupBy: pnlGroupBy, includeExpenses: includeExpenses)
            async let a = APIService.shared.fetchErpAnalytics(groupBy: analyticsGroupBy)
            async let t = APIService.shared.fetchErpTimeseries()
            async let v = APIService.shared.fetchErpValuation()
            let (pr, ar, tr, vr) = try await (p, a, t, v)
            pnl = pr; analytics = ar; timeseries = tr; valuation = vr
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func loadPnl() async {
        do {
            pnl = try await APIService.shared.fetchErpPnl(groupBy: pnlGroupBy, includeExpenses: includeExpenses)
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func loadAnalytics() async {
        do {
            analytics = try await APIService.shared.fetchErpAnalytics(groupBy: analyticsGroupBy)
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - 6.3 Expenses

struct ERPExpensesView: View {
    @State private var expenses: [ERPExpenseEntry] = []
    @State private var report: ERPExpenseReportResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showAddSheet = false
    @State private var editingExpense: ERPExpenseEntry?
    @State private var selectedTab: ExpTab = .list
    @State private var reportGroupBy = "category"

    private enum ExpTab: String, CaseIterable { case list = "List"; case report = "Report" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("View", selection: $selectedTab) {
                    ForEach(ExpTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 60)
                }

                if let errorMessage { erpErrorBanner(errorMessage) }

                switch selectedTab {
                case .list: expenseListContent
                case .report: expenseReportContent
                }
            }
            .padding(16)
        }
        .task { await loadExpenses() }
        .navigationDestination(isPresented: $showAddSheet) {
            ERPExpenseFormSheet(existing: nil) {
                Task { await loadExpenses() }
            }
        }
        .navigationDestination(item: $editingExpense) { exp in
            ERPExpenseFormSheet(existing: exp) {
                Task { await loadExpenses() }
            }
        }
    }

    @ViewBuilder
    private var expenseListContent: some View {
        Button { showAddSheet = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle.fill")
                Text("Add Expense")
            }
            .font(.subheadline.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)

        if expenses.isEmpty && !isLoading {
            erpEmptyState(icon: "creditcard", title: "No Expenses", message: "Track business expenses for tax reporting.")
        } else {
            ForEach(expenses) { exp in
                Button { editingExpense = exp } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(exp.categoryEnum?.displayName ?? exp.category ?? "Unknown")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            if let desc = exp.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .lineLimit(1)
                            }
                            if let date = exp.date {
                                Text(date)
                                    .font(.caption2)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            }
                        }
                        Spacer()
                        Text((exp.amount ?? 0).portfolioCurrencyText)
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    .padding(12)
                    .background(HobbyIQTheme.Colors.cardNavy)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var expenseReportContent: some View {
        Picker("Group by", selection: $reportGroupBy) {
            Text("Category").tag("category")
            Text("Month").tag("month")
        }
        .pickerStyle(.segmented)
        .onChange(of: reportGroupBy) { _, _ in Task { await loadReport() } }

        if let total = report?.total {
            HStack {
                Text("Total")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(total.portfolioCurrencyText)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            .padding(14)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        if let groups = report?.groups {
            ForEach(groups) { group in
                HStack {
                    Text(group.key)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text((group.total ?? 0).portfolioCurrencyText)
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text("\(group.count ?? 0) entries")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func loadExpenses() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let e = APIService.shared.fetchExpenses()
            async let r = APIService.shared.fetchExpenseReport(groupBy: reportGroupBy)
            let (eResult, rResult) = try await (e, r)
            expenses = eResult.expenses ?? []
            report = rResult
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func loadReport() async {
        do {
            report = try await APIService.shared.fetchExpenseReport(groupBy: reportGroupBy)
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Expense Form Sheet

private struct ERPExpenseFormSheet: View {
    let existing: ERPExpenseEntry?
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedCategory: ERPExpenseCategory = .supplies
    @State private var amountText = ""
    @State private var descriptionText = ""
    @State private var categoryNote = ""
    @State private var expenseDate = Date()
    @State private var isSaving = false
    @State private var isDeleting = false
    @State private var localError: String?

    private var isEditing: Bool { existing != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(isEditing ? "Edit Expense" : "Add Expense")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Category")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Picker("Category", selection: $selectedCategory) {
                        ForEach(ERPExpenseCategory.allCases) { cat in
                            Text(cat.displayName).tag(cat)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(HobbyIQTheme.Colors.electricBlue)
                }

                if selectedCategory.requiresNote {
                    erpTextField(title: "Category Note (required)", text: $categoryNote)
                }

                erpTextField(title: "Amount", text: $amountText, keyboard: .decimalPad)
                erpTextField(title: "Description", text: $descriptionText)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Date")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    DatePicker("", selection: $expenseDate, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .tint(HobbyIQTheme.Colors.electricBlue)
                }

                if let localError {
                    Text(localError)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                }

                Button(isEditing ? "Update" : "Save") {
                    Task { await save() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSaving)

                if isEditing {
                    Button(role: .destructive) {
                        Task { await deleteExpense() }
                    } label: {
                        HStack {
                            if isDeleting { ProgressView().controlSize(.small) }
                            Text("Delete Expense")
                        }
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                    }
                    .disabled(isDeleting)
                }
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle(isEditing ? "Edit Expense" : "New Expense")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .onAppear {
            if let exp = existing {
                selectedCategory = exp.categoryEnum ?? .other
                amountText = exp.amount.map { String(format: "%.2f", $0) } ?? ""
                descriptionText = exp.description ?? ""
                categoryNote = exp.categoryNote ?? ""
            }
        }
    }

    private func save() async {
        guard let amount = Double(amountText.trimmingCharacters(in: .whitespacesAndNewlines)), amount > 0 else {
            localError = "Enter a valid amount."
            return
        }
        if selectedCategory.requiresNote && categoryNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            localError = "Category note is required for 'Other'."
            return
        }

        isSaving = true
        localError = nil
        defer { isSaving = false }

        let dateStr = ISO8601DateFormatter().string(from: expenseDate)
        let desc = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = categoryNote.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            if let exp = existing {
                _ = try await APIService.shared.updateExpense(
                    expenseId: exp.id,
                    request: ERPExpenseUpdateRequest(
                        category: selectedCategory.rawValue,
                        amount: amount,
                        description: desc.isEmpty ? nil : desc,
                        categoryNote: note.isEmpty ? nil : note,
                        date: dateStr
                    )
                )
            } else {
                _ = try await APIService.shared.createExpense(
                    request: ERPExpenseCreateRequest(
                        category: selectedCategory.rawValue,
                        amount: amount,
                        description: desc.isEmpty ? nil : desc,
                        categoryNote: note.isEmpty ? nil : note,
                        date: dateStr
                    )
                )
            }
            onSaved()
            dismiss()
        } catch {
            #if DEBUG
            print("[Financials] save error: \(APIService.errorMessage(from: error))")
            #endif
            localError = "Couldn't save — try again."
        }
    }

    private func deleteExpense() async {
        guard let exp = existing else { return }
        isDeleting = true
        do {
            _ = try await APIService.shared.deleteExpense(expenseId: exp.id)
            onSaved()
            dismiss()
        } catch {
            #if DEBUG
            print("[Financials] save error: \(APIService.errorMessage(from: error))")
            #endif
            localError = "Couldn't save — try again."
        }
        isDeleting = false
    }
}

// MARK: - 6.4 Trades

struct ERPTradesView: View {
    @State private var trades: [ERPTradeTransaction] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showRecordSheet = false
    @State private var selectedTrade: ERPTradeTransaction?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Button { showRecordSheet = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.circle.fill")
                        Text("Record Trade")
                    }
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .overlay(
                        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
                }
                .buttonStyle(.plain)

                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 60)
                }

                if let errorMessage { erpErrorBanner(errorMessage) }

                if trades.isEmpty && !isLoading && errorMessage == nil {
                    erpEmptyState(icon: "arrow.triangle.swap", title: "No Trades", message: "Record card trades to track cost basis adjustments.")
                } else {
                    ForEach(trades) { trade in
                        Button { selectedTrade = trade } label: {
                            tradeRow(trade)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
        .task { await loadTrades() }
        .navigationDestination(isPresented: $showRecordSheet) {
            ERPRecordTradeSheet {
                Task { await loadTrades() }
            }
        }
        .navigationDestination(item: $selectedTrade) { trade in
            ERPTradeDetailSheet(trade: trade)
        }
    }

    private func tradeRow(_ trade: ERPTradeTransaction) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Trade")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let date = trade.date {
                    Text(date)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                HStack(spacing: 8) {
                    Text("\(trade.outgoing?.count ?? 0) out")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                    Text("\(trade.incoming?.count ?? 0) in")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let cash = trade.cashToMe {
                    Text(cash >= 0 ? "+\(cash.portfolioCurrencyText)" : cash.portfolioCurrencyText)
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(cash >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    Text("cash")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                if let gl = trade.totals?.realizedGainLoss {
                    Text(gl.portfolioSignedCurrencyText)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(gl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                }
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func loadTrades() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchTrades()
            trades = response.trades ?? []
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Record Trade Sheet

private struct ERPRecordTradeSheet: View {
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var outgoingHoldingId = ""
    @State private var outgoingFmv = ""
    @State private var outgoingFmvSource = "compiq"
    @State private var incomingTitle = ""
    @State private var incomingFmv = ""
    @State private var incomingFmvSource = "compiq"
    @State private var cashToMeText = "0"
    @State private var notes = ""
    @State private var tradeDate = Date()
    @State private var isSaving = false
    @State private var localError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Record Trade")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                Text("cashToMe is signed: positive = you received cash, negative = you paid cash.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                erpSectionHeader("OUTGOING (your card)")
                erpTextField(title: "Holding ID", text: $outgoingHoldingId)
                erpTextField(title: "FMV at Trade", text: $outgoingFmv, keyboard: .decimalPad)
                Picker("FMV Source", selection: $outgoingFmvSource) {
                    Text("CompIQ").tag("compiq")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)

                erpSectionHeader("INCOMING (their card)")
                erpTextField(title: "Card Title", text: $incomingTitle)
                erpTextField(title: "FMV at Trade", text: $incomingFmv, keyboard: .decimalPad)
                Picker("FMV Source", selection: $incomingFmvSource) {
                    Text("CompIQ").tag("compiq")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)

                erpSectionHeader("CASH")
                erpTextField(title: "Cash To Me (signed)", text: $cashToMeText, keyboard: .numbersAndPunctuation)

                erpTextField(title: "Notes", text: $notes)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Trade Date")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    DatePicker("", selection: $tradeDate, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .tint(HobbyIQTheme.Colors.electricBlue)
                }

                if let localError {
                    Text(localError)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                }

                Button("Submit Trade") {
                    Task { await submitTrade() }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSaving)
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Record Trade")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private func submitTrade() async {
        let holdingId = outgoingHoldingId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !holdingId.isEmpty else { localError = "Enter the outgoing holding ID."; return }
        guard let outFmv = Double(outgoingFmv.trimmingCharacters(in: .whitespacesAndNewlines)), outFmv > 0 else {
            localError = "Enter a valid outgoing FMV."; return
        }
        let inTitle = incomingTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !inTitle.isEmpty else { localError = "Enter the incoming card title."; return }
        guard let inFmv = Double(incomingFmv.trimmingCharacters(in: .whitespacesAndNewlines)), inFmv > 0 else {
            localError = "Enter a valid incoming FMV."; return
        }
        guard let cash = Double(cashToMeText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            localError = "Enter a valid cash amount (use negative if you paid)."; return
        }

        isSaving = true
        localError = nil
        defer { isSaving = false }

        let request = ERPTradeRecordRequest(
            outgoing: [ERPTradeOutgoingItem(holdingId: holdingId, fmvAtTrade: outFmv, fmvSource: outgoingFmvSource)],
            incoming: [ERPTradeIncomingItem(
                cardTitle: inTitle,
                fmvAtTrade: inFmv,
                fmvSource: incomingFmvSource,
                playerName: nil,
                cardYear: nil,
                setName: nil,
                parallel: nil,
                grade: nil,
                gradeCompany: nil,
                gradeValue: nil,
                cardId: nil
            )],
            cashToMe: cash,
            note: notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes,
            tradeDate: ISO8601DateFormatter().string(from: tradeDate)
        )

        do {
            _ = try await APIService.shared.recordTrade(request: request)
            onSaved()
            dismiss()
        } catch {
            #if DEBUG
            print("[Financials] save error: \(APIService.errorMessage(from: error))")
            #endif
            localError = "Couldn't save — try again."
        }
    }
}

// MARK: - Trade Detail Sheet

private struct ERPTradeDetailSheet: View {
    let trade: ERPTradeTransaction

    @State private var detail: ERPTradeTransaction?
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var resolved: ERPTradeTransaction { detail ?? trade }

    var body: some View {
        ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if isLoading {
                        ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                    }

                    if let errorMessage { erpErrorBanner(errorMessage) }

                    if let totals = resolved.totals {
                        totalsSection(totals)
                    }

                    if let outgoing = resolved.outgoing, !outgoing.isEmpty {
                        erpSectionHeader("OUTGOING")
                        ForEach(outgoing) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.playerName ?? item.holdingId ?? "Unknown")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                if let card = item.cardName {
                                    Text(card)
                                        .font(.caption)
                                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                }
                                erpDataRow("FMV at Trade", value: (item.fmvAtTrade ?? 0).portfolioCurrencyText)
                                erpDataRow("FMV Source", value: item.fmvSource ?? "—")
                                if let cost = item.costBasis {
                                    erpDataRow("Cost Basis", value: cost.portfolioCurrencyText)
                                }
                                if let proceeds = item.proceedsAllocated {
                                    erpDataRow("Proceeds Allocated", value: proceeds.portfolioCurrencyText)
                                }
                                if let gl = item.realizedGL {
                                    erpDataRow("Realized G/L", value: gl.portfolioSignedCurrencyText)
                                }
                            }
                            .padding(12)
                            .background(HobbyIQTheme.Colors.cardNavy)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }

                    if let incoming = resolved.incoming, !incoming.isEmpty {
                        erpSectionHeader("INCOMING")
                        ForEach(incoming) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.cardTitle ?? "Unknown")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                erpDataRow("FMV at Trade", value: (item.fmvAtTrade ?? 0).portfolioCurrencyText)
                                erpDataRow("FMV Source", value: item.fmvSource ?? "—")
                                if let basis = item.newCostBasis {
                                    erpDataRow("New Cost Basis", value: basis.portfolioCurrencyText)
                                }
                            }
                            .padding(12)
                            .background(HobbyIQTheme.Colors.cardNavy)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }

                    if let notes = resolved.notes, !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Notes")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(notes)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        .padding(12)
                        .background(HobbyIQTheme.Colors.cardNavy)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(16)
            }
        .background { HobbyIQBackground() }
        .navigationTitle("Trade Detail")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task { await loadDetail() }
    }

    private func totalsSection(_ totals: ERPTradeTotals) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            erpSectionHeader("TOTALS")
            if let fmvOut = totals.totalFmvOut { erpDataRow("Total FMV Out", value: fmvOut.portfolioCurrencyText) }
            if let fmvIn = totals.totalFmvIn { erpDataRow("Total FMV In", value: fmvIn.portfolioCurrencyText) }
            if let cash = totals.cashToMe {
                erpDataRow("Cash To Me", value: cash >= 0 ? "+\(cash.portfolioCurrencyText)" : cash.portfolioCurrencyText)
            }
            if let gl = totals.realizedGainLoss {
                HStack {
                    Text("Realized G/L")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(gl.portfolioSignedCurrencyText)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(gl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                }
            }
            if let bc = totals.balanceCheck {
                erpDataRow("Balance Check", value: String(format: "%.2f", bc))
            }
        }
        .padding(12)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func loadDetail() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await APIService.shared.fetchTradeDetail(tradeId: trade.id)
            detail = response.trade
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - 6.5 Tax / Accounting Export

struct ERPTaxView: View {
    @State private var selectedYear = Calendar.current.component(.year, from: Date())
    @State private var filings: ERPTaxFilingsResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var editingRail: ERPTaxFilingRail?
    @State private var reportedGrossText = ""
    @State private var isSavingFiling = false
    @State private var filingError: String?
    @State private var exportURL: URL?
    @State private var showShareSheet = false

    private let yearRange = (Calendar.current.component(.year, from: Date()) - 5)...(Calendar.current.component(.year, from: Date()))

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Tax Year", selection: $selectedYear) {
                    ForEach(yearRange.reversed(), id: \.self) { Text(String($0)).tag($0) }
                }
                .pickerStyle(.menu)
                .tint(HobbyIQTheme.Colors.electricBlue)
                .onChange(of: selectedYear) { _, _ in Task { await loadFilings() } }

                if isLoading {
                    ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        .frame(maxWidth: .infinity, minHeight: 60)
                }

                if let errorMessage { erpErrorBanner(errorMessage) }

                filingsSection
                exportSection
            }
            .padding(16)
        }
        .task { await loadFilings() }
        .sheet(isPresented: $showShareSheet) {
            if let url = exportURL {
                ERPShareSheet(url: url)
            }
        }
    }

    @ViewBuilder
    private var filingsSection: some View {
        erpSectionHeader("1099-K FILINGS")

        if let rails = filings?.rails, !rails.isEmpty {
            ForEach(rails) { rail in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(rail.rail.capitalized)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        HIQHelpButton(
                            title: "Payment Rail",
                            message: "The payment processor that handled this sale (eBay, PayPal, Stripe, etc.). Each issues its own 1099-K, so we track and reconcile them separately."
                        )
                        Spacer()
                        Button("Edit") {
                            editingRail = rail
                            reportedGrossText = rail.reportedGross1099K.map { String(format: "%.2f", $0) } ?? ""
                        }
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    }
                    erpDataRow("Reported Gross", value: (rail.reportedGross1099K ?? 0).portfolioCurrencyText)
                    erpDataRow("Computed Gross", value: (rail.computedGross ?? 0).portfolioCurrencyText)
                    if let delta = rail.delta {
                        HStack {
                            Text("Delta")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                            Text(delta.portfolioSignedCurrencyText)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(abs(delta) < 0.01 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                        }
                    }
                    erpDataRow("Transactions", value: "\(rail.transactionCount ?? 0)")
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        } else if !isLoading {
            erpEmptyState(icon: "doc.text", title: "No Filings", message: "1099-K filings for \(selectedYear) will appear here.")
        }

        if editingRail != nil {
            filingEditCard
        }
    }

    private var filingEditCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Edit \(editingRail?.rail.capitalized ?? "") Reported Gross")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            erpTextField(title: "Reported Gross 1099-K", text: $reportedGrossText, keyboard: .decimalPad)
            if let filingError {
                Text(filingError)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.danger)
            }
            HStack {
                Button("Cancel") { editingRail = nil }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Button("Save") { Task { await saveFiling() } }
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .disabled(isSavingFiling)
            }
        }
        .padding(14)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var exportSection: some View {
        erpSectionHeader("EXPORTS")

        HStack(spacing: 12) {
            exportButton(title: "Accounting CSV") { await exportAccounting(format: "csv") }
            exportButton(title: "Accounting JSON") { await exportAccounting(format: "json") }
        }
        HStack(spacing: 12) {
            exportButton(title: "Tax CSV") { await exportTax(format: "csv") }
            exportButton(title: "Tax JSON") { await exportTax(format: "json") }
        }
    }

    private func exportButton(title: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "square.and.arrow.up")
                    .font(.caption2.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.08))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func loadFilings() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            filings = try await APIService.shared.fetchTaxFilings(year: selectedYear)
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func saveFiling() async {
        guard let rail = editingRail else { return }
        guard let amount = Double(reportedGrossText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            filingError = "Enter a valid amount."
            return
        }
        isSavingFiling = true
        filingError = nil
        defer { isSavingFiling = false }
        do {
            _ = try await APIService.shared.updateTaxFiling(
                year: selectedYear,
                rail: rail.rail,
                request: ERPTaxFilingUpdateRequest(reportedGross1099K: amount)
            )
            editingRail = nil
            await loadFilings()
        } catch {
            filingError = APIService.errorMessage(from: error)
        }
    }

    private func exportAccounting(format: String) async {
        do {
            let response = try await APIService.shared.fetchAccountingExport(year: selectedYear, format: format)
            if let rows = response.rows {
                let url = writeExportFile(name: "accounting_\(selectedYear).\(format)", rows: rows, format: format)
                exportURL = url
                showShareSheet = true
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func exportTax(format: String) async {
        do {
            let response = try await APIService.shared.fetchTaxExport(year: selectedYear, format: format)
            if let rows = response.rows {
                let url = writeTaxExportFile(name: "tax_\(selectedYear).\(format)", rows: rows, format: format)
                exportURL = url
                showShareSheet = true
            }
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    private func writeExportFile(name: String, rows: [ERPAccountingExportRow], format: String) -> URL? {
        let dir = FileManager.default.temporaryDirectory
        let fileURL = dir.appendingPathComponent(name)
        do {
            if format == "csv" {
                var csv = "date,description,amount,category,type,reference\n"
                for row in rows {
                    csv += "\(row.date ?? ""),\"\(row.description ?? "")\",\(row.amount ?? 0),\(row.category ?? ""),\(row.type ?? ""),\(row.reference ?? "")\n"
                }
                try csv.write(to: fileURL, atomically: true, encoding: .utf8)
            } else {
                let data = try JSONEncoder().encode(rows)
                try data.write(to: fileURL)
            }
            return fileURL
        } catch {
            return nil
        }
    }

    private func writeTaxExportFile(name: String, rows: [ERPTaxExportRow], format: String) -> URL? {
        let dir = FileManager.default.temporaryDirectory
        let fileURL = dir.appendingPathComponent(name)
        do {
            if format == "csv" {
                var csv = "saleDate,description,proceeds,costBasis,gainLoss,holdingPeriod,rail\n"
                for row in rows {
                    csv += "\(row.saleDate ?? ""),\"\(row.description ?? "")\",\(row.proceeds ?? 0),\(row.costBasis ?? 0),\(row.gainLoss ?? 0),\(row.holdingPeriod ?? ""),\(row.rail ?? "")\n"
                }
                try csv.write(to: fileURL, atomically: true, encoding: .utf8)
            } else {
                let data = try JSONEncoder().encode(rows)
                try data.write(to: fileURL)
            }
            return fileURL
        } catch {
            return nil
        }
    }
}

// MARK: - Share Sheet

struct ERPShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Shared ERP Helpers

// CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the shared
// HIQSectionHeader. Existing all-caps strings ("AGING BUCKETS",
// "OVERRIDE HISTORY", etc.) round-trip cleanly through the auto-
// uppercase pass.
private func erpSectionHeader(_ title: String) -> some View {
    HIQSectionHeader(title)
}

/// Calm fallback for any failed fetch in Financials. Never surfaces raw
/// route/HTTP strings — `message` is logged to the console only.
private func erpErrorBanner(_ message: String, onRetry: (() -> Void)? = nil) -> some View {
    #if DEBUG
    let _ = { print("[Financials] load error: \(message)") }()
    #endif
    return HStack(spacing: 10) {
        Image(systemName: "exclamationmark.circle")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.warning)
        Text("Couldn't load — retry.")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        Spacer(minLength: 8)
        if let onRetry {
            Button("Retry", action: onRetry)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule(style: .continuous))
                .buttonStyle(.plain)
        }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(HobbyIQTheme.Colors.warning.opacity(0.08))
    .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(HobbyIQTheme.Colors.warning.opacity(0.28), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func erpSuccessBanner(_ message: String) -> some View {
    HStack(spacing: 8) {
        Image(systemName: "checkmark.circle.fill")
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
        Text(message)
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
    .padding(12)
    .background(HobbyIQTheme.Colors.successGreen.opacity(0.1))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func erpEmptyState(icon: String, title: String, message: String) -> some View {
    VStack(spacing: 12) {
        Image(systemName: icon)
            .font(.system(size: 28, weight: .semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Text(title)
            .font(.headline.bold())
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        Text(message)
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(24)
    .background(HobbyIQTheme.Colors.cardNavy)
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
}

private func erpTextField(title: String, text: Binding<String>, keyboard: UIKeyboardType = .default) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        TextField(title, text: text)
            .keyboardType(keyboard)
            .textFieldStyle(.plain)
            .padding(14)
            .background(AppColors.surfaceElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(AppColors.border, lineWidth: 1.6)
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

private func erpLedgerRow(_ entry: LedgerEntryForErp) -> some View {
    HStack {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(entry.playerName ?? "Unknown")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if entry.isEbaySource {
                    Text("eBay")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color(hex: 0x3665F3).opacity(0.8))
                        .clipShape(Capsule())
                }
            }
            if let cardName = entry.cardName {
                Text(cardName)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }
            if let soldAt = entry.soldAt {
                Text(soldAt.prefix(10))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
            Text((entry.salePrice ?? 0).portfolioCurrencyText)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let pnl = entry.realizedProfitLoss {
                Text(pnl.portfolioSignedCurrencyText)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(pnl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }
        }
    }
    .padding(12)
    .background(HobbyIQTheme.Colors.cardNavy)
    .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func erpDataRow(_ label: String, value: String) -> some View {
    HStack {
        Text(label)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Spacer()
        Text(value)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

private func erpMetric(_ label: String, value: String) -> some View {
    VStack(spacing: 2) {
        Text(label)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Text(value)
            .font(.caption.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

private func erpMetricCard(_ label: String, value: String, color: Color = HobbyIQTheme.Colors.pureWhite) -> some View {
    VStack(spacing: 4) {
        Text(label)
            .font(.caption2.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Text(value)
            .font(.subheadline.weight(.bold))
            .foregroundStyle(color)
    }
    .frame(maxWidth: .infinity)
    .padding(12)
    .background(HobbyIQTheme.Colors.cardNavy)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func erpTotalsCard(_ totals: ERPPnlTotals) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 0) {
            erpMetric("Gross", value: (totals.grossProceeds ?? 0).portfolioCurrencyText)
            Spacer()
            erpMetric("Fees", value: (totals.totalFees ?? 0).portfolioCurrencyText)
            Spacer()
            erpMetric("Net", value: (totals.netProceeds ?? 0).portfolioCurrencyText)
        }
        HStack(spacing: 0) {
            erpMetric("Cost", value: (totals.costBasis ?? 0).portfolioCurrencyText)
            Spacer()
            VStack(spacing: 2) {
                Text("P&L")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text((totals.realizedPnL ?? 0).portfolioSignedCurrencyText)
                    .font(.caption.weight(.bold))
                    .foregroundStyle((totals.realizedPnL ?? 0) >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }
            Spacer()
            if let netPnL = totals.netPnL {
                erpMetric("Net P&L", value: netPnL.portfolioSignedCurrencyText)
            }
        }
        if let count = totals.count {
            Text("\(count) transactions")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }
    .padding(14)
    .background(HobbyIQTheme.Colors.cardNavy)
    .overlay(
        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
    )
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
}

private func erpPnlGroupRow(_ group: ERPPnlGroup) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        HStack {
            Text(group.key)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            if let count = group.count {
                Text("\(count)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        HStack(spacing: 0) {
            erpMetric("Revenue", value: (group.grossProceeds ?? 0).portfolioCurrencyText)
            Spacer()
            erpMetric("Fees", value: (group.totalFees ?? 0).portfolioCurrencyText)
            Spacer()
            VStack(spacing: 2) {
                Text("P&L")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text((group.realizedPnL ?? 0).portfolioSignedCurrencyText)
                    .font(.caption.weight(.bold))
                    .foregroundStyle((group.realizedPnL ?? 0) >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }
        }
    }
    .padding(12)
    .background(HobbyIQTheme.Colors.cardNavy)
    .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

private func freshnessPill(_ freshness: String?) -> some View {
    let label = freshness ?? "unknown"
    let color: Color = {
        switch label.lowercased() {
        case "fresh": return HobbyIQTheme.Colors.successGreen
        case "stale": return .orange
        case "missing": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.mutedText
        }
    }()

    return Text(label.capitalized)
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(color)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(color.opacity(0.15))
        .clipShape(Capsule())
}

// MARK: - 6.1b Reconcile Inbox + Detail (CF-PR-E-IOS-PHASE-1B, 2026-06-16)
//
// The new two-axis reconciliation surface. ReconcileInboxSubview swaps in
// where the legacy unreconciledSection used to render; ReconcileDetailView
// is a push (not sheet) host for the four-section detail. Both consume
// ReconcileViewModel as the single source of truth; identity helpers are
// fileprivate so #Preview blocks can call them without a view instance.

struct ReconcileInboxSubview: View {
    let entries: [LedgerEntryForErp]
    let isLoading: Bool
    let onRowTap: (LedgerEntryForErp) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            erpSectionHeader("UNRECONCILED (\(entries.count))")

            if entries.isEmpty {
                if !isLoading {
                    erpEmptyState(
                        icon: "checkmark.seal",
                        title: "All caught up",
                        message: "No sales need reconciling right now."
                    )
                }
            } else {
                ForEach(entries) { entry in
                    Button {
                        onRowTap(entry)
                    } label: {
                        reconcileInboxRow(entry)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private func reconcileInboxRow(_ entry: LedgerEntryForErp) -> some View {
    HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
            Text(reconcileIdentityLine(for: entry))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
                .truncationMode(.tail)
            HStack(spacing: 6) {
                reconcileStatusChip(for: entry)
                Text(reconcileSoldAgoText(for: entry))
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 4) {
            Text((entry.salePrice ?? entry.grossProceeds ?? 0).portfolioCurrencyText)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
        }
    }
    .padding(12)
    .background(HobbyIQTheme.Colors.cardNavy)
    .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(Color.white.opacity(0.06), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

@ViewBuilder
private func reconcileStatusChip(for entry: LedgerEntryForErp) -> some View {
    // Server is the source of truth for costsStatus; chip is purely a
    // visual translation of the enum. Calm-only palette: warning amber
    // for needsAction, muted gray for savedPendingFees, never red.
    switch entry.costsStatusEnum {
    case .needsAction:
        reconcileChip(text: "Add cost basis", color: HobbyIQTheme.Colors.warning)
    case .savedPendingFees:
        reconcileChip(text: "Fees pending", color: HobbyIQTheme.Colors.mutedText)
    case .none:
        EmptyView()
    }
}

private func reconcileChip(text: String, color: Color) -> some View {
    Text(text)
        .font(.caption2.weight(.bold))
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.14))
        .clipShape(Capsule(style: .continuous))
}

fileprivate func reconcileIdentityLine(for entry: LedgerEntryForErp) -> String {
    // Backend's PortfolioLedgerEntry carries playerName + cardTitle only —
    // no year/set/parallel/grade on the ledger row. v1 renders the
    // "player — title" pair from the entry itself. A holdings join via
    // PortfolioIQViewModel.inventoryCards (matched on holdingId) can
    // upgrade this to a rich set/year/parallel/grade line later without
    // touching the row layout.
    let player = (entry.playerName ?? "").trimmingCharacters(in: .whitespaces)
    let title = entry.displayCardTitle ?? ""
    switch (player.isEmpty, title.isEmpty) {
    case (false, false): return "\(player) — \(title)"
    case (false, true):  return player
    case (true, false):  return title
    case (true, true):   return "Unknown sale"
    }
}

fileprivate func reconcileSoldAgoText(for entry: LedgerEntryForErp) -> String {
    guard let soldAt = entry.soldAt,
          let date = reconcileParseDate(soldAt) else {
        return "sold recently"
    }
    let days = Calendar.current.dateComponents([.day], from: date, to: Date()).day ?? 0
    if days <= 0 { return "sold today" }
    if days == 1 { return "sold 1d ago" }
    return "sold \(days)d ago"
}

fileprivate func reconcileSoldDateText(for entry: LedgerEntryForErp) -> String {
    guard let soldAt = entry.soldAt,
          let date = reconcileParseDate(soldAt) else {
        return entry.soldAt.map { String($0.prefix(10)) } ?? "—"
    }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

fileprivate func reconcileParseDate(_ iso: String) -> Date? {
    let fmtFrac = ISO8601DateFormatter()
    fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fmtStd = ISO8601DateFormatter()
    fmtStd.formatOptions = [.withInternetDateTime]
    return fmtFrac.date(from: iso) ?? fmtStd.date(from: iso)
}

/// Calm info banner — used for VM-published infoMessage (e.g. 409 conflict
/// responses). Never red. Electric-blue accent matches the autoReconcile
/// banner so it reads as informational, not a warning.
private func reconcileInfoBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Image(systemName: "info.circle")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
        Text(message)
            .font(.caption)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .multilineTextAlignment(.leading)
        Spacer(minLength: 8)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.08))
    .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}

// MARK: - Reconcile Detail View

struct ReconcileDetailView: View {
    let entry: LedgerEntryForErp
    @ObservedObject var viewModel: ReconcileViewModel
    let onFinalized: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var gradingCostText: String
    @State private var suppliesCostText: String
    @State private var isSaving = false
    @State private var isDismissing = false
    @State private var localError: String?
    @State private var showCloseWithoutFeesConfirm = false

    init(entry: LedgerEntryForErp, viewModel: ReconcileViewModel, onFinalized: @escaping () -> Void) {
        self.entry = entry
        self.viewModel = viewModel
        self.onFinalized = onFinalized
        _gradingCostText = State(initialValue: entry.gradingCost.map { String(format: "%.2f", $0) } ?? "")
        _suppliesCostText = State(initialValue: entry.suppliesCost.map { String(format: "%.2f", $0) } ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                identityHeader

                if let info = viewModel.infoMessage {
                    reconcileInfoBanner(info)
                }
                if let err = localError {
                    erpErrorBanner(err)
                }

                saleSection
                ebayFeesSection
                costBasisSection
                realizedGainSection

                actionButtons
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Reconcile sale")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    // MARK: Header

    private var identityHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(reconcileIdentityLine(for: entry))
                .font(.title3.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                reconcileStatusChip(for: entry)
                Text(reconcileSoldAgoText(for: entry))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Sale

    private var saleSection: some View {
        PortfolioContextCard(title: "Sale · from eBay") {
            detailDataRow(label: "Sale price", value: (entry.salePrice ?? entry.grossProceeds ?? 0).portfolioCurrencyText)
            detailDataRow(label: "Sold", value: reconcileSoldDateText(for: entry))
            if let order = entry.ebayOrderId, !order.isEmpty {
                detailDataRow(label: "eBay order", value: order)
            }
        }
    }

    // MARK: eBay fees (read-only in v1 per scope)

    private var ebayFeesSection: some View {
        PortfolioContextCard(title: "eBay fees") {
            feeRow(label: "Final-value fee", value: entry.finalValueFee)
            feeRow(label: "Payment processing", value: entry.paymentProcessingFee)
            feeRow(label: "Promoted listing", value: entry.promotedListingFee)
            feeRow(label: "Ad fee", value: entry.adFee)
            feeRow(label: "Other fees", value: entry.otherFees)
            feeRow(label: "Actual shipping", value: entry.actualShippingCost)

            Rectangle()
                .fill(Color.white.opacity(0.06))
                .frame(height: 1)
                .padding(.vertical, 2)

            feeRow(label: "Net payout", value: entry.netPayout, emphasized: true)

            if entry.hasPendingFees {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.caption2)
                    Text("Pending from eBay")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func feeRow(label: String, value: Double?, emphasized: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(emphasized ? .semibold : .medium))
                .foregroundStyle(emphasized ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
            Spacer()
            if let value {
                Text(value.portfolioCurrencyText)
                    .font(.subheadline.weight(emphasized ? .bold : .medium).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            } else {
                Text("—")
                    .font(.subheadline.weight(.medium).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: Your cost basis

    private var costBasisSection: some View {
        PortfolioContextCard(title: "Your cost basis") {
            HStack {
                Text("Acquisition")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text((entry.costBasisSold ?? 0).portfolioCurrencyText)
                    .font(.subheadline.weight(.medium).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Image(systemName: "lock.fill")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            }

            costInputRow(label: "Grading cost", text: $gradingCostText)
            costInputRow(label: "Supplies cost", text: $suppliesCostText)

            Text("Costs lock once reconciled.")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(.top, 4)
        }
    }

    @ViewBuilder
    private func costInputRow(label: String, text: Binding<String>) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer(minLength: 8)
            TextField("0.00", text: text)
                .keyboardType(.decimalPad)
                .textFieldStyle(.plain)
                .multilineTextAlignment(.trailing)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(AppColors.surfaceElevated)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(AppColors.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .frame(maxWidth: 140)
        }
    }

    // MARK: Realized gain

    private var realizedGainSection: some View {
        PortfolioContextCard(title: "Realized gain") {
            HStack {
                Text("Realized P&L")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                let pnl = entry.realizedProfitLoss ?? 0
                Text(pnl.portfolioSignedCurrencyText)
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(pnl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }

            if entry.hasPendingFees {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.caption2)
                    Text("Provisional — fees pending")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .padding(.top, 4)
                if let missing = entry.missingFields, !missing.isEmpty {
                    Text("Awaiting: \(missing.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Actions

    private var actionButtons: some View {
        VStack(spacing: 10) {
            Button {
                Task { await saveCosts() }
            } label: {
                HStack(spacing: 8) {
                    if isSaving {
                        ProgressView().tint(.white).controlSize(.small)
                    }
                    Text(isSaving ? "Saving…" : "Save cost basis")
                        .font(.subheadline.weight(.bold))
                }
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(HobbyIQTheme.Colors.electricBlue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isSaving || isDismissing)

            // CF-RECONCILE-FINALIZE (backend PR #390): only shows when
            // the sale is an eBay entry AND has waited >48h AND all
            // granular fees are still nil. Confirms via a modal
            // dialog because the finalize is not reversible.
            if showCloseWithoutFeesButton {
                Button {
                    showCloseWithoutFeesConfirm = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.caption.weight(.bold))
                        Text("Close without eBay fees")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                    .background(HobbyIQTheme.Colors.warning.opacity(0.14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isSaving || isDismissing)
                .confirmationDialog(
                    "Close without eBay fees?",
                    isPresented: $showCloseWithoutFeesConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Close with $0 fees", role: .destructive) {
                        Task { await finalizeWithoutFees() }
                    }
                    Button("Cancel", role: .cancel) { }
                } message: {
                    Text("This entry will be closed with $0 seller fees. Realized P&L uses netPayout. If eBay's fees arrive later, we'll keep your manual close.")
                }
            }

            Button {
                Task { await quietForNow() }
            } label: {
                Text(isDismissing ? "Quieting…" : "Quiet for now")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .buttonStyle(.plain)
            .disabled(isSaving || isDismissing)
        }
        .padding(.top, 4)
    }

    private func detailDataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.trailing)
        }
    }

    // MARK: Mutations

    private func saveCosts() async {
        let g = parseCost(gradingCostText)
        let s = parseCost(suppliesCostText)
        if case .invalid(let label) = g {
            localError = "\(label) must be a non-negative number."
            return
        }
        if case .invalid(let label) = s {
            localError = "\(label) must be a non-negative number."
            return
        }

        isSaving = true
        localError = nil
        defer { isSaving = false }

        // CF-RECONCILE-EMPTY-COSTS (2026-07-12): backend requires the
        // body to include gradingCost and/or suppliesCost — nil-for-
        // both returns 400 and the entry silently sticks in the queue.
        // When the user submits with both blank, treat as "no costs"
        // and default supplies to $0 so the finalize can proceed.
        let gradingValue = g.value(label: "Grading cost")
        var suppliesValue = s.value(label: "Supplies cost")
        if gradingValue == nil && suppliesValue == nil {
            suppliesValue = 0
        }

        let updated = await viewModel.saveCosts(
            entryId: entry.id,
            gradingCost: gradingValue,
            suppliesCost: suppliesValue
        )
        guard let updated else {
            // Backend rejected the save (e.g. validation, offline).
            localError = viewModel.errorMessage ?? "Couldn't save. Try again."
            return
        }
        if updated.needsReconciliation == false {
            // Both axes are done — cleanly finalized.
            onFinalized()
            dismiss()
            return
        }

        // Costs axis is closed but fees axis is still waiting on eBay's
        // finances feed (typically 24–48h). Keep the row on-screen with
        // an inline hint; the "Close without eBay fees" secondary
        // button (rendered only after 48h has elapsed) is the escape
        // hatch that calls the new `/finalize` endpoint (PR #390) and
        // asserts $0 fees explicitly.
        localError = "Costs saved. Waiting on eBay fees to arrive (usually 24–48h)."
    }

    /// CF-RECONCILE-FINALIZE (backend PR #390): unconditional finalize
    /// path used by the "Close without eBay fees" secondary button. Only
    /// enabled when the entry has waited >48h and every granular fee
    /// field is still nil. Modal confirm before firing.
    private func finalizeWithoutFees() async {
        isSaving = true
        localError = nil
        defer { isSaving = false }
        let netPayout = entry.grossProceeds
        let finalized = await viewModel.finalize(
            entryId: entry.id,
            reason: "user-marked-no-fees",
            netPayout: netPayout
        )
        if finalized?.needsReconciliation == false {
            onFinalized()
            dismiss()
        } else if finalized == nil {
            localError = viewModel.errorMessage ?? "Couldn't finalize. Try again."
        }
    }

    /// True when the wire entry has no fee data at all — meaning eBay's
    /// finances feed hasn't landed yet.
    private var entryHasNoFeeData: Bool {
        entry.finalValueFee == nil
            && entry.paymentProcessingFee == nil
            && entry.promotedListingFee == nil
            && entry.adFee == nil
            && (entry.otherFees ?? 0) == 0
    }

    /// True when it's been more than 48h since the sale — the window
    /// after which the "Close without eBay fees" affordance becomes
    /// visible so the user isn't stuck on a permanently-pending row.
    private var entryOlderThan48Hours: Bool {
        guard let soldAt = entry.soldAt else { return false }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        let date = fmtFrac.date(from: soldAt) ?? fmtStd.date(from: soldAt)
        guard let sold = date else { return false }
        return Date().timeIntervalSince(sold) > (48 * 60 * 60)
    }

    /// Gate for the "Close without eBay fees" secondary CTA — only
    /// shows when the eBay finances feed is late AND all granular
    /// fees are still nil (i.e., the user genuinely has nothing to
    /// wait for). Manual entries never get this affordance (backend
    /// returns 400 `NOT_EBAY_ENTRY`).
    var showCloseWithoutFeesButton: Bool {
        entry.isEbaySource && entryHasNoFeeData && entryOlderThan48Hours
    }

    private func quietForNow() async {
        isDismissing = true
        localError = nil
        defer { isDismissing = false }
        await viewModel.dismiss(entryId: entry.id, reason: nil)
        // Dismiss is optimistic — entries dropped synchronously. Leave
        // detail regardless of error since the user's intent was "quiet."
        // A non-409 failure restores in VM and surfaces via errorMessage
        // on the inbox.
        onFinalized()
        dismiss()
    }

    private enum CostInput {
        case value(Double?)
        case invalid(String)

        func value(label: String) -> Double? {
            if case .value(let v) = self { return v }
            return nil
        }
    }

    private func parseCost(_ raw: String) -> CostInput {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .value(nil) }
        guard let v = Double(trimmed), v >= 0 else { return .invalid("Cost") }
        return .value(v)
    }
}

// MARK: - Preview fixtures (CF-PR-E-IOS-PHASE-1B)

#if DEBUG
extension LedgerEntryForErp {
    static func mockReconcile(
        id: String = UUID().uuidString,
        playerName: String? = "Leo De Vries",
        cardTitle: String? = "2024 Bowman Chrome Blue Refractor Auto /150 #BCA-LD",
        soldAt: String? = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 3)),
        salePrice: Double? = 1183,
        finalValueFee: Double? = 142.85,
        paymentProcessingFee: Double? = -2.25,
        promotedListingFee: Double? = 0,
        adFee: Double? = 0,
        otherFees: Double? = 0,
        actualShippingCost: Double? = 4.85,
        netPayout: Double? = 1042.55,
        costBasisSold: Double? = 350,
        gradingCost: Double? = nil,
        suppliesCost: Double? = nil,
        realizedProfitLoss: Double? = 690.15,
        missingFields: [String]? = [],
        costsStatus: String? = "needs_action",
        ebayOrderId: String? = "12-34567-12345",
        feeAdjustments: [FeeAdjustment]? = nil
    ) -> LedgerEntryForErp {
        LedgerEntryForErp(
            id: id,
            userId: "u-mock",
            holdingId: "h-mock",
            playerName: playerName,
            cardName: nil,
            cardTitle: cardTitle,
            year: nil,
            setName: nil,
            parallel: nil,
            grade: nil,
            salePrice: salePrice,
            grossProceeds: salePrice,
            netProceeds: netPayout,
            netPayout: netPayout,
            costBasisSold: costBasisSold,
            realizedProfitLoss: realizedProfitLoss,
            realizedProfitLossPct: nil,
            finalValueFee: finalValueFee,
            paymentProcessingFee: paymentProcessingFee,
            promotedListingFee: promotedListingFee,
            adFee: adFee,
            otherFees: otherFees,
            actualShippingCost: actualShippingCost,
            totalGranularFees: nil,
            source: "ebay",
            ebayOrderId: ebayOrderId,
            ebayItemId: nil,
            soldAt: soldAt,
            createdAt: nil,
            updatedAt: nil,
            reconciledAt: nil,
            needsReconciliation: true,
            dismissedAt: nil,
            dismissedReason: nil,
            fees: nil,
            tax: nil,
            shipping: nil,
            gradingCost: gradingCost,
            suppliesCost: suppliesCost,
            feeAdjustments: feeAdjustments,
            tradeId: nil,
            tradeRole: nil,
            userCostsProvidedAt: costsStatus == "saved_pending_fees" ? ISO8601DateFormatter().string(from: Date()) : nil,
            userCostsProvidedBy: nil,
            feeSource: missingFields?.isEmpty == true ? "ebay_finances" : nil,
            missingFields: missingFields,
            costsStatus: costsStatus
        )
    }
}

private struct ReconcileDetailPreviewWrapper: View {
    let entry: LedgerEntryForErp
    @StateObject private var vm = ReconcileViewModel()

    var body: some View {
        NavigationStack {
            ReconcileDetailView(entry: entry, viewModel: vm) {}
                .background { HobbyIQBackground() }
        }
    }
}

#Preview("Reconcile inbox · empty") {
    NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ReconcileInboxSubview(
                    entries: [],
                    isLoading: false,
                    onRowTap: { _ in }
                )
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
    }
}

#Preview("Reconcile inbox · mixed (needs + pending)") {
    let needs = LedgerEntryForErp.mockReconcile(
        playerName: "Leo De Vries",
        cardTitle: "2024 Bowman Chrome Blue Refractor Auto /150",
        soldAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 2)),
        salePrice: 1183,
        missingFields: ["finalValueFee", "netPayout"],
        costsStatus: "needs_action"
    )
    let pending = LedgerEntryForErp.mockReconcile(
        playerName: "Paul Skenes",
        cardTitle: "2024 Bowman Chrome Refractor #BCP-PS PSA 10",
        soldAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86400 * 8)),
        salePrice: 420,
        missingFields: ["netPayout"],
        costsStatus: "saved_pending_fees"
    )
    return NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ReconcileInboxSubview(
                    entries: [needs, pending],
                    isLoading: false,
                    onRowTap: { _ in }
                )
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
    }
}

#Preview("Detail · needs_action + fees pending") {
    ReconcileDetailPreviewWrapper(entry: LedgerEntryForErp.mockReconcile(
        finalValueFee: nil,
        paymentProcessingFee: nil,
        netPayout: nil,
        missingFields: ["finalValueFee", "paymentProcessingFee", "netPayout"],
        costsStatus: "needs_action"
    ))
}

#Preview("Detail · needs_action + fees populated") {
    ReconcileDetailPreviewWrapper(entry: LedgerEntryForErp.mockReconcile(
        missingFields: [],
        costsStatus: "needs_action"
    ))
}

#Preview("Detail · saved_pending_fees") {
    ReconcileDetailPreviewWrapper(entry: LedgerEntryForErp.mockReconcile(
        finalValueFee: nil,
        netPayout: nil,
        gradingCost: 22,
        suppliesCost: 3.5,
        missingFields: ["finalValueFee", "netPayout"],
        costsStatus: "saved_pending_fees"
    ))
}

#Preview("Detail · raw card 0/0") {
    ReconcileDetailPreviewWrapper(entry: LedgerEntryForErp.mockReconcile(
        playerName: "James Wood",
        cardTitle: "2024 Bowman Chrome Aqua Refractor /199 #BCP-JW (raw)",
        salePrice: 145,
        gradingCost: 0,
        suppliesCost: 0,
        missingFields: [],
        costsStatus: "saved_pending_fees"
    ))
}

// CF-PR-E-IOS-PHASE-1B sim-confirmation: the provisional-label section
// rides below the cost-basis fold in the full detail previews. This
// isolated wrapper forces the realized-gain card to the top of the
// canvas so the "Provisional — fees pending" + missingFields render
// can be inspected without scrolling.
private struct RealizedGainProvisionalPreview: View {
    let entry: LedgerEntryForErp
    @StateObject private var vm = ReconcileViewModel()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PortfolioContextCard(title: "Realized gain") {
                    HStack {
                        Text("Realized P&L")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        let pnl = entry.realizedProfitLoss ?? 0
                        Text(pnl.portfolioSignedCurrencyText)
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(pnl >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                    }
                    if entry.hasPendingFees {
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                                .font(.caption2)
                            Text("Provisional — fees pending")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding(.top, 4)
                        if let missing = entry.missingFields, !missing.isEmpty {
                            Text("Awaiting: \(missing.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
    }
}

#Preview("Realized gain · provisional + missing fields") {
    RealizedGainProvisionalPreview(entry: LedgerEntryForErp.mockReconcile(
        finalValueFee: nil,
        paymentProcessingFee: nil,
        netPayout: nil,
        realizedProfitLoss: 412.50,
        missingFields: ["finalValueFee", "paymentProcessingFee", "netPayout"],
        costsStatus: "saved_pending_fees"
    ))
}

// MARK: - Fee Adjustment audit fixtures (CF-PR-E-FEE-ADJUSTMENT-RESHAPE, 2026-06-17)

extension FeeAdjustment {
    /// Build a FeeAdjustmentValues snapshot by overlaying the supplied
    /// fee fields onto the default "all nil" state. The default mirrors
    /// the wire shape for an unenriched eBay row.
    static func mockValues(
        finalValueFee: Double? = nil,
        paymentProcessingFee: Double? = nil,
        promotedListingFee: Double? = nil,
        adFee: Double? = nil,
        otherFees: Double? = nil,
        netPayout: Double? = nil,
        actualShippingCost: Double? = nil,
        gradingCost: Double? = nil,
        suppliesCost: Double? = nil,
        userCostsProvidedAt: String? = nil,
        needsReconciliation: Bool? = true,
        reconciledVia: String? = nil
    ) -> FeeAdjustmentValues {
        FeeAdjustmentValues(
            finalValueFee: finalValueFee,
            paymentProcessingFee: paymentProcessingFee,
            promotedListingFee: promotedListingFee,
            adFee: adFee,
            otherFees: otherFees,
            netPayout: netPayout,
            actualShippingCost: actualShippingCost,
            gradingCost: gradingCost,
            suppliesCost: suppliesCost,
            userCostsProvidedAt: userCostsProvidedAt,
            needsReconciliation: needsReconciliation,
            reconciledVia: reconciledVia
        )
    }

    static func mockOverride(
        adjustmentId: String = UUID().uuidString,
        adjustedAt: String = ISO8601DateFormatter().string(from: Date()),
        adjustedBy: String = "u-mock",
        reason: String = "eBay Finances enrichment landed.",
        priorValues: FeeAdjustmentValues = .init(
            finalValueFee: nil, paymentProcessingFee: nil, promotedListingFee: nil,
            adFee: nil, otherFees: nil, netPayout: nil, actualShippingCost: nil,
            gradingCost: nil, suppliesCost: nil, userCostsProvidedAt: nil,
            needsReconciliation: true, reconciledVia: nil
        ),
        newValues: FeeAdjustmentValues
    ) -> FeeAdjustment {
        FeeAdjustment(
            adjustmentId: adjustmentId,
            adjustedAt: adjustedAt,
            adjustedBy: adjustedBy,
            reason: reason,
            priorValues: priorValues,
            newValues: newValues
        )
    }
}

private struct FeeAdjustmentAuditPreviewWrapper: View {
    let adjustments: [FeeAdjustment]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                FeeAdjustmentAuditList(adjustments: adjustments)
            }
            .padding(16)
        }
        .background { HobbyIQBackground() }
    }
}

#Preview("Audit · single-field override") {
    // One adjustment that touched only Net Payout — typical manual
    // override where the seller corrected a single missing fee.
    let single = FeeAdjustment.mockOverride(
        reason: "Corrected net payout from eBay Seller Hub.",
        priorValues: FeeAdjustment.mockValues(netPayout: nil),
        newValues:   FeeAdjustment.mockValues(netPayout: 1042.55)
    )
    return FeeAdjustmentAuditPreviewWrapper(adjustments: [single])
}

#Preview("Audit · multi-field override") {
    // One adjustment that filled every granular fee at once — typical
    // eBay Finances enrichment row.
    let multi = FeeAdjustment.mockOverride(
        reason: "eBay Finances enrichment landed — granular fees populated.",
        priorValues: FeeAdjustment.mockValues(),
        newValues:   FeeAdjustment.mockValues(
            finalValueFee: 142.85,
            paymentProcessingFee: 2.25,
            promotedListingFee: 0,
            adFee: 0,
            otherFees: 0,
            netPayout: 1042.55,
            actualShippingCost: 4.85
        )
    )
    return FeeAdjustmentAuditPreviewWrapper(adjustments: [multi])
}
#endif

// MARK: - Fee Adjustment audit list (CF-PR-E-FEE-ADJUSTMENT-RESHAPE 2026-06-17)
//
// Lives under the standard ERP section header (blue hairlines · TITLE ·
// blue hairlines) and renders each adjustment as a dashboardStroke-
// bordered card — the blue→green gradient chrome used everywhere else
// in the app (aging buckets, ledger rows, hero panels). Native feel.
//
// Each adjustment card carries:
//   • relative timestamp header ("Today", "Yesterday", "3 days ago",
//     "Apr 15") + quiet "audited" caption
//   • one row per changed field — label · prior → new, with the prior
//     muted and the new value highlighted in monospaced bold
//   • the reason rendered once below as a quiet caption with a
//     conversation glyph

struct FeeAdjustmentAuditList: View {
    let adjustments: [FeeAdjustment]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            erpSectionHeader("OVERRIDE HISTORY")

            ForEach(adjustments) { adj in
                FeeAdjustmentAuditRow(adjustment: adj)
            }
        }
    }
}

private struct FeeAdjustmentAuditRow: View {
    let adjustment: FeeAdjustment

    var body: some View {
        let changes = adjustment.changedFields
        VStack(alignment: .leading, spacing: 10) {
            timestampHeader

            if changes.isEmpty {
                // Defensive: backend emits an adjustment row even when no
                // fee field strictly changed (e.g. cost-only edits that
                // only stamp userCostsProvidedAt). Surface a calm marker
                // so the entry isn't visually empty.
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle")
                        .font(.caption2)
                    Text("Marked addressed")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(changes) { change in
                        changedRow(change)
                    }
                }
            }

            if !adjustment.reason.trimmingCharacters(in: .whitespaces).isEmpty {
                reasonBlock(adjustment.reason)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var timestampHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.9))
            Text(FeeAdjustmentTime.relative(adjustment.adjustedAt))
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("·")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("audited")
                .font(.caption2.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func changedRow(_ change: FeeAdjustment.ChangedField) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(change.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)

            Spacer(minLength: 8)

            // prior — muted; arrow — muted glyph; new — white bold mono.
            Text(formatCurrencyOrDash(change.prior))
                .font(.caption2.weight(.medium).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Image(systemName: "arrow.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text(formatCurrencyOrDash(change.new))
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    @ViewBuilder
    private func reasonBlock(_ reason: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "text.bubble")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                .padding(.top, 1)
            Text(reason)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func formatCurrencyOrDash(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.portfolioCurrencyText
    }
}

/// Relative-time formatter for fee-adjustment audit headers — matches
/// the "sold Nd ago" idiom used in the Reconcile inbox row. Today /
/// Yesterday / N days ago up to a week; absolute month-day past that.
enum FeeAdjustmentTime {
    static func relative(_ iso: String) -> String {
        let trimmed = iso.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return "Recent" }
        let fmtFrac = ISO8601DateFormatter()
        fmtFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fmtStd = ISO8601DateFormatter()
        fmtStd.formatOptions = [.withInternetDateTime]
        guard let date = fmtFrac.date(from: trimmed) ?? fmtStd.date(from: trimmed) else {
            return "Recent"
        }
        let cal = Calendar.current
        let now = Date()
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: date, to: now).day ?? 0
        if days >= 0 && days < 7 { return "\(days) days ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
