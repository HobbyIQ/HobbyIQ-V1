
import SwiftUI
import UIKit

struct PortfolioIQView: View {
    @StateObject private var vm = PortfolioIQViewModel()
    @StateObject private var auth = AuthManager.shared
    @State private var showAccount = false
    @State private var showDiversity = false
    @State private var showLedger = false
    @State private var sellHolding: PortfolioHolding? = nil
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
                            lastRefresh: vm.lastRefresh,
                            valueHistory: vm.valueHistory
                        )
                        .padding(.horizontal)
                        .padding(.top, 8)

                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Realized P/L Ledger")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                Spacer()
                                Button("View All") {
                                    showLedger = true
                                }
                                .font(.caption)
                                .foregroundColor(.blue)
                            }
                            HStack {
                                Text("Total Realized")
                                    .font(.subheadline)
                                    .foregroundColor(.white)
                                Spacer()
                                Text("\(vm.realizedProfitLoss >= 0 ? "+" : "")$\(vm.realizedProfitLoss, specifier: "%.2f")")
                                    .font(.headline)
                                    .foregroundColor(vm.realizedProfitLoss >= 0 ? .green : .red)
                            }
                            if let latest = vm.ledgerEntries.first {
                                Text("Latest: \(latest.playerName) x\(latest.quantitySold)  •  \(latest.realizedProfitLoss >= 0 ? "+" : "")$\(latest.realizedProfitLoss, specifier: "%.2f")")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground).opacity(0.65))
                        .cornerRadius(14)
                        .padding(.horizontal)
                    }

                    // Quick Actions
                    if !vm.isLoading && vm.error == nil {
                        PortfolioQuickActionsRow(
                            onAdd: { vm.showAddCard = true },
                            onRefresh: { vm.refreshPortfolio() },
                            onSort: { vm.showSortMenu = true },
                            onFilter: {},
                            onDiversity: { showDiversity = true },
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
                        .refreshable {
                            await vm.refreshAll()
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
                AddCardFlow(onAdd: { holding in
                    vm.addHolding(holding)
                }, isAuthenticated: auth.isAuthenticated)
                .preferredColorScheme(.dark)
            }
            // Detail
            .sheet(item: $vm.showDetail) { holding in
                var binding = Binding(
                    get: { holding },
                    set: { updated in vm.updateHolding(updated) }
                )
                PortfolioHoldingDetailView(
                    holding: binding,
                    onEdit: { vm.showEditCard = holding },
                    onRefresh: { vm.repriceSingleHolding(id: holding.id) },
                    onSell: {
                        sellHolding = holding
                        vm.showDetail = nil
                    },
                    onDelete: {
                        vm.deleteHolding(holding)
                        vm.showDetail = nil
                    }
                )
                    .preferredColorScheme(.dark)
            }
            .sheet(isPresented: $showAccount) {
                AccountView()
                    .preferredColorScheme(.dark)
            }
            .sheet(item: $sellHolding) { holding in
                SellHoldingSheet(holding: holding) { quantity, salePrice, fees, tax, shipping, notes in
                    vm.sellHolding(
                        holding,
                        quantity: quantity,
                        salePrice: salePrice,
                        fees: fees,
                        tax: tax,
                        shipping: shipping,
                        notes: notes
                    )
                }
                .preferredColorScheme(.dark)
            }
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
            // Diversity sheet
            .sheet(isPresented: $showDiversity) {
                PortfolioDiversityView(holdings: vm.holdings)
                    .preferredColorScheme(.dark)
            }
            // Edit cost basis
            .sheet(item: $vm.showEditCard) { holding in
                EditCostBasisSheet(holding: holding) { newPrice, newQty, newNotes, newDate in
                    vm.updateCostBasis(id: holding.id, newPurchasePrice: newPrice, newQuantity: newQty,
                                       notes: newNotes, purchaseDate: newDate)
                }
                .preferredColorScheme(.dark)
            }
            .onAppear {
                vm.loadPortfolio(sessionId: auth.activeSessionId)
            }
            .onChange(of: auth.currentUser?.userId) { _ in
                vm.loadPortfolio(sessionId: auth.activeSessionId)
            }
            // Auto-reprice when app returns to foreground (if data is >4h stale)
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                if Date().timeIntervalSince(vm.lastRefresh) > 4 * 3600 {
                    vm.refreshPortfolio()
                }
            }
            // CSV Export toolbar button
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    if !vm.holdings.isEmpty {
                        ShareLink(
                            item: portfolioCSV,
                            preview: SharePreview("HobbyIQ Portfolio.csv", image: Image(systemName: "tablecells"))
                        ) {
                            Image(systemName: "square.and.arrow.up")
                                .foregroundColor(.blue)
                        }
                    }
                }
            }
        }
    }

    private var portfolioCSV: String {
        var rows = ["Player,Card Title,Year,Product,Parallel,Grade,Qty,Buy Price,Cost Basis,FMV,P&L,P&L %,Recommendation"]
        for h in vm.holdings {
            let parallel = h.parallel ?? "Base"
            let grade = h.gradingCompany.isEmpty ? "Raw" : "\(h.gradingCompany) \(h.grade)"
            let row = [
                h.playerName, h.cardTitle, "\(h.cardYear)", h.product,
                parallel, grade, "\(h.quantity)",
                String(format: "%.2f", h.purchasePrice),
                String(format: "%.2f", h.totalCostBasis),
                String(format: "%.2f", h.currentValue),
                String(format: "%.2f", h.totalProfitLoss),
                String(format: "%.1f%%", h.totalProfitLossPct),
                h.recommendation
            ].map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }
            rows.append(row.joined(separator: ","))
        }
        return rows.joined(separator: "\n")
    }
}

struct PortfolioIQView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}
