import SwiftUI

struct RiskAlertCard: View {
    let holding: PortfolioHolding
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(holding.playerName)
                    .font(.headline)
                    .foregroundColor(.red)
                Spacer()
                StatusPill(text: "Risk", color: .red)
            }
            Text(holding.cardTitle)
                .font(.subheadline)
                .foregroundColor(.gray)
            HStack {
                Text("Loss: $\(abs(holding.totalProfitLoss), specifier: "%.0f")")
                    .font(.caption)
                    .foregroundColor(.red)
                Spacer()
                FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground).opacity(0.7))
        .cornerRadius(14)
        .shadow(color: .red.opacity(0.12), radius: 6, x: 0, y: 2)
    }
}

struct RiskAlertCard_Previews: PreviewProvider {
    static var previews: some View {
        RiskAlertCard(holding: PortfolioHolding.mockHoldings[2])
            .preferredColorScheme(.dark)
            .background(Color.black)
    }
}
