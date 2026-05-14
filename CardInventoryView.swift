// CardInventoryView.swift
// PortfolioIQ — real inventory powered by SwiftData @Query.
// Empty state shown when no cards exist. No fake data injected.

import SwiftUI
import SwiftData

struct CardInventoryView: View {
    @Environment(\.modelContext) private var context
    @ObservedObject private var refresher = InventoryRefreshService.shared

    // Live query — newest cards first, owned/active only
    @Query(
        filter: #Predicate<CardItem> { $0.status != "Sold" && $0.status != "Archived" },
        sort: \CardItem.createdAt,
        order: .reverse
    )
    private var cards: [CardItem]

    @State private var searchText: String = ""
    @State private var showAddCard: Bool = false
    @State private var selectedStatus: CardStatus? = nil   // nil = all
    @State private var showSellSheet: CardItem? = nil
    @State private var showHeatMap: Bool = false

    private var displayedCards: [CardItem] {
        var result = cards
        if let filter = selectedStatus {
            result = result.filter { $0.cardStatus == filter }
        }
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            result = result.filter {
                $0.displayTitle.lowercased().contains(q) ||
                $0.playerName.lowercased().contains(q) ||
                $0.setName.lowercased().contains(q)
            }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if cards.isEmpty {
                    emptyState
                } else if showHeatMap {
                    PortfolioHeatMapView(cards: displayedCards)
                } else {
                    cardList
                }
            }
            .navigationTitle("Inventory")
            .searchable(text: $searchText, prompt: "Search player, set…")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showAddCard = true
                    } label: {
                        Image(systemName: "plus")
                            .fontWeight(.semibold)
                    }
                }
                if !cards.isEmpty {
                    ToolbarItem(placement: .principal) {
                        Picker("View", selection: $showHeatMap) {
                            Image(systemName: "list.bullet").tag(false)
                            Image(systemName: "square.grid.3x3.fill").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 120)
                    }
                }
            }
            .sheet(isPresented: $showAddCard) {
                AddCardView()
            }
            .sheet(item: $showSellSheet) { card in
                SellCardSheet(card: card)
            }
            .navigationDestination(for: CardItem.self) { card in
                CardDetailView(card: card, onMarkSold: { showSellSheet = card })
            }
            // Refresh every owned card's predicted market value while the
            // inventory is on screen so profit/loss stays current.
            // - Initial pass on appear
            // - Re-check every 30 min (each card still gated by 6h cooldown)
            // - SwiftUI cancels this Task automatically when the view dies
            .task {
                await InventoryRefreshService.runPeriodic(
                    cardsProvider: { cards.filter { !$0.isSold } },
                    context: context
                )
            }
            // Pull-to-refresh forces a full pass (still respects 6h cooldown).
            .refreshable {
                await InventoryRefreshService.refreshStaleCards(
                    cards.filter { !$0.isSold },
                    context: context
                )
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "rectangle.stack.badge.plus")
                .font(.system(size: 56))
                .foregroundStyle(.blue.opacity(0.7))

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

    // MARK: - Card List

    private var cardList: some View {
        List {
            // Refresh status row — shows when prices were last refreshed
            // and a live spinner while a pass is in flight.
            refreshStatusRow
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 0, trailing: 12))
                .listRowSeparator(.hidden)

            // Status filter row
            if !cards.isEmpty {
                statusFilterRow
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
            }

            if displayedCards.isEmpty {
                Text("No cards match your filter.")
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(displayedCards) { card in
                    NavigationLink(value: card) {
                        CardInventoryRow(card: card)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            context.delete(card)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }

                        Button {
                            showSellSheet = card
                        } label: {
                            Label("Sell", systemImage: "dollarsign.circle")
                        }
                        .tint(.green)
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    // MARK: - Refresh Status Row

    private var refreshStatusRow: some View {
        HStack(spacing: 8) {
            if refresher.isRefreshing {
                ProgressView()
                    .scaleEffect(0.75)
                Text("Refreshing prices…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(lastRefreshedText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }

    private var lastRefreshedText: String {
        guard let last = refresher.lastRunAt else {
            return "Prices refresh automatically"
        }
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .short
        return "Prices refreshed \(fmt.localizedString(for: last, relativeTo: Date()))"
    }

    // MARK: - Status Filter Chips

    private var statusFilterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterChip(label: "All", value: nil)
                filterChip(label: "Owned",    value: .owned)
                filterChip(label: "Listed",   value: .listed)
                filterChip(label: "Grading",  value: .grading)
            }
            .padding(.vertical, 8)
        }
    }

    private func filterChip(label: String, value: CardStatus?) -> some View {
        let active = selectedStatus == value
        return Button {
            withAnimation(.easeInOut(duration: 0.15)) { selectedStatus = value }
        } label: {
            Text(label)
                .font(.subheadline)
                .fontWeight(active ? .semibold : .regular)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(active ? Color.blue : Color(.secondarySystemBackground))
                .foregroundColor(active ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Inventory Row

struct CardInventoryRow: View {
    let card: CardItem

    private var gainColor: Color {
        card.gainLoss > 0 ? .green : card.gainLoss < 0 ? .red : .secondary
    }

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

                // Raw / Graded badge + Auto badge
                HStack(spacing: 6) {
                    if card.isAuto {
                        Text("Auto")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.blue.opacity(0.15))
                            .foregroundColor(.blue)
                            .clipShape(Capsule())
                    }
                    Text(card.isRaw ? "Raw" : "\(card.gradingCompany) \(card.grade)")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(card.isRaw ? Color.orange.opacity(0.15) : Color.blue.opacity(0.15))
                        .foregroundColor(card.isRaw ? .orange : .blue)
                        .clipShape(Capsule())
                }
            }

            HStack(spacing: 16) {
                labeledValue(label: "Cost",    value: card.purchasePrice.currencyString)
                labeledValue(label: "Value",   value: card.currentValue.currencyString)
                HStack(spacing: 4) {
                    Image(systemName: card.gainLoss >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .font(.caption2)
                        .foregroundColor(gainColor)
                    Text(card.gainLoss.currencyString)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(gainColor)
                    Text(String(format: "(%.1f%%)", card.gainLossPct))
                        .font(.caption)
                        .foregroundColor(gainColor)
                }

                Spacer()

                // Status pill
                Text(card.cardStatus.rawValue)
                    .font(.caption2)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(card.cardStatus.color.opacity(0.15))
                    .foregroundColor(card.cardStatus.color)
                    .clipShape(Capsule())
            }
        }
        .padding(.vertical, 6)
    }

    private func labeledValue(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline)
                .fontWeight(.medium)
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
    return CardInventoryView()
        .modelContainer(container)
}
