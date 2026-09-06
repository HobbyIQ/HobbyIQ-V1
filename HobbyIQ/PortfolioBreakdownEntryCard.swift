//
//  PortfolioBreakdownEntryCard.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). The way into Portfolio Breakdown
//  from the PortfolioIQ summary.
//
//  Shows the PortfolioIQ Score rather than a bare chevron, because a number the
//  owner has not seen before is what makes the tap worth making. The subtitle
//  leads with whatever is most actionable, so the card says something different
//  as the portfolio moves instead of being wallpaper.
//
//  Reads the SAME endpoint the destination screen reads, so the card can never
//  disagree with what it opens. It does not compute anything itself — an
//  earlier cut recomputed the score locally in Swift, which was a second
//  implementation of the server's rule and would have drifted.
//
//  Self-suppressing: renders nothing until the fetch lands, and nothing at all
//  on error or an empty portfolio. A card reading "0 / 100" to someone with no
//  holdings teaches nothing and looks broken.
//

import SwiftUI

struct PortfolioBreakdownEntryCard: View {
    @State private var result: PortfolioBreakdownResponse?

    var body: some View {
        Group {
            if let r = result, r.cardCount > 0 {
                NavigationLink {
                    PortfolioBreakdownView()
                } label: {
                    content(r)
                }
                .buttonStyle(.plain)
            }
        }
        .task {
            // Silent on failure: this card is additive and must never put an
            // error state on the portfolio summary.
            result = try? await APIService.shared.fetchPortfolioBreakdown()
        }
    }

    private func content(_ r: PortfolioBreakdownResponse) -> some View {
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

    /// Lead with a concentration warning if there is one, else the biggest
    /// allocation gap, else the tier.
    private func subtitle(_ r: PortfolioBreakdownResponse) -> String {
        if let warning = r.concentrations.first(where: \.isWarning) {
            return "\(Int(warning.share * 100))% of value is tied to \(warning.label)"
        }
        let worst = r.allocations.max { abs($0.driftPoints) < abs($1.driftPoints) }
        if let worst, abs(worst.driftPoints) > 5 {
            let direction = worst.driftPoints < 0 ? "under" : "over"
            return "\(worst.label) is \(Int(abs(worst.driftPoints))) points \(direction) target"
        }
        return "\(r.score.tier) · allocation, risk and quality"
    }

    private func tint(_ r: PortfolioBreakdownResponse) -> Color {
        switch r.score.tier {
        case "Elite", "Strong Portfolio": return HobbyIQTheme.Colors.successGreen
        case "Good Portfolio", "Moderate Risk": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.danger
        }
    }
}
