//
//  PortfolioIQView.swift
//  HobbyIQ
//

import SwiftUI

struct PortfolioIQView: View {
    @StateObject private var vm: PortfolioIQViewModel
    @State private var isAddingCard = false

    init(viewModel: PortfolioIQViewModel = PortfolioIQViewModel()) {
        _vm = StateObject(wrappedValue: viewModel)
    }

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
                        VStack(spacing: 20) {
                            header

                            if let errorMessage = vm.errorMessage {
                                warningBanner(message: errorMessage)
                            }

                            portfolioSnapshotSection
                            performanceSection

                            if vm.bestCardsToSellNow.isEmpty == false {
                                sellNowSection
                            }

                            collectionSection
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .padding(.bottom, 24)
                    }
                    .refreshable {
                        await vm.refresh()
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        Task { await vm.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .disabled(vm.isLoading)
                }
            }
            .sheet(isPresented: $isAddingCard) {
                AddPortfolioCardView(viewModel: AddPortfolioCardViewModel()) {
                    Task { await vm.refresh() }
                }
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
        Color(hex: 0x10131A).ignoresSafeArea()
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

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("PortfolioIQ")
                        .font(.largeTitle.bold())
                        .foregroundStyle(Color(hex: 0xE8EAF0))

                    Text("Manage cards, values, and sales signals.")
                        .font(.subheadline)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                }

                Spacer(minLength: 0)

                Button {
                    isAddingCard = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                        Text("Add")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(hex: 0xE8EAF0))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color(hex: 0x1A1D24))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(Color.white.opacity(0.08), lineWidth: 1)
                    )
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add Card")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: 112, alignment: .leading)
        .padding(16)
        .background(Color(hex: 0x171B24))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.25), radius: 10, x: 0, y: 4)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .hiqGlowSection(cornerRadius: 20)
    }

    private var portfolioSnapshotSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("PORTFOLIO SNAPSHOT")

            let summary = vm.inventorySummary ?? PortfolioInventorySummary(
                totalCost: 0,
                totalCurrentValue: 0,
                totalProfitLoss: 0,
                roi: 0,
                activeCount: 0
            )

            LazyVGrid(columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12)
            ], spacing: 12) {
                PortfolioMetricTile(
                    title: "Total Value",
                    value: summary.totalValueFormatted,
                    subtitle: "\(summary.activeCount) cards tracked",
                    subtitleColor: .green
                )

                PortfolioMetricTile(
                    title: "Total P/L",
                    value: summary.profitFormatted,
                    subtitle: "since cost basis",
                    subtitleColor: summary.totalProfitLoss >= 0 ? .green : .red
                )

                PortfolioMetricTile(
                    title: "ROI",
                    value: summary.roiFormatted,
                    subtitle: "return on investment",
                    subtitleColor: summary.roi >= 0 ? .green : .red
                )

                PortfolioMetricTile(
                    title: "Cost Basis",
                    value: summary.totalCostFormatted,
                    subtitle: "amount invested",
                    subtitleColor: .gray
                )
            }
        }
    }

    private var performanceSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("PERFORMANCE")

            HStack(spacing: 12) {
                PortfolioPerformanceCard(title: "THIS MONTH", stats: vm.monthStats)
                PortfolioPerformanceCard(title: "THIS YEAR", stats: vm.yearStats)
            }
            .padding(.horizontal)
        }
    }

    private var sellNowSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("🔥 SELL NOW")

            VStack(spacing: 0) {
                ForEach(Array(vm.bestCardsToSellNow.prefix(5).enumerated()), id: \.element.id) { index, card in
                    PortfolioBestSellRow(card: card)

                    if index < min(vm.bestCardsToSellNow.count, 5) - 1 {
                        Divider()
                            .overlay(Color.white.opacity(0.08))
                    }
                }
            }
            .background(Color(hex: 0x1A1D24))
            .cornerRadius(16)
            .padding(.horizontal)
        }
    }

    private var collectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("📦 MY COLLECTION")

            HStack {
                Text("\(vm.inventoryDetails.count) cards")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))

                Spacer()

                Text("Last updated \(vm.accountSnapshot?.generatedAtFormatted ?? "—")")
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
            .padding(.horizontal)

            if vm.inventoryDetails.isEmpty {
                portfolioEmptyState
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(vm.inventoryDetails.enumerated()), id: \.element.id) { index, card in
                        PortfolioCardRow(card: card)

                        if index < vm.inventoryDetails.count - 1 {
                            Divider()
                                .overlay(Color.white.opacity(0.08))
                        }
                    }
                }
                .background(Color(hex: 0x1A1D24))
                .cornerRadius(16)
                .padding(.horizontal)
            }
        }
    }

    private var portfolioEmptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Color(hex: 0x9CA3AF))

            Text("No cards yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)

            Text("Add your first card using the + button.")
                .font(.caption)
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(Color(hex: 0x1A1D24))
        .cornerRadius(16)
        .padding(.horizontal)
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
                .stroke(Color.orange.opacity(0.24), lineWidth: 1)
        )
        .cornerRadius(14)
        .padding(.horizontal)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.bold))
            .foregroundStyle(Color(hex: 0x9CA3AF))
            .tracking(1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
    }
}

