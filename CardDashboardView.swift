// CardDashboardView.swift
// PortfolioIQ — portfolio dashboard calculated 100% from real saved cards.
// No hardcoded numbers. Empty state shown when collection is empty.

import SwiftUI
import SwiftData

struct CardDashboardView: View {
    @Environment(\.modelContext) private var context

    @Query private var allCards: [CardItem]
    @State private var showAddCard = false

    // MARK: - Computed metrics (all live from real data)

    private var ownedCards: [CardItem]   { allCards.filter { !$0.isSold } }
    private var soldCards:  [CardItem]   { allCards.filter {  $0.isSold } }

    private var totalValue:    Double { ownedCards.reduce(0) { $0 + $1.currentValue } }
    private var totalCost:     Double { ownedCards.reduce(0) { $0 + $1.purchasePrice } }
    private var unrealizedGL:  Double { totalValue - totalCost }
    private var unrealizedROI: Double { totalCost > 0 ? (unrealizedGL / totalCost) * 100 : 0 }

    private var realizedProfit: Double {
        soldCards.compactMap { $0.saleRecord?.netProfit }.reduce(0, +)
    }

    private var rawCount:    Int { ownedCards.filter {  $0.isRaw }.count }
    private var gradedCount: Int { ownedCards.filter { !$0.isRaw }.count }

    private var topCards: [CardItem] {
        ownedCards.sorted { $0.currentValue > $1.currentValue }.prefix(5).map { $0 }
    }
    private var recentCards: [CardItem] {
        allCards.sorted { $0.createdAt > $1.createdAt }.prefix(5).map { $0 }
    }

    // MARK: - Body

    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            ZStack {
                ScrollView {
                    if allCards.isEmpty {
                        emptyState
                            .padding(.top, 80)
                    } else {
                        dashboardContent
                    }
                }
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button(action: { showScanner = true }) {
                            ZStack {
                                Circle().fill(Color.blue).frame(width: 60, height: 60)
                                Image(systemName: "camera.viewfinder")
                                    .font(.system(size: 28, weight: .medium))
                                    .foregroundColor(.white)
                            }
                        }
                        .shadow(radius: 4)
                        .padding([.bottom, .trailing], 24)
                    }
                }
            }
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showAddCard = true
                    } label: {
                        Label("Add Card", systemImage: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAddCard) {
                AddCardView()
            }
            .navigationDestination(for: CardItem.self) { card in
                CardDetailView(card: card, onMarkSold: nil)
            }
            .fullScreenCover(isPresented: $showScanner) {
                CardScannerView()
            }
            // Silent background refresh on dashboard open, then a periodic
            // re-check every 30 min while the view stays visible. Each card
            // is still gated by a 6-hour per-card cooldown, so this is cheap.
            .task {
                await InventoryRefreshService.runPeriodic(
                    cardsProvider: { allCards.filter { !$0.isSold } },
                    context: context
                )
            }
            // Pull-to-refresh forces a pass (still respects the 6h cooldown).
            .refreshable {
                await InventoryRefreshService.refreshStaleCards(ownedCards, context: context)
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 22) {
            Image(systemName: "chart.bar.xaxis")
                .font(.system(size: 64))
                .foregroundStyle(.blue.opacity(0.6))

            Text("No cards yet.")
                .font(.title2)
                .fontWeight(.semibold)

            Text("Add your first card to start tracking\nvalue, profit, and grading decisions.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                showAddCard = true
            } label: {
                Label("Add Card", systemImage: "plus")
                    .font(.headline)
                    .frame(maxWidth: 220)
                    .padding()
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(32)
    }

    // MARK: - Dashboard Content

    private var dashboardContent: some View {
        VStack(spacing: 24) {
            portfolioSummaryCard
            statRow
            if !topCards.isEmpty    { topCardsSection }
            if !recentCards.isEmpty { recentlyAddedSection }
            if realizedProfit != 0  { realizedSection }
            Spacer(minLength: 24)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    // MARK: - Portfolio Summary Card

    private var portfolioSummaryCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Portfolio Value")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.5)

            Text(totalValue.currencyString)
                .font(.system(size: 40, weight: .bold, design: .rounded))

            HStack(spacing: 6) {
                Image(systemName: unrealizedGL >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.subheadline)
                Text("\(unrealizedGL.currencyString)  (\(String(format: "%.1f", unrealizedROI))%)")
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text("unrealized")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .foregroundColor(unrealizedGL >= 0 ? .green : .red)

            Divider()

            HStack {
                summaryItem(label: "Cost Basis",   value: totalCost.currencyString)
                Spacer()
                summaryItem(label: "Cards Owned",  value: "\(ownedCards.count)")
                Spacer()
                summaryItem(label: "Raw",          value: "\(rawCount)")
                Spacer()
                summaryItem(label: "Graded",       value: "\(gradedCount)")
            }
        }
        .padding(20)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func summaryItem(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline)
                .fontWeight(.semibold)
        }
    }

    // MARK: - Stat Row (ROI %, Total Sold)

    private var statRow: some View {
        HStack(spacing: 12) {
            statTile(
                icon: "percent",
                label: "ROI",
                value: String(format: "%.1f%%", unrealizedROI),
                color: unrealizedROI >= 0 ? .green : .red
            )
            statTile(
                icon: "checkmark.seal.fill",
                label: "Cards Sold",
                value: "\(soldCards.count)",
                color: .blue
            )
            statTile(
                icon: "star.fill",
                label: "Top Value",
                value: topCards.first.map { $0.currentValue.currencyString } ?? "—",
                color: .yellow
            )
        }
    }

    private func statTile(icon: String, label: String, value: String, color: Color) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundColor(color)
            Text(value)
                .font(.headline)
                .fontWeight(.bold)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Top Cards

    private var topCardsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Top Cards by Value")
                .font(.headline)

            ForEach(topCards) { card in
                NavigationLink(value: card) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(card.displayTitle)
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .lineLimit(1)
                            Text(card.shortDescription)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(card.currentValue.currencyString)
                                .font(.subheadline)
                                .fontWeight(.semibold)
                            Text(card.gainLoss >= 0 ? "+\(card.gainLoss.currencyString)" : card.gainLoss.currencyString)
                                .font(.caption)
                                .foregroundColor(card.gainLoss >= 0 ? .green : .red)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)

                if card.id != topCards.last?.id { Divider() }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Recently Added

    private var recentlyAddedSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recently Added")
                .font(.headline)

            ForEach(recentCards) { card in
                NavigationLink(value: card) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(card.displayTitle)
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .lineLimit(1)
                            Text(card.isRaw ? "Raw" : "\(card.gradingCompany) \(card.grade)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(card.currentValue.currencyString)
                            .font(.subheadline)
                            .fontWeight(.semibold)
                    }
                    .contentShape(Rectangle())
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)

                if card.id != recentCards.last?.id { Divider() }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Realized Profit

    private var realizedSection: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Realized Profit")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(realizedProfit.currencyString)
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(realizedProfit >= 0 ? .green : .red)
            }
            Spacer()
            Text("from \(soldCards.count) sold card\(soldCards.count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Preview
#Preview {
    let config = ModelConfiguration(isStoredInMemoryOnly: true)
    let container = try! ModelContainer(for: CardItem.self, CardSaleRecord.self, configurations: config)
    let ctx = container.mainContext
    for card in PreviewSampleCards.makeSampleCards() {
        ctx.insert(card)
    }
    return CardDashboardView()
        .modelContainer(container)
}
