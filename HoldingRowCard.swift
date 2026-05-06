import SwiftUI

struct HoldingRowCard: View {
    let holding: PortfolioHolding
    var onTap: (() -> Void)? = nil

    var body: some View {
        Button(action: { onTap?() }) {
            HStack(spacing: 12) {
                // Left accent bar based on urgency
                RoundedRectangle(cornerRadius: 3)
                    .fill(holding.sellUrgencyColor)
                    .frame(width: 4)

                VStack(alignment: .leading, spacing: 5) {
                    // Row 1: Player + value
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(holding.playerName)
                                .font(.headline)
                                .foregroundColor(.white)
                            Text(holding.cardTitle)
                                .font(.caption)
                                .foregroundColor(Color(.systemGray2))
                                .lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("$\(holding.currentValue, specifier: "%.0f")")
                                .font(.headline)
                                .foregroundColor(.green)
                            Text("P/L \(holding.totalProfitLoss >= 0 ? "+" : "")$\(holding.totalProfitLoss, specifier: "%.0f")")
                                .font(.caption2)
                                .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
                        }
                    }

                    // Row 2: Recommendation + trend + urgency badge
                    HStack(spacing: 6) {
                        StatusPill(text: holding.recommendation, color: .blue)
                        if let trend = trendIcon(for: holding.trend) {
                            Label(trend.label, systemImage: trend.icon)
                                .font(.caption2)
                                .foregroundColor(trend.color)
                        }
                        Spacer()
                        // Urgency badge — compact on the right
                        VStack(spacing: 1) {
                            Text("\(holding.sellUrgency)")
                                .font(.system(size: 13, weight: .bold, design: .rounded))
                                .foregroundColor(holding.sellUrgencyColor)
                            Text(holding.sellUrgencyLabel)
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(holding.sellUrgencyColor.opacity(0.8))
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(holding.sellUrgencyColor.opacity(0.12))
                        .cornerRadius(8)
                    }

                    // Row 3: Metadata chips (only shown when there's data)
                    let hasChips = (holding.expectedDaysToSell != nil && holding.expectedDaysToSell! < 90) || holding.quantity > 1
                    if hasChips {
                        HStack(spacing: 6) {
                            if let days = holding.expectedDaysToSell, days < 90 {
                                Label("~\(days)d to sell", systemImage: "clock")
                                    .font(.caption2.weight(.medium))
                                    .foregroundColor(days <= 7 ? .red : days <= 21 ? .orange : .yellow)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background((days <= 7 ? Color.red : days <= 21 ? Color.orange : Color.yellow).opacity(0.12))
                                    .clipShape(Capsule())
                            }
                            if holding.quantity > 1 {
                                Text("×\(holding.quantity)")
                                    .font(.caption2.weight(.medium))
                                    .foregroundColor(.gray)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(.systemGray6).opacity(0.25))
                                    .clipShape(Capsule())
                            }
                            Spacer()
                            FreshnessBadge(status: holding.freshnessStatus, lastUpdated: holding.lastUpdated)
                        }
                    }
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(Color(.secondarySystemBackground).opacity(0.7))
            .cornerRadius(14)
            .shadow(color: .black.opacity(0.1), radius: 4, x: 0, y: 2)
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
