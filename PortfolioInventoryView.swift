import SwiftUI

// MARK: - Inventory Tab
struct PortfolioInventoryView: View {
    @ObservedObject var vm: PortfolioIQViewModel
    @State private var searchText = ""
    @State private var isGrid = false
    @State private var showSortMenu = false

    private var displayedHoldings: [PortfolioHolding] {
        let filtered = vm.filteredHoldings
        if searchText.isEmpty { return filtered }
        let q = searchText.lowercased()
        return filtered.filter {
            $0.playerName.lowercased().contains(q) ||
            $0.cardTitle.lowercased().contains(q) ||
            $0.brand.lowercased().contains(q) ||
            $0.product.lowercased().contains(q)
        }
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                inventoryHeader

                // Search + Controls
                searchBar

                // Filter Chips
                PortfolioFilterChips(selected: $vm.filter)
                    .padding(.horizontal)
                    .padding(.top, 4)

                // Content
                if vm.isLoading {
                    LoadingSkeletonPortfolioView()
                } else if vm.holdings.isEmpty {
                    EmptyPortfolioView(onAdd: { vm.showAddCard = true })
                } else if displayedHoldings.isEmpty {
                    noResultsView
                } else {
                    if isGrid {
                        gridView
                    } else {
                        listView
                    }
                }
            }

            // FAB Add button
            Button {
                vm.showAddCard = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 56, height: 56)
                    .background(Color.blue)
                    .clipShape(Circle())
                    .shadow(color: .blue.opacity(0.4), radius: 10, x: 0, y: 4)
            }
            .padding(.trailing, 20)
            .padding(.bottom, 20)
        }
        .sheet(isPresented: $showSortMenu) {
            PortfolioSortMenu(selected: $vm.sort, isPresented: $showSortMenu)
                .preferredColorScheme(.dark)
                .presentationDetents([.fraction(0.45)])
        }
    }

    // MARK: - Header
    private var inventoryHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text("Inventory")
                    .font(.title2.weight(.bold))
                    .foregroundColor(.white)
                Text("\(vm.holdings.count) card\(vm.holdings.count == 1 ? "" : "s") · $\(Int(vm.holdings.map { $0.currentValue }.reduce(0, +))) total")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Spacer()
            // Grid / List toggle
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isGrid.toggle() }
            } label: {
                Image(systemName: isGrid ? "list.bullet.rectangle" : "square.grid.2x2")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.blue)
                    .frame(width: 36, height: 36)
                    .background(Color.blue.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            // Sort
            Button {
                showSortMenu = true
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(.blue)
                    .frame(width: 36, height: 36)
                    .background(Color.blue.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.horizontal)
        .padding(.top, 14)
        .padding(.bottom, 6)
    }

    // MARK: - Search Bar
    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.gray)
                .font(.system(size: 15))
            TextField("Search player, card, brand…", text: $searchText)
                .foregroundColor(.white)
                .font(.system(size: 15))
                .autocorrectionDisabled()
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.gray)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal)
        .padding(.top, 4)
    }

    // MARK: - List View
    private var listView: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(spacing: 10) {
                ForEach(displayedHoldings) { holding in
                    HoldingRowCard(
                        holding: holding,
                        dailyIQTrendCount: vm.dailyIQRepeatCount(for: holding.playerName),
                        isDailyIQTrending: vm.isDailyIQTrending(holding),
                        onTap: { vm.showDetail = holding }
                    )
                }
                Spacer(minLength: 80)
            }
            .padding(.horizontal)
            .padding(.top, 8)
        }
        .refreshable { await vm.refreshAll() }
    }

    // MARK: - Grid View
    private var gridView: some View {
        ScrollView(showsIndicators: false) {
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                spacing: 10
            ) {
                ForEach(displayedHoldings) { holding in
                    HoldingGridCard(
                        holding: holding,
                        dailyIQTrendCount: vm.dailyIQRepeatCount(for: holding.playerName),
                        isDailyIQTrending: vm.isDailyIQTrending(holding),
                        onTap: { vm.showDetail = holding }
                    )
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)
            Spacer(minLength: 80)
        }
        .refreshable { await vm.refreshAll() }
    }

    // MARK: - No Results
    private var noResultsView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "magnifyingglass")
                .font(.system(size: 42))
                .foregroundColor(.gray)
            Text("No cards found")
                .font(.headline)
                .foregroundColor(.white)
            Text("Try a different search term or filter")
                .font(.subheadline)
                .foregroundColor(.gray)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

struct PortfolioInventoryView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioInventoryView(vm: PortfolioIQViewModel())
            .preferredColorScheme(.dark)
    }
}