private struct PortfolioMetricTile: View {
    let title: String
    let value: String
    let subtitle: String
    let subtitleColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(hex: 0x9CA3AF))

            Text(value)
                .font(.headline.bold())
                .foregroundStyle(.white)

            Text(subtitle)
                .font(.caption)
                .foregroundStyle(subtitleColor)
        }
        .padding(12)
        .background(Color(hex: 0x1A1D24))
        .cornerRadius(14)
    }
}

private struct PortfolioPerformanceCard: View {
    let title: String
    let stats: PortfolioPeriodStats?

    var body: some View {
        let resolvedStats = stats ?? PortfolioPeriodStats(
            totalSold: 0,
            totalProfit: 0,
            totalExpenses: nil,
            netProfit: nil,
            margin: 0
        )
        let netProfit = resolvedStats.netProfit ?? resolvedStats.totalProfit
        let netColor: Color = netProfit >= 0 ? .green : .red

        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color(hex: 0x9CA3AF))
                .tracking(1.2)

            Text(resolvedStats.netProfitFormatted)
                .font(.headline.bold())
                .foregroundStyle(netColor)

            Text(resolvedStats.marginFormatted)
                .font(.caption)
                .foregroundStyle(Color(hex: 0x9CA3AF))

            Divider()
                .overlay(Color.white.opacity(0.08))

            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Sold")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Text(resolvedStats.totalSoldFormatted)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 4) {
                    Text("Fees")
                        .font(.caption2)
                        .foregroundStyle(Color(hex: 0x9CA3AF))
                    Text(resolvedStats.totalExpensesFormatted)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(hex: 0x1A1D24))
        .cornerRadius(14)
    }
}

private struct PortfolioBestSellRow: View {
    let card: PortfolioBestSellCard

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(card.playerName)
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)

                Text(card.cardName)
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))

                Text(card.recommendation)
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 6) {
                Text(portfolioSignalBadgeText(card.signal))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(card.signalColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(card.signalColor.opacity(0.15))
                    .cornerRadius(5)

                Text(card.roiFormatted)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(card.roi >= 0 ? .green : .red)

                Text(card.profitFormatted)
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
        }
        .padding(12)
    }
}

private struct PortfolioCardRow: View {
    let card: PortfolioCardDetail

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(card.signalColor)
                .frame(width: 8, height: 8)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 6) {
                Text(card.playerName)
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)

                Text(card.cardName)
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 4) {
                Text(card.currentValueFormatted)
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)

                Text(card.profitFormatted)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(card.profitLoss >= 0 ? .green : .red)

                Text(card.roiFormatted)
                    .font(.caption2)
                    .foregroundStyle(Color(hex: 0x9CA3AF))
            }
        }
        .padding(12)
    }
}

private func portfolioSignalBadgeText(_ rawValue: String?) -> String {
    let trimmed = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard trimmed.isEmpty == false else {
        return "N/A"
    }

    return trimmed
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .uppercased()
}

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
    PortfolioIQView(viewModel: PortfolioIQViewModel(initialSummary: .previewSample))
}
