// PortfolioRootView.swift
// PortfolioIQ — tab root wired to the SwiftData model container.
// Every tab gets live access to real user cards.

import SwiftUI
import SwiftData

struct PortfolioRootView: View {
    var body: some View {
        TabView {
            CardDashboardView()
                .tabItem { Label("Dashboard", systemImage: "chart.bar.fill") }

            CardInventoryView()
                .tabItem { Label("Inventory", systemImage: "rectangle.stack.fill") }

            SalesHistoryView()
                .tabItem { Label("Sales", systemImage: "checkmark.seal.fill") }

            GradingHelperView()
                .tabItem { Label("Grading", systemImage: "star.circle.fill") }

            DailyIQView()
                .tabItem { Label("DailyIQ", systemImage: "flame.fill") }
        }
    }
}

// MARK: - Sales History (sold cards)

/// Simple sold-cards list. Reuses @Query to show only sold cards and their sale records.
struct SalesHistoryView: View {
    @Query(
        filter: #Predicate<CardItem> { $0.status == "Sold" },
        sort: \CardItem.updatedAt,
        order: .reverse
    )
    private var soldCards: [CardItem]

    var totalProfit: Double {
        soldCards.compactMap { $0.saleRecord?.netProfit }.reduce(0, +)
    }

    var body: some View {
        NavigationStack {
            List {
                if !soldCards.isEmpty {
                    Section {
                        HStack {
                            Text("Total Realized Profit")
                                .fontWeight(.semibold)
                            Spacer()
                            Text(totalProfit.currencyString)
                                .fontWeight(.bold)
                                .foregroundColor(totalProfit >= 0 ? .green : .red)
                        }
                        Text("\(soldCards.count) card\(soldCards.count == 1 ? "" : "s") sold")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if soldCards.isEmpty {
                    ContentUnavailableView(
                        "No Sales Yet",
                        systemImage: "checkmark.seal",
                        description: Text("Cards you sell will appear here.")
                    )
                } else {
                    Section("Sold Cards") {
                        ForEach(soldCards) { card in
                            NavigationLink(value: card) {
                                SoldCardRow(card: card)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Sales")
            .navigationDestination(for: CardItem.self) { card in
                CardDetailView(card: card, onMarkSold: nil)
            }
        }
    }
}

// MARK: - Sold Card Row

struct SoldCardRow: View {
    let card: CardItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.displayTitle)
                        .font(.headline)
                        .lineLimit(1)
                    if !card.shortDescription.isEmpty {
                        Text(card.shortDescription)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if let sale = card.saleRecord {
                    Text(sale.saleDate.formatted(date: .abbreviated, time: .omitted))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let sale = card.saleRecord {
                HStack(spacing: 16) {
                    labeledValue("Sold For", value: sale.salePrice.currencyString)
                    labeledValue("Net Profit", value: sale.netProfit.currencyString,
                                 color: sale.netProfit >= 0 ? .green : .red)
                    labeledValue("ROI", value: String(format: "%.1f%%", sale.roi),
                                 color: sale.roi >= 0 ? .green : .red)
                    Spacer()
                    if !sale.sellingPlatform.isEmpty {
                        Text(sale.sellingPlatform)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color(.tertiarySystemBackground))
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func labeledValue(_ label: String, value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.subheadline).fontWeight(.medium).foregroundColor(color)
        }
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
    return PortfolioRootView()
        .modelContainer(container)
}
