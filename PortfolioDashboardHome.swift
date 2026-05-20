import SwiftUI
import Charts

// MARK: - Dashboard Home Tab
struct PortfolioDashboardHome: View {
    @ObservedObject var vm: PortfolioIQViewModel
    var onAccount: (() -> Void)? = nil
    @State private var showLedger = false
    @State private var showDiversity = false
    @State private var showWhatIf = false

    private var totalValue: Double { vm.holdings.map { $0.currentValue }.reduce(0, +) }
    private var totalCost:  Double { vm.holdings.map { $0.totalCostBasis }.reduce(0, +) }
    private var totalPL:    Double { vm.holdings.map { $0.totalProfitLoss }.reduce(0, +) }
    private var totalPLPct: Double { totalCost > 0 ? (totalPL / totalCost) * 100 : 0 }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 20) {
                dashboardHeader
                whatIfBar
                if vm.isLoading {
                    LoadingSkeletonPortfolioView()
                } else if vm.holdings.isEmpty {
                    EmptyPortfolioView(onAdd: { vm.showAddCard = true })
                } else {
                    summarySection
                    healthSection
                    alertsSection
                    realizedSection
                    topMoversSection
                    aiRecommendationsSection
                    quickActionsSection
                    Spacer(minLength: 32)
                }
            }
            .padding(.horizontal)
            .padding(.top, 12)
        }
        .background(Color.black.ignoresSafeArea())
        .sheet(isPresented: $showLedger) {
            PortfolioLedgerView(
                entries: vm.ledgerEntries,
                realizedProfitLoss: vm.realizedProfitLoss,
                grossProceeds: vm.ledgerGrossProceeds,
                netProceeds: vm.ledgerNetProceeds,
                costBasisSold: vm.ledgerCostBasisSold
            )
            .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showDiversity) {
            PortfolioDiversityView(holdings: vm.holdings)
                .preferredColorScheme(.dark)
        }
        .sheet(isPresented: $showWhatIf) {
            WhatIfSheet()
        }
    }

    private var healthSection: some View {
        Group {
            if let health = vm.portfolioHealth {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Portfolio Health", systemImage: "heart.text.square.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)

                    VStack(spacing: 10) {
                        HStack {
                            Text("Health Score")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Spacer()
                            Text("\(health.score)/100")
                                .font(.system(size: 18, weight: .bold, design: .rounded))
                                .foregroundColor(health.score >= 75 ? .green : health.score >= 55 ? .orange : .red)
                        }

                        HStack(spacing: 8) {
                            healthPill(label: "Concentration", value: health.concentrationRisk)
                            healthPill(label: "Liquidity", value: health.liquidityRisk)
                            healthPill(label: "Staleness", value: health.staleDataRisk)
                            healthPill(label: "Downside", value: health.downsideRisk)
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemBackground).opacity(0.7))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    private var alertsSection: some View {
        Group {
            if !vm.portfolioAlerts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Priority Alerts", systemImage: "bell.badge.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)

                    VStack(spacing: 8) {
                        ForEach(Array(vm.portfolioAlerts.prefix(3)), id: \.id) { alert in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(alert.level.lowercased() == "critical" ? Color.red : alert.level.lowercased() == "warning" ? Color.orange : Color.blue)
                                    .frame(width: 8, height: 8)
                                    .padding(.top, 5)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(alert.playerName)
                                        .font(.caption.weight(.semibold))
                                        .foregroundColor(.white)
                                    Text(alert.message)
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                        .lineLimit(2)
                                }
                                Spacer()
                            }
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemBackground).opacity(0.7))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
        }
    }

    // MARK: - What-If Bar
    private var whatIfBar: some View {
        Button(action: { showWhatIf = true }) {
            HStack(spacing: 10) {
                Image(systemName: "sparkle.magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.purple)
                Text("What if I buy a card?")
                    .font(.subheadline)
                    .foregroundColor(Color(.systemGray2))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11))
                    .foregroundColor(Color(.systemGray4))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(Color.purple.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.purple.opacity(0.22), lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }

    // MARK: - Header
    private var dashboardHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "chart.pie.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.blue)
                    Text("PortfolioIQ")
                        .font(.title2).fontWeight(.bold)
                        .foregroundColor(.white)
                }
                Text("\(vm.holdings.count) card\(vm.holdings.count == 1 ? "" : "s")  •  Updated \(vm.lastRefresh, style: .relative) ago")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Spacer()
            Button(action: { onAccount?() }) {
                AccountButton(action: { onAccount?() })
            }
        }
    }

    // MARK: - Summary Card
    private var summarySection: some View {
        PortfolioSummaryCard(
            totalValue: totalValue,
            costBasis: totalCost,
            profit: totalPL,
            profitPct: totalPLPct,
            cardCount: vm.holdings.count,
            avgGainLoss: vm.holdings.isEmpty ? 0 : totalPL / Double(vm.holdings.count),
            lastRefresh: vm.lastRefresh,
            valueHistory: vm.valueHistory
        )
    }

    // MARK: - Realized P/L
    private var realizedSection: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Realized P/L", systemImage: "banknote.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)
                Spacer()
                Button("View Ledger") { showLedger = true }
                    .font(.caption)
                    .foregroundColor(.blue)
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)

            HStack(spacing: 0) {
                DashboardMetricTile(title: "Total Realized",
                                    value: vm.realizedProfitLoss >= 0 ? "+$\(Int(vm.realizedProfitLoss))" : "-$\(Int(abs(vm.realizedProfitLoss)))",
                                    color: vm.realizedProfitLoss >= 0 ? .green : .red)
                Divider().frame(height: 36).background(Color(.systemGray5))
                DashboardMetricTile(title: "Net Proceeds",
                                    value: "$\(Int(vm.ledgerNetProceeds))",
                                    color: .white)
                Divider().frame(height: 36).background(Color(.systemGray5))
                DashboardMetricTile(title: "Cost Basis Sold",
                                    value: "$\(Int(vm.ledgerCostBasisSold))",
                                    color: Color(.systemGray2))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            if let latest = vm.ledgerEntries.first {
                Divider().background(Color(.systemGray6))
                HStack {
                    Image(systemName: "clock.badge.checkmark")
                        .font(.caption)
                        .foregroundColor(.gray)
                    Text("Latest: \(latest.playerName) ×\(latest.quantitySold)")
                        .font(.caption)
                        .foregroundColor(.gray)
                    Spacer()
                    Text("\(latest.realizedProfitLoss >= 0 ? "+" : "")$\(latest.realizedProfitLoss, specifier: "%.2f")")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(latest.realizedProfitLoss >= 0 ? .green : .red)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            }
        }
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    // MARK: - Top Movers
    private var topMoversSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Top Movers", systemImage: "arrow.up.right.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)

            let sorted = vm.holdings.sorted { abs($0.totalProfitLoss) > abs($1.totalProfitLoss) }
            let gainers = sorted.filter { $0.totalProfitLoss > 0 }.prefix(3)
            let losers  = sorted.filter { $0.totalProfitLoss < 0 }.prefix(2)

            VStack(spacing: 6) {
                ForEach(Array(gainers), id: \.id) { h in
                    TopMoverRow(holding: h, onTap: { vm.showDetail = h })
                }
                if !losers.isEmpty {
                    Divider().background(Color(.systemGray5))
                    ForEach(Array(losers), id: \.id) { h in
                        TopMoverRow(holding: h, onTap: { vm.showDetail = h })
                    }
                }
            }
            .padding(12)
            .background(Color(.secondarySystemBackground).opacity(0.7))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    // MARK: - AI Recommendations
    private var aiRecommendationsSection: some View {
        let urgentHoldings = vm.holdings.filter { $0.sellUrgency > 60 }.prefix(2)
        let gradeCandidates = vm.holdings.filter {
            $0.isRaw && ($0.currentValue) > 80
        }.prefix(2)

        return Group {
            if !urgentHoldings.isEmpty || !gradeCandidates.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Label("AI Insights", systemImage: "brain.head.profile.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(.white)

                    VStack(spacing: 8) {
                        ForEach(Array(urgentHoldings), id: \.id) { h in
                            AIInsightCard(
                                icon: "dollarsign.circle.fill",
                                color: .orange,
                                title: "Sell Window: \(h.playerName)",
                                detail: "\(h.verdict). Est. \(h.expectedDaysToSell.map { "~\($0)d to sell" } ?? "active market").",
                                onTap: { vm.showDetail = h }
                            )
                        }
                        ForEach(Array(gradeCandidates), id: \.id) { h in
                            AIInsightCard(
                                icon: "seal.fill",
                                color: .purple,
                                title: "Grade Candidate: \(h.playerName)",
                                detail: "Raw value ~$\(Int(h.currentValue)). Grading may add significant premium.",
                                onTap: { vm.showDetail = h }
                            )
                        }
                    }
                }
            }
        }
    }

    // MARK: - Quick Actions
    private var quickActionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Quick Actions", systemImage: "bolt.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()),
                                 GridItem(.flexible()), GridItem(.flexible())],
                      spacing: 12) {
                QuickActionTile(icon: "plus.circle.fill", label: "Add Card",  color: .blue)  { vm.showAddCard = true }
                QuickActionTile(icon: "arrow.clockwise", label: "Refresh",    color: .green) { vm.refreshPortfolio() }
                QuickActionTile(icon: "wand.and.stars", label: "Batch Reprice", color: .purple) { vm.runBatchReprice() }
                QuickActionTile(icon: "chart.pie.fill",  label: "Diversity",  color: .orange) { showDiversity = true }
                QuickActionTile(icon: "banknote.fill",   label: "Ledger",     color: .teal)  { showLedger = true }
            }
        }
    }

    private func healthPill(label: String, value: Int) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(value >= 70 ? .red : value >= 45 ? .orange : .green)
            Text(label)
                .font(.system(size: 8, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Supporting Views

struct DashboardMetricTile: View {
    let title: String
    let value: String
    let color: Color
    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .foregroundColor(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(title)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
    }
}

struct TopMoverRow: View {
    let holding: PortfolioHolding
    var onTap: (() -> Void)? = nil
    var body: some View {
        Button(action: { onTap?() }) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.playerName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Text(holding.cardTitle)
                        .font(.caption2)
                        .foregroundColor(.gray)
                        .lineLimit(1)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("$\(holding.currentValue, specifier: "%.0f")")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(.white)
                    HStack(spacing: 2) {
                        Image(systemName: holding.totalProfitLoss >= 0 ? "arrow.up.right" : "arrow.down.right")
                            .font(.system(size: 8))
                        Text("\(holding.totalProfitLoss >= 0 ? "+" : "")$\(holding.totalProfitLoss, specifier: "%.0f")")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
                }
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(PlainButtonStyle())
    }
}

struct AIInsightCard: View {
    let icon: String
    let color: Color
    let title: String
    let detail: String
    var onTap: (() -> Void)? = nil
    var body: some View {
        Button(action: { onTap?() }) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .foregroundColor(color)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Text(detail)
                        .font(.caption)
                        .foregroundColor(.gray)
                        .lineLimit(2)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            .padding(12)
            .background(color.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(color.opacity(0.22), lineWidth: 1)
            )
        }
        .buttonStyle(PlainButtonStyle())
    }
}

struct QuickActionTile: View {
    let icon: String
    let label: String
    let color: Color
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(color)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.gray)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(color.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(PlainButtonStyle())
    }
}

