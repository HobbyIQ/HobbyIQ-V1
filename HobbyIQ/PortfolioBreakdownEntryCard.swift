//
//  PortfolioBreakdownEntryCard.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). The way into Portfolio Breakdown
//  from the PortfolioIQ summary.
//
//  It shows the PortfolioIQ Score rather than a bare "Breakdown >" chevron,
//  because a number the owner has not seen before is what makes the tap worth
//  making. The score is computed from holdings already in memory — no network,
//  no loading state, nothing to wait for.
//

import SwiftUI

struct PortfolioBreakdownEntryCard: View {
    @ObservedObject var viewModel: PortfolioIQViewModel

    /// Computed rather than stored: the summary line must never disagree with
    /// the screen it opens, and recomputing from the same holdings is the only
    /// way to guarantee that.
    private var result: PortfolioAnalyticsResult {
        PortfolioAnalyticsService.shared.analyze(viewModel.inventoryCards)
    }

    var body: some View {
        NavigationLink {
            PortfolioBreakdownView(viewModel: viewModel)
        } label: {
            let r = result
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 4)
                    Circle()
                        .trim(from: 0, to: max(0.02, Double(r.score.value) / 100))
                        .stroke(tint(r), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text("\(r.score.value)")
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                .frame(width: 48, height: 48)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Portfolio Breakdown")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(subtitle(r))
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 4)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .padding(14)
            .hiqCard()
        }
        .buttonStyle(.plain)
    }

    /// Lead with whatever is most actionable: a concentration warning if there
    /// is one, otherwise the biggest allocation gap, otherwise the tier. The
    /// point is that the card says something different as the portfolio moves.
    private func subtitle(_ r: PortfolioAnalyticsResult) -> String {
        if let warning = r.concentrations.first(where: \.isWarning) {
            return "\(Int(warning.share * 100))% of value is tied to \(warning.label)"
        }
        let worst = r.allocations.max { abs($0.driftPoints) < abs($1.driftPoints) }
        if let worst, abs(worst.driftPoints) > 5 {
            let direction = worst.driftPoints < 0 ? "under" : "over"
            return "\(worst.category.displayName) is \(Int(abs(worst.driftPoints))) points \(direction) target"
        }
        return "\(r.score.tier.displayName) · allocation, risk and quality"
    }

    private func tint(_ r: PortfolioAnalyticsResult) -> Color {
        switch r.score.tier {
        case .elite, .strong: return HobbyIQTheme.Colors.successGreen
        case .good, .moderateRisk: return HobbyIQTheme.Colors.warning
        case .highRisk, .speculative: return HobbyIQTheme.Colors.danger
        }
    }
}
