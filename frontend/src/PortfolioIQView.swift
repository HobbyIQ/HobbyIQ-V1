import SwiftUI

struct PortfolioIQView: View {
    @EnvironmentObject var portfolio: PortfolioStore
    @State private var selectedHolding: PortfolioHolding? = nil
    @State private var showAccount = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Picker("Sort", selection: $portfolio.sort) {
                        ForEach(PortfolioStore.Sort.allCases) { s in
                            Text(s.rawValue).tag(s)
                        }
                    }
                    .pickerStyle(.segmented)
                    Picker("Filter", selection: $portfolio.filter) {
                        ForEach(PortfolioStore.Filter.allCases) { f in
                            Text(f.rawValue).tag(f)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                .padding(.horizontal)
                List {
                    ForEach(portfolio.filteredSortedHoldings) { holding in
                        Button {
                            selectedHolding = holding
                        } label: {
                            PortfolioHoldingRow(holding: holding)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("PortfolioIQ")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    AccountButton { showAccount = true }
                }
            }
            .sheet(item: $selectedHolding) { holding in
                HoldingDetailView(holding: holding)
            }
            .sheet(isPresented: $showAccount) {
                AccountView()
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct PortfolioHoldingRow: View {
    let holding: PortfolioHolding
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(holding.cardTitle).font(.headline).foregroundColor(.white)
                Text("Last updated: \(holding.lastUpdated, formatter: dateFmt)").font(.caption2).foregroundColor(.gray)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("$\(Int(holding.currentValue))").font(.headline).foregroundColor(.green)
                Text("P/L: $\(Int(holding.profitLoss))").font(.caption).foregroundColor(holding.profitLoss >= 0 ? .green : .red)
                Text(holding.status).font(.caption2).foregroundColor(.yellow)
            }
        }
        .padding(.vertical, 8)
    }
    var dateFmt: DateFormatter {
        let f = DateFormatter()
        f.dateStyle = .short
        return f
    }
}

#Preview {
    PortfolioIQView().environmentObject(PortfolioStore())
}
