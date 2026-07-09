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

    // CF-BACK-NAV-FIX (2026-07-06): filter/sort is derived inline from
    // `vm.inventoryCards` on each render. Previously the result was
    // cached in a separate `@State` and updated via `.onAppear` +
    // `.onChange` observers. The cache was fragile: if a background
    // refresh briefly cleared `vm.inventoryCards`, the cache emptied
    // and no `.onChange` fired to refill it on the way back — the
    // user landed on the tab root after a push/pop and saw only the
    // header + filters (no cards), which read as "wrong screen /
    // hero card". Deriving inline removes the whole failure mode
    // and cheaply re-filters on each body eval.

    var body: some View {
        // CF-TABBAR-PERSISTENT (2026-06-27): MainAppView already wraps
        // InventoryIQView in a NavigationStack — adding another here
        // double-nests stacks and breaks push navigation.
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
                }
            }
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 88)
            }
            .toolbar(.hidden, for: .navigationBar)
            // CF-BACK-NAV-FIX (2026-07-06): `.navigationDestination(item:)`
            // MUST be attached to a view that stays in the hierarchy for
            // the entire lifetime of the push. Previously it was inside
            // the `else` branch of the loading/error/content conditional —
            // if `vm.summary` momentarily flipped to nil during a
            // background refresh, the ScrollView unmounted, unregistering
            // the destination and evicting the pushed detail sheet. User
            // would land back at the tab root (perceived as "dashboard").
            // Attaching to the outer ZStack (which never unmounts) keeps
            // the destination registered regardless of vm state.
            .navigationDestination(item: $selectedCard) { card in
                PortfolioHoldingDetailSheet(
                    viewModel: vm,
                    card: card,
                    onUpdated: {
                        Task { await vm.refresh() }
                    },
                    onBack: { selectedCard = nil }
                )
                .environmentObject(sessionViewModel)
            }
            .navigationDestination(isPresented: $isAddingCard) {
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
            }
            .onChange(of: vm.pendingInventoryFilter) { _, newFilter in
                if let newFilter {
                    inventoryFilter = newFilter
                    vm.pendingInventoryFilter = nil
                }
            }
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
        // Reaggregate at render time on the priced subset so the subtitle's
        // dollar figure and card count reconcile honestly. Unpriced holdings
        // are surfaced as a separate count rather than silently contributing
        // 0 to a displayed total. Producer sums on `vm.heroSummary` are left
        // untouched for non-hero consumers (P/L derivations stay stable).
        let agg = InventoryDisplayAggregate(holdings: vm.inventoryCards)
        let canAdd = sessionViewModel.subscriptionManager.capAllows(.holdingsCap, used: vm.inventoryCards.count)
        let valueText = inventoryWholeDollarString(agg.displayValue)
        // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): subtitle splits unpriced
        // into "N estimated · M pending" via the aggregate helper so the
        // hero's exclusion is transparent. Story B invariant unchanged —
        // displayValue is still observed-only.
        let subtitleText = "\(agg.totalCards) cards · \(valueText)\(agg.unpricedSubtitleSuffix)"

        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("InventoryIQ")
                    .font(HobbyIQTheme.Typography.title)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                Text(subtitleText)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            Spacer(minLength: 8)

            // CF-INVENTORY-HEADER-REFRESH (2026-07-04): explicit refresh
            // affordance next to Add so users can pull fresh
            // valuation/count data without pull-to-refresh.
            Button {
                Task { await vm.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .frame(width: 40, height: 40)
                    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh inventory")

            Button {
                if canAdd {
                    isAddingCard = true
                } else {
                    showUpgradePaywall = true
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.caption.weight(.semibold))
                    Text("Add")
                        .font(.subheadline.weight(.medium))
                }
                .foregroundStyle(canAdd ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background((canAdd ? HobbyIQTheme.Colors.electricBlue : HobbyIQTheme.Colors.mutedText).opacity(0.12))
                .clipShape(Capsule(style: .continuous))
                .contentShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add a card to your inventory")
        }
        .padding(.horizontal, HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Collection Section

    private var collectionSection: some View {
        let visibleCards = filteredAndSortedCards

        return VStack(alignment: .leading, spacing: 12) {
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
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
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
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
                )
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
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
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

    private var filteredAndSortedCards: [InventoryCard] {
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

        return cards
    }
}

#Preview {
    InventoryIQView(vm: PortfolioIQViewModel())
        .environmentObject(AppState())
        .environmentObject(AppSessionViewModel())
}
