
import SwiftUI
import UIKit

// MARK: - Tab Enum
enum PortfolioIQTab: String, CaseIterable {
    case home      = "Home"
    case inventory = "Inventory"
    case grading   = "Grading"
    case sales     = "Sales"
    case watchlist = "Watchlist"

    var icon: String {
        switch self {
        case .home:      return "square.grid.2x2.fill"
        case .inventory: return "list.bullet.rectangle.fill"
        case .grading:   return "seal.fill"
        case .sales:     return "chart.line.uptrend.xyaxis"
        case .watchlist: return "eye.fill"
        }
    }
}

// MARK: - Root View
struct PortfolioIQView: View {
    @StateObject private var vm = PortfolioIQViewModel()
    @StateObject private var auth = AuthManager.shared
    @StateObject private var portfolioService = PortfolioService.shared
    @State private var activeTab: PortfolioIQTab = .home
    @State private var showAccount = false
    @State private var showSettings = false
    @State private var sellHolding: PortfolioHolding? = nil
    var onAccount: (() -> Void)? = nil

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Color.black.ignoresSafeArea()

                // Tab content
                Group {
                    switch activeTab {
                    case .home:
                        PortfolioDashboardHome(vm: vm, onAccount: {
                            if let onAccount { onAccount() } else { showAccount = true }
                        })
                    case .inventory:
                        PortfolioInventoryView(vm: vm)
                    case .grading:
                        GradingPipelineView(vm: vm)
                    case .sales:
                        SalesTrackerView(vm: vm)
                    case .watchlist:
                        WatchlistView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.bottom, 60)

                // Custom bottom tab bar
                PortfolioTabBar(activeTab: $activeTab)
            }
            .ignoresSafeArea(.keyboard)
            // Add Card Sheet
            .sheet(isPresented: $vm.showAddCard) {
                AddCardFlow(onAdd: { holding in
                    vm.addHolding(holding)
                }, isAuthenticated: auth.isAuthenticated)
                .preferredColorScheme(.dark)
            }
            // Detail Sheet
            .sheet(item: $vm.showDetail) { holding in
                var binding = Binding(
                    get: { holding },
                    set: { updated in vm.updateHolding(updated) }
                )
                PortfolioHoldingDetailView(
                    holding: binding,
                    onEdit: { vm.showEditCard = holding },
                    onRefresh: { vm.repriceSingleHolding(id: holding.id) },
                    onSell: { sellHolding = holding; vm.showDetail = nil },
                    onDelete: { vm.deleteHolding(holding); vm.showDetail = nil }
                )
                .preferredColorScheme(.dark)
            }
            // Sell Sheet
            .sheet(item: $sellHolding) { holding in
                SellHoldingSheet(holding: holding) { qty, salePrice, fees, tax, shipping, notes in
                    vm.sellHolding(holding, quantity: qty, salePrice: salePrice,
                                   fees: fees, tax: tax, shipping: shipping, notes: notes)
                }
                .preferredColorScheme(.dark)
            }
            // Edit Cost Basis
            .sheet(item: $vm.showEditCard) { holding in
                EditCostBasisSheet(holding: holding) { newPrice, newQty, newNotes, newDate in
                    vm.updateCostBasis(id: holding.id, newPurchasePrice: newPrice, newQuantity: newQty,
                                       notes: newNotes, purchaseDate: newDate)
                }
                .preferredColorScheme(.dark)
            }
            // Account
            .sheet(isPresented: $showAccount) {
                AccountView().preferredColorScheme(.dark)
            }
            // Settings
            .sheet(isPresented: $showSettings) {
                PortfolioSettingsView(vm: vm)
                    .preferredColorScheme(.dark)
            }
            .onAppear {
                vm.loadPortfolio(sessionId: auth.activeSessionId)
                Task {
                    await portfolioService.fetchPortfolio()
                    await portfolioService.syncFromSwiftData(holdings: vm.holdings)
                }
            }
            .onChange(of: auth.currentUser?.userId) { _ in
                vm.loadPortfolio(sessionId: auth.activeSessionId)
                portfolioService.resetSyncFlag()
                Task {
                    await portfolioService.fetchPortfolio()
                    await portfolioService.syncFromSwiftData(holdings: vm.holdings)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                if Date().timeIntervalSince(vm.lastRefresh) > 4 * 3600 {
                    vm.refreshPortfolio()
                    Task { await portfolioService.fetchPortfolio() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(Color(.systemGray2))
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if !vm.holdings.isEmpty {
                        ShareLink(
                            item: portfolioCSV,
                            subject: Text("My PortfolioIQ"),
                            message: Text("Exported from HobbyIQ"),
                            preview: SharePreview("PortfolioIQ Export")
                        ) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 15, weight: .medium))
                        }
                    }
                }
            }
        }
    }

    // MARK: - CSV export helper
    var portfolioCSV: String {
        var lines = ["Player,Card,Year,Brand,Grade,Company,Qty,Cost,Value,P/L,ROI%,Status"]
        for h in vm.holdings {
            lines.append("\"\(h.playerName)\",\"\(h.cardTitle)\",\(h.cardYear),\"\(h.brand)\",\"\(h.grade)\",\"\(h.gradingCompany)\",\(h.quantity),\(h.purchasePrice),\(h.currentValue),\(h.totalProfitLoss),\(String(format: "%.1f", h.totalProfitLossPct)),\"\(h.cardStatus.rawValue)\"")
        }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Custom Tab Bar
struct PortfolioTabBar: View {
    @Binding var activeTab: PortfolioIQTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(PortfolioIQTab.allCases, id: \.self) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { activeTab = tab }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tab.icon)
                            .font(.system(size: 18, weight: activeTab == tab ? .bold : .regular))
                            .foregroundColor(activeTab == tab ? .blue : Color(.systemGray2))
                            .scaleEffect(activeTab == tab ? 1.1 : 1.0)
                        Text(tab.rawValue)
                            .font(.system(size: 10, weight: activeTab == tab ? .semibold : .regular))
                            .foregroundColor(activeTab == tab ? .blue : Color(.systemGray2))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(PlainButtonStyle())
            }
        }
        .padding(.horizontal, 8)
        .background(
            ZStack {
                Color(.systemGray6).opacity(0.92)
                Rectangle()
                    .fill(.ultraThinMaterial)
            }
            .cornerRadius(20, corners: [.topLeft, .topRight])
            .shadow(color: .black.opacity(0.25), radius: 12, x: 0, y: -4)
        )
        .frame(height: 60)
    }
}

// MARK: - Corner Radius Helper
extension View {
    func cornerRadius(_ radius: CGFloat, corners: UIRectCorner) -> some View {
        clipShape(RoundedCorner(radius: radius, corners: corners))
    }
}

struct RoundedCorner: Shape {
    var radius: CGFloat = .infinity
    var corners: UIRectCorner = .allCorners
    func path(in rect: CGRect) -> Path {
        let path = UIBezierPath(roundedRect: rect, byRoundingCorners: corners,
                                cornerRadii: CGSize(width: radius, height: radius))
        return Path(path.cgPath)
    }
}

struct PortfolioIQView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioIQView(onAccount: {})
            .preferredColorScheme(.dark)
    }
}
