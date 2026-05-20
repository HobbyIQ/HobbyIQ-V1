//
//  InventoryIQView.swift
//  HobbyIQ
//

import SwiftUI

struct InventoryIQView: View {
    @ObservedObject var vm: PortfolioIQViewModel

    @State private var inventoryQuery = ""
    @State private var inventoryFilter: PortfolioInventoryFilter = .all
    @State private var inventorySort: PortfolioInventorySort = .value
    @State private var inventoryMode: PortfolioInventoryMode = .rows
    @State private var isAddingCard = false
    @State private var selectedCard: InventoryCard?

    // Cached stats to avoid recomputing on every render
    @State private var cachedGainerCount = 0
    @State private var cachedLoserCount = 0
    @State private var cachedStaleCount = 0
    @State private var cachedAvgROI: Double = 0
    @State private var cachedGainValue: Double = 0
    @State private var cachedLossValue: Double = 0
    @State private var cachedFilteredCards: [InventoryCard] = []

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
                        VStack(spacing: 12) {
                            header

                            if let errorMessage = vm.errorMessage {
                                warningBanner(message: errorMessage)
                            }

                            inventorySnapshotPills
                            valueBreakdownBar

                            collectionSection
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
            .sheet(isPresented: $isAddingCard) {
                AddPortfolioCardView(viewModel: AddPortfolioCardViewModel()) {
                    Task { await vm.refresh() }
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
            .onAppear {
                if vm.summary == nil {
                    Task { await vm.load() }
                }
                recomputeFilteredCards()
                recomputeStats()
            }
            .onChange(of: vm.pendingInventoryFilter) { _, newFilter in
                if let newFilter {
                    inventoryFilter = newFilter
                    vm.pendingInventoryFilter = nil
                }
            }
            .onChange(of: vm.inventoryCards) { _, _ in recomputeStats(); recomputeFilteredCards() }
            .onChange(of: inventoryQuery) { _, _ in recomputeFilteredCards() }
            .onChange(of: inventoryFilter) { _, _ in recomputeFilteredCards() }
            .onChange(of: inventorySort) { _, _ in recomputeFilteredCards() }
        }
        .navigationViewStyle(.stack)
    }

    // MARK: - Background & States

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

    // MARK: - Header

    private var header: some View {
        let hero = vm.heroSummary

        return VStack(spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("InventoryIQ")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                    Text("Your card collection at a glance")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Spacer()

                Button {
                    isAddingCard = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 44, height: 44)
                        .background(HobbyIQTheme.Colors.electricBlue)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add Card")
            }

            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    Image(systemName: "archivebox.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("\(hero.totalCards) cards")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }

                Text("•")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                Text(hero.totalValue.portfolioCurrencyText)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            // Cost / P&L / ROI mini stats
            HStack(spacing: 0) {
                headerMiniStat(label: "Spent", value: portfolioCurrencyString(hero.costBasis), color: .white)
                Spacer()
                headerMiniStat(label: "Profit", value: (hero.unrealizedPnL >= 0 ? "+" : "") + portfolioCurrencyString(hero.unrealizedPnL), color: hero.unrealizedPnL >= 0 ? .green : .red)
                Spacer()
                headerMiniStat(label: "Return", value: String(format: "%@%.1f%%", hero.roi >= 0 ? "+" : "", hero.roi), color: hero.roi >= 0 ? .green : .red)
            }
            .padding(.top, 2)
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

    private func headerMiniStat(label: String, value: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .textCase(.uppercase)
        }
    }

    // MARK: - Inventory Snapshot Pills

    private var inventorySnapshotPills: some View {
        HStack(spacing: 8) {
            snapshotPill(value: "\(cachedGainerCount)", label: "Up", tint: .green, filter: .gainers)
            snapshotPill(value: "\(cachedLoserCount)", label: "Down", tint: .red, filter: .losers)
            snapshotPill(value: "\(cachedStaleCount)", label: "Outdated", tint: .orange, filter: .stale)
            snapshotPill(value: String(format: "%.1f%%", cachedAvgROI), label: "Return", tint: HobbyIQTheme.Colors.electricBlue, filter: nil)
        }
    }

    private func snapshotPill(value: String, label: String, tint: Color, filter: PortfolioInventoryFilter?) -> some View {
        let isActive = filter != nil && inventoryFilter == filter
        return Button {
            if let filter {
                inventoryFilter = inventoryFilter == filter ? .all : filter
            }
        } label: {
            VStack(spacing: 3) {
                Text(value)
                    .font(.system(size: 15, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(tint)
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(isActive ? tint.opacity(0.12) : HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                    .stroke(isActive ? tint.opacity(0.4) : Color.white.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Value Breakdown Bar

    private var valueBreakdownBar: some View {
        let total = cachedGainValue + cachedLossValue

        return VStack(spacing: 6) {
            GeometryReader { geo in
                let gainFraction = total > 0 ? cachedGainValue / total : 0.5
                HStack(spacing: 1) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.green)
                        .frame(width: geo.size.width * gainFraction)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.red)
                }
            }
            .frame(height: 6)

            HStack {
                HStack(spacing: 4) {
                    Circle().fill(.green).frame(width: 7, height: 7)
                    Text("\(portfolioCurrencyString(cachedGainValue)) going up")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer()
                HStack(spacing: 4) {
                    Text("\(portfolioCurrencyString(cachedLossValue)) going down")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Circle().fill(.red).frame(width: 7, height: 7)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    }

    // MARK: - Collection Section

    private var collectionSection: some View {
        let visibleCards = cachedFilteredCards

        return VStack(alignment: .leading, spacing: 12) {
            sectionHeader("MY COLLECTION")

            HStack {
                Text("\(visibleCards.count) cards")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)

                Spacer()

                Button {
                    isAddingCard = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Add Card")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(HobbyIQTheme.Colors.successGreen)
                    .clipShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
            }

            VStack(spacing: 8) {
                HobbyIQSearchField(text: $inventoryQuery, placeholder: "Search collection")

                HStack(spacing: 8) {
                    Menu {
                        ForEach(PortfolioInventoryFilter.allCases) { option in
                            Button(option.title) { inventoryFilter = option }
                        }
                    } label: {
                        inventoryChipLabel(title: inventoryFilter.title, systemName: "line.3.horizontal.decrease.circle")
                    }

                    Menu {
                        ForEach(PortfolioInventorySort.allCases) { option in
                            Button(option.title) { inventorySort = option }
                        }
                    } label: {
                        inventoryChipLabel(title: inventorySort.title, systemName: "arrow.up.arrow.down.circle")
                    }

                    Spacer()

                    // Mode toggle icons
                    HStack(spacing: 4) {
                        modeToggleButton(mode: .rows, icon: "list.bullet")
                        modeToggleButton(mode: .grid, icon: "square.grid.2x2")
                    }

                    // Reset icon
                    Button {
                        inventoryQuery = ""
                        inventoryFilter = .all
                        inventorySort = .value
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .frame(width: 36, height: 36)
                            .background(Color.white.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(Color.white.opacity(0.08), lineWidth: 1)
            )

            if visibleCards.isEmpty {
                inventoryEmptyState
            } else if inventoryMode == .rows {
                VStack(spacing: 0) {
                    ForEach(Array(visibleCards.enumerated()), id: \.element.id) { index, card in
                        Button {
                            selectedCard = card
                        } label: {
                            PortfolioCardRow(card: card)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if index < visibleCards.count - 1 {
                            Divider()
                                .overlay(Color.white.opacity(0.08))
                        }
                    }
                }
                .background(HobbyIQTheme.Colors.cardNavy)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
            } else {
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 12),
                    GridItem(.flexible(), spacing: 12)
                ], spacing: 12) {
                    ForEach(visibleCards) { card in
                        Button {
                            selectedCard = card
                        } label: {
                            PortfolioCardGridCard(card: card)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Helpers

    private func modeToggleButton(mode: PortfolioInventoryMode, icon: String) -> some View {
        let isActive = inventoryMode == mode
        return Button {
            inventoryMode = mode
        } label: {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isActive ? .white : HobbyIQTheme.Colors.mutedText)
                .frame(width: 36, height: 36)
                .background(isActive ? HobbyIQTheme.Colors.electricBlue.opacity(0.2) : Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(isActive ? HobbyIQTheme.Colors.electricBlue.opacity(0.4) : Color.clear, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var inventoryEmptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            Text("No cards yet.")
                .font(.headline.bold())
                .foregroundStyle(.white)

            Text("Add your first card using the + button.")
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

    private func inventoryChipLabel(title: String, systemName: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemName)
            Text(title)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color(hex: 0xE8EAF0))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(hex: 0x232937))
        .overlay(
            Capsule(style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1.4)
        )
        .clipShape(Capsule(style: .continuous))
    }

    private func recomputeStats() {
        let cards = vm.inventoryCards
        var gainers = 0, losers = 0, stale = 0
        var totalCost = 0.0, totalPL = 0.0
        var gainVal = 0.0, lossVal = 0.0

        for card in cards {
            if card.profitLoss >= 0 {
                gainers += 1
                gainVal += card.currentValue
            } else {
                losers += 1
                lossVal += card.currentValue
            }
            if card.freshnessChipText == "Stale" { stale += 1 }
            totalCost += card.cost
            totalPL += card.profitLoss
        }

        cachedGainerCount = gainers
        cachedLoserCount = losers
        cachedStaleCount = stale
        cachedAvgROI = totalCost > 0 ? (totalPL / totalCost) * 100 : 0
        cachedGainValue = gainVal
        cachedLossValue = lossVal
    }

    private func recomputeFilteredCards() {
        let query = inventoryQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var cards = vm.inventoryCards.filter { card in
            guard query.isEmpty == false else { return true }

            let haystack = [
                card.playerName,
                card.cardName,
                card.year,
                card.setName,
                card.parallel,
                card.grade,
                card.status,
                card.notes ?? "",
                card.summary ?? ""
            ]
            .joined(separator: " ")
            .lowercased()

            return haystack.contains(query)
        }

        cards = cards.filter { card in
            switch inventoryFilter {
            case .all:
                return true
            case .gainers:
                return card.profitLoss >= 0
            case .losers:
                return card.profitLoss < 0
            case .sellWatch:
                return card.profitLoss < 0 || card.status.lowercased().contains("sell")
            case .stale:
                return card.freshnessChipText == "Stale"
            }
        }

        switch inventorySort {
        case .value:
            cards.sort { $0.currentValue > $1.currentValue }
        case .profit:
            cards.sort { $0.profitLoss > $1.profitLoss }
        case .roi:
            cards.sort {
                let left = $0.cost > 0 ? ($0.profitLoss / $0.cost) * 100 : 0
                let right = $1.cost > 0 ? ($1.profitLoss / $1.cost) * 100 : 0
                return left > right
            }
        case .recent:
            cards.sort { $0.purchaseDate ?? "" > $1.purchaseDate ?? "" }
        case .name:
            cards.sort { $0.playerName.localizedCaseInsensitiveCompare($1.playerName) == .orderedAscending }
        }

        cachedFilteredCards = cards
    }
}

#Preview {
    InventoryIQView(vm: PortfolioIQViewModel())
        .environmentObject(AppState())
}
