import SwiftUI
import Charts

struct PortfolioSummaryCard: View {
    let totalValue: Double
    let costBasis: Double
    let profit: Double
    let profitPct: Double
    let cardCount: Int
    let avgGainLoss: Double
    let lastRefresh: Date
    var valueHistory: [PortfolioSnapshot] = []

    private var profitColor: Color { profit >= 0 ? .green : .red }
    private var profitSign: String { profit >= 0 ? "+" : "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Total value + P&L badge
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Total Value")
                        .font(.caption)
                        .foregroundColor(Color(.systemGray2))
                    Text("$\(totalValue, specifier: "%.0f")")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    ProfitBadge(amount: profit, percent: profitPct)
                    Text("\(profitSign)$\(profit, specifier: "%.0f") all-time")
                        .font(.caption2)
                        .foregroundColor(profitColor.opacity(0.8))
                }
            }

            // Sparkline
            if valueHistory.count >= 2 {
                PortfolioSparklineChart(history: valueHistory)
                    .frame(height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            // Metrics row
            HStack(spacing: 0) {
                SummaryMetric(label: "Cost Basis", value: "$\(Int(costBasis))", color: .gray)
                Divider().frame(height: 32).background(Color(.systemGray5))
                SummaryMetric(label: "Cards", value: "\(cardCount)", color: .blue)
                Divider().frame(height: 32).background(Color(.systemGray5))
                SummaryMetric(label: "Avg Gain", value: "\(avgGainLoss >= 0 ? "+" : "")$\(Int(avgGainLoss))", color: profitColor)
            }
            .padding(.horizontal, 4)

            // Freshness footer
            HStack(spacing: 6) {
                FreshnessBadge(status: .live, lastUpdated: lastRefresh)
                Text("·")
                    .foregroundColor(.gray)
                Text("Updated \(lastRefresh, style: .relative) ago")
                    .font(.caption2)
                    .foregroundColor(Color(.systemGray3))
                Spacer()
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(Color(.secondarySystemBackground).opacity(0.75))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(profitColor.opacity(0.18), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.16), radius: 10, x: 0, y: 4)
    }
}

// MARK: - Summary Metric Tile
private struct SummaryMetric: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(color)
            Text(label)
                .font(.caption2)
                .foregroundColor(Color(.systemGray2))
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Sparkline
struct PortfolioSparklineChart: View {
    let history: [PortfolioSnapshot]

    private var trendColor: Color {
        guard let first = history.first, let last = history.last else { return .blue }
        return last.totalValue >= first.totalValue ? .green : .red
    }

    var body: some View {
        Chart(history) { snapshot in
            LineMark(
                x: .value("Date", snapshot.date),
                y: .value("Value", snapshot.totalValue)
            )
            .foregroundStyle(trendColor)
            .interpolationMethod(.catmullRom)
            AreaMark(
                x: .value("Date", snapshot.date),
                y: .value("Value", snapshot.totalValue)
            )
            .foregroundStyle(
                LinearGradient(
                    colors: [trendColor.opacity(0.3), .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .interpolationMethod(.catmullRom)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: .automatic(includesZero: false))
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
