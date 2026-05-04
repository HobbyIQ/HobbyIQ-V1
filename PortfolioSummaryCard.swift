import SwiftUI

struct PortfolioSummaryCard: View {
    let totalValue: Double
    let costBasis: Double
    let profit: Double
    let profitPct: Double
    let cardCount: Int
    let avgGainLoss: Double
    let lastRefresh: Date

    var profitColor: Color {
        profit >= 0 ? .green : .red
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("$\(totalValue, specifier: "%.0f")")
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .foregroundColor(.white)
                Spacer()
                ProfitBadge(amount: profit, percent: profitPct)
            }
            HStack(spacing: 16) {
                PortfolioMetricTile(label: "Cost Basis", value: costBasis, color: .gray)
                PortfolioMetricTile(label: "Cards", value: Double(cardCount), color: .blue)
                PortfolioMetricTile(label: "Avg Gain", value: avgGainLoss, color: profitColor)
            }
            HStack {
                FreshnessBadge(status: .live, lastUpdated: lastRefresh)
                Spacer()
                Text("Last updated \(lastRefresh, style: .relative) ago")
                    .font(.caption2)
                    .foregroundColor(.gray)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(18)
        .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
    }
}

struct PortfolioSummaryCard_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioSummaryCard(
            totalValue: 2450,
            costBasis: 1740,
            profit: 710,
            profitPct: 40.8,
            cardCount: 3,
            avgGainLoss: 236.7,
            lastRefresh: Date()
        )
        .preferredColorScheme(.dark)
        .padding()
        .background(Color.black)
    }
}
