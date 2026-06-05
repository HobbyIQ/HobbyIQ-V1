//
//  InventoryIQView.swift
//  HobbyIQ
//

import SwiftUI

struct InventoryIQView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var showUpgradePaywall = false

    @State private var inventoryQuery = ""
    @State private var inventoryFilter: PortfolioInventoryFilter = .all
    @State private var inventorySort: PortfolioInventorySort = .value
    @State private var inventoryMode: PortfolioInventoryMode = .rows
    @State private var isAddingCard = false
    @State private var selectedCard: InventoryCard?

    // Cached filtered list to avoid recomputing on every render.
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

                            CapLimitBanner(
                                cap: .holdingsCap,
                                used: vm.inventoryCards.count,
                                subscriptionManager: sessionViewModel.subscriptionManager
                            ) {
                                showUpgradePaywall = true
                            }

                            if let errorMessage = vm.errorMessage {
                                warningBanner(message: errorMessage)
                            }

                            collectionSection
                        }
                        .padding(.horizontal, HobbyIQTheme.Spacing.screenPadding)
                        .padding(.top, 8)
                        .padding(.bottom, 24)
                    }
                    .refreshable {
                        await vm.refresh()
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
            .sheet(isPresented: $showUpgradePaywall) {
                PaywallView(
                    sessionViewModel: sessionViewModel,
                    suggestedTier: GatedCap.holdingsCap.upgradeTier(from: sessionViewModel.subscriptionManager.currentTier)
                )
            }
            .onAppear {
                if vm.summary == nil {
                    Task { await vm.load() }
                }
                recomputeFilteredCards()
            }
            .onChange(of: vm.pendingInventoryFilter) { _, newFilter in
                if let newFilter {
                    inventoryFilter = newFilter
                    vm.pendingInventoryFilter = nil
                }
            }
            .onChange(of: vm.inventoryCards) { _, _ in recomputeFilteredCards() }
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
                    if sessionViewModel.subscriptionManager.capAllows(.holdingsCap, used: vm.inventoryCards.count) {
                        isAddingCard = true
                    } else {
                        showUpgradePaywall = true
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .frame(width: 44, height: 44)
                        .background(sessionViewModel.subscriptionManager.capAllows(.holdingsCap, used: vm.inventoryCards.count) ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
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
                    if sessionViewModel.subscriptionManager.capAllows(.holdingsCap, used: vm.inventoryCards.count) {
                        isAddingCard = true
                    } else {
                        showUpgradePaywall = true
                    }
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
                    .background(sessionViewModel.subscriptionManager.capAllows(.holdingsCap, used: vm.inventoryCards.count) ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.mutedText)
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
        .environmentObject(AppSessionViewModel())
}
