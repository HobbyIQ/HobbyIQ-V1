import SwiftUI

struct SellWatchCard: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(holding.playerName)
                    .font(.headline)
                    .foregroundColor(.orange)
                Spacer()
                StatusPill(text: "Sell Watch", color: .orange)
            }
            Text(holding.cardTitle)
                .font(.subheadline)
                .foregroundColor(.gray)
            HStack {
                Text("Profit: $\(holding.totalProfitLoss, specifier: "%.0f")")
                    .font(.caption)
                    .foregroundColor(.green)
                Spacer()
                FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(14)
        .shadow(color: .orange.opacity(0.12), radius: 6, x: 0, y: 2)
    }
}

struct SellWatchCard_Previews: PreviewProvider {
    static var previews: some View {
        SellWatchCard(holding: PortfolioHolding.mockHoldings[1])
            .preferredColorScheme(.dark)
            .background(Color.black)
    }
}
