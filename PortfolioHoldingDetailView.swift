import SwiftUI

struct PortfolioHoldingDetailView: View {
    @Binding var holding: PortfolioHolding
    var onEdit: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil
    @Environment(\.dismiss) var dismiss
    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HoldingDetailHeader(holding: holding, onEdit: onEdit, onRefresh: onRefresh)
                Divider().background(Color(.systemGray6))
                PositionSummarySection(holding: holding)
                ProfitViewSection(holding: holding)
                RecommendationSection(holding: holding)
                MarketActivitySection(holding: holding)
                ExitPlanSection(holding: holding)
                WhyThisMattersSection(holding: holding)
                if let notes = holding.notes, !notes.isEmpty {
                    SectionHeader(title: "Notes")
                    Text(notes)
                        .font(.subheadline)
                        .foregroundColor(.gray)
                        .padding(.horizontal)
                }
            }
            .padding()
        }
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(holding.playerName)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
    }
}

// MARK: - Detail Header
struct HoldingDetailHeader: View {
    let holding: PortfolioHolding
    var onEdit: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(holding.cardTitle)
                        .font(.title2)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                    Text("\(holding.cardYear) \(holding.brand)")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("$\(holding.currentValue, specifier: "%.0f")")
                        .font(.title2)
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
                Button(action: { onEdit?() }) {
                    Image(systemName: "pencil")
                        .foregroundColor(.blue)
                }
                Button(action: { onRefresh?() }) {
                    Image(systemName: "arrow.clockwise")
                        .foregroundColor(.blue)
                }
            }
        }
    }
    func trendIcon(for trend: PortfolioTrend) -> (icon: String, label: String, color: Color)? {
        switch trend {
        case .rising: return ("arrow.up.right", "Rising", .green)
        case .stable: return ("arrow.right", "Stable", .gray)
        case .falling: return ("arrow.down.right", "Falling", .red)
        }
    }
}

// MARK: - Section Headers
struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.headline)
            .foregroundColor(.white)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }
}

// MARK: - Position Summary
struct PositionSummarySection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Position Summary")
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Quantity")
                Spacer()
                Text("\(holding.quantity)")
            }
            HStack {
                Text("Avg Buy Price")
                Spacer()
                Text("$\(holding.purchasePrice, specifier: "%.2f")")
            }
            HStack {
                Text("Total Cost Basis")
                Spacer()
                Text("$\(holding.totalCostBasis, specifier: "%.0f")")
            }
            HStack {
                Text("Est. Current Value")
                Spacer()
                Text("$\(holding.currentValue, specifier: "%.0f")")
            }
            HStack {
                Text("Est. Net After Fees")
                Spacer()
                Text("$\(holding.netEstimatedValue ?? holding.currentValue, specifier: "%.0f")")
            }
        }
        .font(.subheadline)
        .foregroundColor(.gray)
        .padding(.horizontal)
    }
}

// MARK: - Profit View
struct ProfitViewSection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Profit View")
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Gross Gain/Loss")
                Spacer()
                Text("$\(holding.totalProfitLoss, specifier: "%.0f")")
                    .foregroundColor(holding.totalProfitLoss >= 0 ? .green : .red)
            }
            HStack {
                Text("Net Gain/Loss")
                Spacer()
                Text("$\(holding.netEstimatedValue ?? holding.totalProfitLoss, specifier: "%.0f")")
                    .foregroundColor((holding.netEstimatedValue ?? holding.totalProfitLoss) >= 0 ? .green : .red)
            }
            HStack {
                Text("ROI %")
                Spacer()
                Text("\(holding.totalProfitLossPct, specifier: "%.1f")%")
            }
        }
        .font(.subheadline)
        .foregroundColor(.gray)
        .padding(.horizontal)
    }
}

// MARK: - Recommendation
struct RecommendationSection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Recommendation")
        VStack(alignment: .leading, spacing: 6) {
            Text(holding.recommendation)
                .font(.headline)
                .foregroundColor(.blue)
            if !holding.verdict.isEmpty {
                Text(holding.verdict)
                    .font(.subheadline)
                    .foregroundColor(.gray)
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Market Activity
struct MarketActivitySection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Market Activity")
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Market Speed")
                Spacer()
                Text(holding.marketSpeed)
            }
            HStack {
                Text("Market Pressure")
                Spacer()
                Text(holding.marketPressure)
            }
            HStack {
                Text("Trend")
                Spacer()
                Text(holding.trend.rawValue.capitalized)
            }
            HStack {
                Text("Risk Level")
                Spacer()
                Text(holding.riskLevel.rawValue.capitalized)
            }
            if let days = holding.expectedDaysToSell {
                HStack {
                    Text("Expected Days to Sell")
                    Spacer()
                    Text("\(days)")
                }
            }
        }
        .font(.subheadline)
        .foregroundColor(.gray)
        .padding(.horizontal)
    }
}

// MARK: - Exit Plan
struct ExitPlanSection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Exit Plan")
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Best Way to Sell")
                Spacer()
                Text("Auction / BIN")
            }
            if let days = holding.expectedDaysToSell {
                HStack {
                    Text("Expected Days to Sell")
                    Spacer()
                    Text("\(days)")
                }
            }
            Text("Timing: \(holding.trend == .rising ? "Market is strong" : holding.trend == .falling ? "Consider selling soon" : "Stable")")
        }
        .font(.subheadline)
        .foregroundColor(.gray)
        .padding(.horizontal)
    }
}

// MARK: - Why This Matters
struct WhyThisMattersSection: View {
    let holding: PortfolioHolding
    var body: some View {
        SectionHeader(title: "Why This Matters")
        VStack(alignment: .leading, spacing: 4) {
            ForEach(holding.explanationBullets, id: \.self) { bullet in
                HStack(alignment: .top, spacing: 6) {
                    Text("•")
                        .font(.headline)
                        .foregroundColor(.blue)
                    Text(bullet)
                        .font(.subheadline)
                        .foregroundColor(.gray)
                }
            }
        }
        .padding(.horizontal)
    }
}

struct PortfolioHoldingDetailView_Previews: PreviewProvider {
    static var previews: some View {
        PortfolioHoldingDetailView(holding: .constant(PortfolioHolding.mockHoldings[0]))
            .preferredColorScheme(.dark)
    }
}
