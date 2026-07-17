//
//  HotRightNowListView.swift
//  HobbyIQ
//
//  Phase 3.7 (2026-07-17, PR #529): full-list drill-in for the DailyIQ
//  "Hot Right Now" tile. Renders the top-25 by hotScore with the same
//  row treatment as the tile itself.
//

import SwiftUI

struct HotRightNowListView: View {
    let response: HotRightNowResponse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                if let players = response.players, players.isEmpty == false {
                    ForEach(Array(players.enumerated()), id: \.element.id) { idx, player in
                        row(index: idx + 1, player: player)
                    }
                    caveatFooter
                } else {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Hot Right Now")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Top \(response.count ?? 0) hottest players")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Sorted by matched-cohort momentum × sales velocity")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(index: Int, player: HotPlayer) -> some View {
        let direction = player.direction?.lowercased() ?? ""
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        let glyph: String = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return "\u{2500}"
            }
        }()
        let sparse = player.hasFlag("sparse") || player.hasFlag("wide_ratio_dispersion")

        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("\(index).")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(width: 28, alignment: .leading)
                Text(player.player ?? "—")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer(minLength: 0)
                Text(glyph)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(color)
                if let pct = player.momentumPercentString {
                    Text(pct)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(color)
                }
                if let velocity = player.velocityPerWeek {
                    Text("\(Int(velocity.rounded()))/wk")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            if let qualifying = player.qualifyingCards,
               let pool = player.cardsInPool, pool > 0 {
                Text("\(qualifying) of \(pool) cards agree")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                    .padding(.leading, 36)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, HobbyIQTheme.Spacing.small)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        .opacity(sparse ? 0.55 : 1.0)
    }

    private var caveatFooter: some View {
        Text("Matched-cohort momentum is a market signal, not a price for a specific card. Use it to spot rising interest.")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "flame")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("Nothing hot yet today")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Check back after tonight's nightly refresh.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
    }
}
