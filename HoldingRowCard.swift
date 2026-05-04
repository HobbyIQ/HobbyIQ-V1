import SwiftUI

struct HoldingRowCard: View {
    let holding: PortfolioHolding
    var onTap: (() -> Void)? = nil
    var body: some View {
        Button(action: { onTap?() }) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(holding.playerName)
                            .font(.headline)
                            .foregroundColor(.white)
                        Text(holding.cardTitle)
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("$\(holding.currentValue, specifier: "%.0f")")
                            .font(.headline)
                            .foregroundColor(.green)
                        Text("P/L: $\(holding.totalProfitLoss, specifier: "%.0f")")
                            .font(.caption)
                            .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
                    }
                }
                HStack(spacing: 10) {
                    StatusPill(text: holding.recommendation, color: .blue)
                    if let trend = trendIcon(for: holding.trend) {
                        Label(trend.label, systemImage: trend.icon)
                            .font(.caption2)
                            .foregroundColor(trend.color)
                    }
                    FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
                    Spacer()
                    if holding.quantity > 1 {
                        Text("x\(holding.quantity)")
                            .font(.caption2)
                            .foregroundColor(.gray)
                            .padding(.horizontal, 6)
                            .background(Color(.systemGray6).opacity(0.18))
                            .cornerRadius(8)
                    }
                }
            }
            .padding()
            .background(Color(.secondarySystemBackground).opacity(0.7))
            .cornerRadius(16)
            .shadow(color: .black.opacity(0.08), radius: 4, x: 0, y: 2)
        }
        .buttonStyle(PlainButtonStyle())
    }
    func trendIcon(for trend: PortfolioTrend) -> (icon: String, label: String, color: Color)? {
        switch trend {
        case .rising: return ("arrow.up.right", "Rising", .green)
        case .stable: return ("arrow.right", "Stable", .gray)
        case .falling: return ("arrow.down.right", "Falling", .red)
        }
    }
}

struct HoldingRowCard_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 16) {
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[0])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[1])
            HoldingRowCard(holding: PortfolioHolding.mockHoldings[2])
        }
        .preferredColorScheme(.dark)
        .padding()
        .background(Color.black)
    }
}