// MARK: - What-If Sheet

struct WhatIfSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var playerName: String = ""
    @State private var product: String = ""
    @State private var parallel: String = ""
    @State private var buyPriceText: String = ""
    @State private var holdDays: Int = 30
    @State private var result: CompIQWhatIfResponse? = nil
    @State private var isLoading = false
    @State private var errorMsg: String? = nil

    @FocusState private var focusedField: WhatIfField?
    enum WhatIfField { case player, product, parallel, price }

    private let holdOptions = [7, 14, 30, 60, 90]

    private var buyPrice: Double? { Double(buyPriceText) }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 20) {
                    inputCard
                    runButton
                    if isLoading {
                        HStack(spacing: 10) {
                            ProgressView()
                                .tint(.purple)
                            Text("Analyzing scenarios…")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                    }
                    if let err = errorMsg {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.red)
                            Text(err)
                                .font(.subheadline)
                                .foregroundColor(.red)
                        }
                        .padding()
                    }
                    if let r = result {
                        scenarioSection(r)
                    }
                    Spacer(minLength: 32)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            .background(Color.black.ignoresSafeArea())
            .navigationTitle("What If I Buy?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(.purple)
                }
            }
            .onTapGesture { focusedField = nil }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: Input

    private var inputCard: some View {
        VStack(spacing: 0) {
            whatIfRow {
                TextField("Player Name", text: $playerName)
                    .focused($focusedField, equals: .player)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .product }
            } label: "Player"

            whatIfDivider
            whatIfRow {
                TextField("e.g. 2024 Bowman Chrome", text: $product)
                    .focused($focusedField, equals: .product)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .parallel }
            } label: "Product"

            whatIfDivider
            whatIfRow {
                TextField("e.g. Blue Refractor /150", text: $parallel)
                    .focused($focusedField, equals: .parallel)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .price }
            } label: "Parallel"

            whatIfDivider
            whatIfRow {
                HStack(spacing: 4) {
                    Text("$").foregroundColor(.gray)
                    TextField("Buy Price", text: $buyPriceText)
                        .keyboardType(.decimalPad)
                        .focused($focusedField, equals: .price)
                }
            } label: "Buy At"

            whatIfDivider
            HStack(spacing: 6) {
                Text("Hold")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .frame(width: 46, alignment: .leading)
                Spacer()
                ForEach(holdOptions, id: \.self) { days in
                    Button("\(days)d") { holdDays = days }
                        .font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(holdDays == days ? Color.purple : Color.white.opacity(0.06))
                        .foregroundColor(holdDays == days ? .white : .gray)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.purple.opacity(0.18), lineWidth: 1)
        )
    }

    private func whatIfRow<Content: View>(@ViewBuilder content: () -> Content, label: String) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.caption)
                .foregroundColor(.gray)
                .frame(width: 46, alignment: .leading)
            content()
                .font(.body)
                .foregroundColor(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
    }

    private var whatIfDivider: some View {
        Divider()
            .background(Color.white.opacity(0.08))
            .padding(.leading, 60)
    }

    // MARK: Run Button

    private var runButton: some View {
        Button {
            focusedField = nil
            guard !playerName.trimmingCharacters(in: .whitespaces).isEmpty else {
                errorMsg = "Player name is required."
                return
            }
            runWhatIf()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkle")
                Text(isLoading ? "Analyzing…" : "Run Scenarios")
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(isLoading ? Color.purple.opacity(0.5) : Color.purple)
            .foregroundColor(.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .disabled(isLoading)
    }

    // MARK: Scenarios

    private func scenarioSection(_ r: CompIQWhatIfResponse) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Scenario Analysis", systemImage: "chart.bar.xaxis")
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.white)

            VStack(spacing: 10) {
                WhatIfScenarioCard(
                    label: "Bear",
                    icon: "arrow.down.right.circle.fill",
                    color: .red,
                    scenario: r.scenarios.bear,
                    buyPrice: buyPrice
                )
                WhatIfScenarioCard(
                    label: "Base",
                    icon: "minus.circle.fill",
                    color: .blue,
                    scenario: r.scenarios.base,
                    buyPrice: buyPrice
                )
                WhatIfScenarioCard(
                    label: "Bull",
                    icon: "arrow.up.right.circle.fill",
                    color: .green,
                    scenario: r.scenarios.bull,
                    buyPrice: buyPrice
                )
            }

            if let bp = buyPrice {
                let breakEven = bp / (1.0 - 0.129)
                HStack {
                    Image(systemName: "equal.circle.fill")
                        .foregroundColor(.orange)
                    Text("Break-even sale price: \(breakEven.currencyFormatted)  (to clear 12.9% fees)")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                .padding(.horizontal, 4)
            }
        }
    }

    // MARK: API Call

    private func runWhatIf() {
        isLoading = true
        errorMsg = nil
        result = nil
        let req = CompIQWhatIfRequest(
            playerName: playerName.trimmingCharacters(in: .whitespaces),
            cardYear: nil,
            product: product.isEmpty ? nil : product,
            parallel: parallel.isEmpty ? nil : parallel,
            gradeCompany: nil,
            gradeValue: nil,
            isAuto: nil,
            buyPrice: buyPrice,
            holdDays: holdDays,
            feePct: 12.9,
            shippingCost: nil
        )
        Task {
            do {
                let r = try await APIService.shared.runCompIQWhatIf(request: req)
                await MainActor.run {
                    result = r
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    errorMsg = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }
}

// MARK: - Scenario Card

struct WhatIfScenarioCard: View {
    let label: String
    let icon: String
    let color: Color
    let scenario: CompIQScenarioResult
    let buyPrice: Double?

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundColor(color)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(label.uppercased())
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(color)
                Text("Sale ~\(scenario.projectedSalePrice.currencyFormatted)  ·  Net \(scenario.projectedNet.currencyFormatted)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(.white)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 4) {
                Text(scenario.pnl >= 0 ? "+\(scenario.pnl.currencyFormatted)" : scenario.pnl.currencyFormatted)
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundColor(scenario.pnl >= 0 ? .green : .red)
                Text("\(scenario.roiPct >= 0 ? "+" : "")\(String(format: "%.1f", scenario.roiPct))%")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(scenario.roiPct >= 0 ? .green.opacity(0.85) : .red.opacity(0.85))
            }
        }
        .padding(14)
        .background(color.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(color.opacity(0.20), lineWidth: 1)
        )
    }
}

struct PortfolioDashboardHome_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioDashboardHome(vm: PortfolioIQViewModel())
            .preferredColorScheme(.dark)
    }
}
