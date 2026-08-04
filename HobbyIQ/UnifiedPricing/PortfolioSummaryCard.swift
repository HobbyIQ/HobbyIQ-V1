//
//  PortfolioSummaryCard.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 3 (Drew, 2026-08-04).
//
//  Portfolio total + observed/estimated split + gain-loss + return.
//  Cross-platform reference: apps/web/src/app/app/portfolio/page.tsx
//  header. Both platforms render the same three stat tiles atop the
//  portfolio grid.
//
//  Reads the backend PortfolioSummary shape — see backend/src/services/
//  portfolioiq/portfolioStore.service.ts (summarizeHoldings).
//
//  Blueprint: backend/docs/ios-unified-rebuild-blueprint.md
//

import SwiftUI

/// Minimal projection of the backend PortfolioSummary — every field the
/// summary tiles need, nothing else. Consumers pass whichever fields
/// they have; missing fields render as "—" so partial-state summaries
/// (loading, error, empty) don't render zero-dollar surprises.
struct UnifiedPortfolioSummary: Equatable {
    /// Total value including estimated dollars. Backend rolls in
    /// estimatedValue as a fallback so unpriced holdings show cost.
    /// See computeDisplayValue in portfolioStore.service.ts.
    let totalValue: Double?
    /// Sum of all cost bases across active positions.
    let totalCost: Double?
    /// Total P/L in dollars. Negative renders red, positive green.
    let totalGainLoss: Double?
    /// Total return % (P/L divided by totalCost).
    let totalGainLossPct: Double?
    /// Portion of totalValue backed by comp-anchored FMV.
    let observedValue: Double?
    /// Portion backed by ladder/sibling/reference-price estimates.
    let estimatedValue: Double?
    /// Card count (physical: sums quantity across holdings).
    let cardCount: Int?
    /// Count of holdings marked "estimated" (subset of positions).
    let estimatedCount: Int?
    /// Count of holdings marked "pending" (identity unresolved).
    let pendingCount: Int?
}

/// The 3-tile stat header rendered above the portfolio grid.
/// Matches web layout: [Total value] [Gain/loss] [Return] with a
/// smaller observed/estimated split underneath.
struct PortfolioSummaryCard: View {
    let summary: UnifiedPortfolioSummary

    var body: some View {
        VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.medium) {
            HStack(alignment: .top, spacing: HobbyIQTheme.Spacing.medium) {
                totalValueTile
                gainLossTile
                returnTile
            }
            observedEstimatedSplit
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .shadow(color: HobbyIQTheme.Colors.shadow, radius: 8, x: 0, y: 4)
    }

    // MARK: Tiles

    private var totalValueTile: some View {
        statTile(
            label: "Total value",
            value: summary.totalValue.map { wholeUSDString($0) } ?? "—",
            valueColor: HobbyIQTheme.Colors.pureWhite
        )
    }

    private var gainLossTile: some View {
        let gl = summary.totalGainLoss
        let color: Color = {
            if let g = gl {
                if g > 0 { return HobbyIQTheme.Colors.hobbyGreen }
                if g < 0 { return HobbyIQTheme.Colors.danger }
            }
            return HobbyIQTheme.Colors.pureWhite
        }()
        let text: String = {
            guard let g = gl else { return "—" }
            let sign = g > 0 ? "+" : (g < 0 ? "-" : "")
            return sign + wholeUSDString(abs(g))
        }()
        return statTile(label: "Gain/loss", value: text, valueColor: color)
    }

    private var returnTile: some View {
        let pct = summary.totalGainLossPct
        let color: Color = {
            if let p = pct {
                if p > 0 { return HobbyIQTheme.Colors.hobbyGreen }
                if p < 0 { return HobbyIQTheme.Colors.danger }
            }
            return HobbyIQTheme.Colors.pureWhite
        }()
        let text: String = {
            guard let p = pct else { return "—" }
            let sign = p > 0 ? "+" : (p < 0 ? "-" : "")
            return "\(sign)\(String(format: "%.1f", abs(p)))%"
        }()
        return statTile(label: "Return", value: text, valueColor: color)
    }

    private func statTile(label: String, value: String, valueColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(HobbyIQTheme.Typography.statNumber)
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Observed / estimated split

    @ViewBuilder
    private var observedEstimatedSplit: some View {
        if let observed = summary.observedValue, let estimated = summary.estimatedValue,
           observed > 0 || estimated > 0 {
            let total = max(observed + estimated, 1)
            let observedPct = observed / total
            HStack(spacing: HobbyIQTheme.Spacing.small) {
                Text("Value backing")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(width: 92, alignment: .leading)

                GeometryReader { geo in
                    HStack(spacing: 2) {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(HobbyIQTheme.Colors.hobbyGreen)
                            .frame(width: geo.size.width * CGFloat(observedPct))
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(HobbyIQTheme.Colors.electricBlue)
                            .frame(width: geo.size.width * CGFloat(1 - observedPct))
                    }
                }
                .frame(height: 6)

                Text("\(Int((observedPct * 100).rounded()))% observed")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        } else if let card = summary.cardCount, card > 0 {
            Text("\(card) card\(card == 1 ? "" : "s")")
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }
}

// MARK: - Preview

#Preview("Healthy split") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        PortfolioSummaryCard(summary: UnifiedPortfolioSummary(
            totalValue: 5014,
            totalCost: 4818,
            totalGainLoss: 196,
            totalGainLossPct: 4.07,
            observedValue: 3124,
            estimatedValue: 1890,
            cardCount: 14,
            estimatedCount: 10,
            pendingCount: 0
        ))
        .padding()
    }
}

#Preview("Underwater") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        PortfolioSummaryCard(summary: UnifiedPortfolioSummary(
            totalValue: 3800,
            totalCost: 4800,
            totalGainLoss: -1000,
            totalGainLossPct: -20.8,
            observedValue: 2500,
            estimatedValue: 1300,
            cardCount: 12,
            estimatedCount: 8,
            pendingCount: 1
        ))
        .padding()
    }
}

#Preview("Empty state") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        PortfolioSummaryCard(summary: UnifiedPortfolioSummary(
            totalValue: nil,
            totalCost: nil,
            totalGainLoss: nil,
            totalGainLossPct: nil,
            observedValue: nil,
            estimatedValue: nil,
            cardCount: 0,
            estimatedCount: 0,
            pendingCount: 0
        ))
        .padding()
    }
}
