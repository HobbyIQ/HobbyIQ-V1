
import SwiftUI

struct PortfolioIQView: View {
    @StateObject private var vm = PortfolioIQViewModel()
    @State private var showAccount = false
    var onAccount: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                VStack(spacing: 0) {
                    // Header
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("PortfolioIQ")
                                .font(.title2)
                                .fontWeight(.bold)
                                .foregroundColor(.blue)
                            Text("Know what your cards are worth and where your profit stands.")
                                .font(.caption)
                                .foregroundColor(.gray)
                        }
                        Spacer()
                        AccountButton {
                            if let onAccount {
                                onAccount()
                            } else {
                                showAccount = true
                            }
                        }
                    }
                    .padding([.horizontal, .top])

                    // Portfolio Summary
                    if !vm.isLoading && vm.error == nil && !vm.holdings.isEmpty {
                        PortfolioSummaryCard(
                            totalValue: vm.holdings.map { $0.currentValue }.reduce(0, +),
                            costBasis: vm.holdings.map { $0.totalCostBasis }.reduce(0, +),
                            profit: vm.holdings.map { $0.totalProfitLoss }.reduce(0, +),
                            profitPct: vm.holdings.isEmpty ? 0 : (vm.holdings.map { $0.totalProfitLoss }.reduce(0, +) / max(1, vm.holdings.map { $0.totalCostBasis }.reduce(0, +))) * 100,
                            cardCount: vm.holdings.count,
                            avgGainLoss: vm.holdings.isEmpty ? 0 : vm.holdings.map { $0.totalProfitLoss }.reduce(0, +) / Double(vm.holdings.count),
                            lastRefresh: vm.lastRefresh
                        )
                        .padding(.horizontal)
                        .padding(.top, 8)
                    }

                    // Quick Actions
                    if !vm.isLoading && vm.error == nil {
                        PortfolioQuickActionsRow(
                            onAdd: { vm.showAddCard = true },
                            onRefresh: { vm.refreshPortfolio() },
                            onSort: { vm.showSortMenu = true },
                            onFilter: {},
                            isRefreshing: vm.isRefreshing
                        )
                        .padding(.horizontal)
                        .padding(.top, 8)
                    }

                    // Filter Chips
                    if !vm.isLoading && vm.error == nil && !vm.holdings.isEmpty {
                        PortfolioFilterChips(selected: $vm.filter)
                            .padding(.horizontal)
                            .padding(.top, 2)
                    }

                    // Holdings List
                    if vm.isLoading {
                        LoadingSkeletonPortfolioView()
                    } else if let error = vm.error {
                        VStack(spacing: 16) {
                            Text(error)
                                .foregroundColor(.red)
                            Button("Retry") { vm.isLoading = false; vm.error = nil }
                                .foregroundColor(.blue)
                        }
                        .padding()
                    } else if vm.holdings.isEmpty {
                        EmptyPortfolioView(onAdd: { vm.showAddCard = true })
                    } else {
                        ScrollView {
                            VStack(spacing: 18) {
                                // Profit Highlights
                                if let winner = vm.holdings.max(by: { $0.totalProfitLoss < $1.totalProfitLoss }), winner.totalProfitLoss > 0 {
                                    PortfolioInsightCard(title: "\(winner.playerName) is up $\(Int(winner.totalProfitLoss))", subtitle: winner.verdict, color: .green)
                                }
                                // Sell Watch
                                if let sell = vm.holdings.first(where: { $0.statusCategory == .sellWatch }) {
                                    SellWatchCard(holding: sell)
                                }
                                // Risk / Needs Attention
                                if let risk = vm.holdings.first(where: { $0.riskLevel == .high }) {
                                    RiskAlertCard(holding: risk)
                                }
                                // Holdings
                                ForEach(vm.filteredHoldings) { holding in
                                    HoldingRowCard(holding: holding, onTap: {
                                        vm.showDetail = holding
                                    })
                                }
                                Spacer(minLength: 24)
                            }
                            .padding(.horizontal)
                            .padding(.top, 8)
                        }
                    }
                }
                // Sort Menu
                if vm.showSortMenu {
                    Color.black.opacity(0.4)
                        .ignoresSafeArea()
                        .onTapGesture { vm.showSortMenu = false }
                    PortfolioSortMenu(selected: $vm.sort, isPresented: $vm.showSortMenu)
                        .frame(maxWidth: 340)
                        .transition(.move(edge: .bottom))
                }
            }
            // Add Card Flow
            .sheet(isPresented: $vm.showAddCard) {
                AddCardFlow { holding in
                    vm.addHolding(holding)
                }
                .preferredColorScheme(.dark)
            }
            // Detail
            .sheet(item: $vm.showDetail) { holding in
                var binding = Binding(
                    get: { holding },
                    set: { updated in vm.updateHolding(updated) }
                )
                PortfolioHoldingDetailView(holding: binding)
                    .preferredColorScheme(.dark)
            }
            .sheet(isPresented: $showAccount) {
                AccountView()
                    .preferredColorScheme(.dark)
            }
        }
    }
}

struct PortfolioIQView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}
