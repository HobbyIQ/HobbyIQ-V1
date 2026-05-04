import SwiftUI

struct HoldingDetailView: View {
    @EnvironmentObject var portfolio: PortfolioStore
    @State var holding: PortfolioHolding
    @State private var isRefreshing = false
    @Environment(\.dismiss) var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(holding.cardTitle).font(.title2).bold().foregroundColor(.white)
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Current Value: $\(Int(holding.currentValue))").foregroundColor(.green)
                        Text("Cost Basis: $\(Int(holding.costBasis))").foregroundColor(.gray)
                        Text("Profit/Loss: $\(Int(holding.profitLoss))").foregroundColor(holding.profitLoss >= 0 ? .green : .red)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("Quick: $\(holding.quickSaleValue)")
                        Text("Fair: $\(holding.fairMarketValue)")
                        Text("Premium: $\(holding.premiumValue)")
                    }
                }
                Divider()
                Text("Verdict: \(holding.verdict)").foregroundColor(.yellow)
                Text("Freshness: \(holding.freshnessStatus)").foregroundColor(.gray)
                Text("Last Updated: \(holding.lastUpdated, formatter: dateFmt)").foregroundColor(.gray)
                Divider()
                Text("Market Activity").font(.headline).foregroundColor(.white)
                Text("\(holding.marketDNA.joined(separator: ", "))").foregroundColor(.blue)
                Divider()
                Text("Exit Plan").font(.headline).foregroundColor(.white)
                Text("\(holding.exitStrategy[\"plan\"] as? String ?? "-")").foregroundColor(.white)
                Divider()
                Text("Why this matters").font(.headline).foregroundColor(.white)
                ForEach(holding.explanation.prefix(3), id: \.self) { bullet in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "lightbulb.fill").foregroundColor(.yellow)
                        Text(bullet).foregroundColor(.white).font(.subheadline)
                    }
                }
                Button(action: refresh) {
                    if isRefreshing {
                        ProgressView()
                    } else {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
                .buttonStyle(.borderedProminent)
                .padding(.top, 16)
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }
    func refresh() {
        isRefreshing = true
        Task {
            if let updated = await CompIQAPI.estimate(for: holding.cardTitle) {
                await MainActor.run {
                    holding = holding.withUpdatedValues(from: updated)
                    isRefreshing = false
                }
                portfolio.update(holding)
            } else {
                isRefreshing = false
            }
        }
    }
    var dateFmt: DateFormatter {
        let f = DateFormatter()
        f.dateStyle = .short
        return f
    }
}

private extension PortfolioHolding {
    func withUpdatedValues(from result: CompIQResult) -> PortfolioHolding {
        PortfolioHolding(
            id: id,
            cardTitle: cardTitle,
            subject: subject,
            verdict: result.verdict,
            action: result.action,
            dealScore: result.dealScore,
            quickSaleValue: result.quickSaleValue,
            fairMarketValue: result.fairMarketValue,
            premiumValue: result.premiumValue,
            explanation: result.explanation,
            marketDNA: result.marketDNA,
            confidence: result.confidence,
            exitStrategy: result.exitStrategy,
            freshness: result.freshness,
            lastUpdated: Date(),
            quantity: quantity,
            purchasePrice: purchasePrice,
            purchaseDate: purchaseDate,
            fees: fees,
            tax: tax,
            shipping: shipping,
            notes: notes
        )
    }
}

#Preview {
    HoldingDetailView(holding: PortfolioHolding(
        id: UUID(),
        cardTitle: "Elly De La Cruz Chrome Auto",
        subject: [:],
        verdict: "Strong Buy",
        action: "Buy",
        dealScore: 95,
        quickSaleValue: 1200,
        fairMarketValue: 1450,
        premiumValue: 1700,
        explanation: ["Top prospect, high demand", "Recent sales above average", "Low supply, fast market"],
        marketDNA: ["High Demand", "Low Risk", "Up Trend"],
        confidence: [:],
        exitStrategy: ["plan": "Auction"],
        freshness: "Today",
        lastUpdated: Date(),
        quantity: 1,
        purchasePrice: 1000,
        purchaseDate: Date(),
        fees: 0,
        tax: 0,
        shipping: 0,
        notes: ""
    )).environmentObject(PortfolioStore())
}
