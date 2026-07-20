//
//  PlayerDetailView.swift
//  HobbyIQ
//
//  2026-07-19 (backend PR #612): pricing-focused Player Detail surface.
//  Distinct from `PlayerIQView` — that surface renders the analysis
//  score / market health / performance concepts. This one renders
//  the sold-comps summary the spec asks for at §5: total sales,
//  median, delta %, price range, top cards, and by-year rollups.
//
//  Reached via any surface that surfaces a player name (Comp Sheet,
//  Market Movers, cert lookup result). Row taps on `topCards` push a
//  Comp Sheet for the matching cardId.
//

import SwiftUI

// MARK: - Wire models (GET /api/players/:name)

struct PlayerDetailResponse: Decodable {
    let player: String?
    let sport: String?
    let windowDays: Int?
    let summary: PlayerDetailSummary?
    let topCards: [PlayerDetailTopCard]?
    let byYear: [PlayerDetailByYear]?
}

struct PlayerDetailSummary: Decodable, Hashable {
    let totalSales: Int?
    let medianPrice: Double?
    let deltaPct: Double?
    let priorMedianPrice: Double?
    let distinctCards: Int?
    let priceRange: PlayerDetailPriceRange?
}

struct PlayerDetailPriceRange: Decodable, Hashable {
    let min: Double?
    let p25: Double?
    let p50: Double?
    let p75: Double?
    let max: Double?
}

struct PlayerDetailTopCard: Decodable, Hashable, Identifiable {
    let cardId: String?
    let product: String?
    let parallel: String?
    let cardYear: Int?
    let cardNumber: String?
    let count: Int?
    let median: Double?
    let min: Double?
    let max: Double?
    let sampleImageUrl: String?

    var id: String {
        cardId ?? "\(cardYear ?? 0)|\(product ?? "?")|\(cardNumber ?? "?")|\(parallel ?? "-")"
    }

    var displayTitle: String {
        var parts: [String] = []
        if let year = cardYear { parts.append("\(year)") }
        if let product { parts.append(product) }
        if let parallel, parallel.lowercased() != "base" { parts.append(parallel) }
        if let cardNumber { parts.append("#\(cardNumber)") }
        return parts.isEmpty ? "\u{2014}" : parts.joined(separator: " ")
    }
}

struct PlayerDetailByYear: Decodable, Hashable, Identifiable {
    let cardYear: Int?
    let count: Int?
    let median: Double?
    let minSaleDate: String?
    let maxSaleDate: String?

    var id: Int { cardYear ?? -1 }
}

// MARK: - View

struct PlayerDetailView: View {
    let playerName: String
    let sport: String
    let days: Int

    @State private var response: PlayerDetailResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var navigateCardId: String?

    init(playerName: String, sport: String = "baseball", days: Int = 30) {
        self.playerName = playerName
        self.sport = sport
        self.days = days
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if isLoading && response == nil {
                    loadingState
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let response, let summary = response.summary {
                    summarySection(summary)
                    topCardsSection
                    byYearSection
                } else if response != nil {
                    notEnoughDataState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle(playerName)
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task {
            await reload()
        }
        .navigationDestination(item: $navigateCardId) { cardId in
            CompIQPricedCardView(hit: CompIQVariantHit(cardId: cardId))
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(playerName)
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("\(sport.capitalized) \u{00B7} last \(days)d")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Summary

    private func summarySection(_ summary: PlayerDetailSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let total = summary.totalSales {
                Text("\(total.formatted(.number.grouping(.automatic))) sales")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            HStack(spacing: 12) {
                if let median = summary.medianPrice {
                    Text("median \(dollars(median))")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let delta = summary.deltaPct {
                    Text(deltaChip(delta))
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(deltaColor(delta).opacity(0.16))
                        .foregroundStyle(deltaColor(delta))
                        .clipShape(Capsule(style: .continuous))
                }
            }
            if let range = summary.priceRange, let min = range.min, let max = range.max {
                Text("range \(dollars(min))\u{2013}\(dollars(max))")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func deltaChip(_ pct: Double) -> String {
        let arrow = pct > 0 ? "\u{2191}" : (pct < 0 ? "\u{2193}" : "\u{2500}")
        return "\(arrow) \(String(format: "%.1f", abs(pct)))%"
    }

    private func deltaColor(_ pct: Double) -> Color {
        if pct > 0 { return HobbyIQTheme.Colors.successGreen }
        if pct < 0 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    // MARK: - Top cards

    @ViewBuilder
    private var topCardsSection: some View {
        if let topCards = response?.topCards, topCards.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Top cards")
                ForEach(topCards) { card in
                    topCardRow(card)
                }
            }
        }
    }

    private func topCardRow(_ card: PlayerDetailTopCard) -> some View {
        Button {
            navigateCardId = card.cardId
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(card.displayTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                HStack(spacing: 8) {
                    if let count = card.count {
                        Text("\(count) sales")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if let median = card.median {
                        Text("\u{00B7} median \(dollars(median))")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, HobbyIQTheme.Spacing.small)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.6))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(card.cardId == nil)
    }

    // MARK: - By year

    @ViewBuilder
    private var byYearSection: some View {
        if let byYear = response?.byYear, byYear.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("By year")
                ForEach(byYear) { year in
                    HStack {
                        Text("\(year.cardYear.map { String($0) } ?? "—")")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .frame(width: 60, alignment: .leading)
                        if let count = year.count {
                            Text("\(count) sales")
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                        Spacer(minLength: 0)
                        if let median = year.median {
                            Text(dollars(median))
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, HobbyIQTheme.Spacing.small)
                    .background(HobbyIQTheme.Colors.cardNavy.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                            .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
                }
            }
        }
    }

    // MARK: - Reusable pieces

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .tracking(0.6)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading player detail\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var notEnoughDataState: some View {
        VStack(spacing: 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("Not enough recent sales for \(playerName)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.center)
            Text("Try a wider window or check that the spelling matches.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
            Text("Couldn't load player detail.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    // MARK: - Reload

    private func reload() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchPlayerDetail(
                playerName: playerName,
                sport: sport,
                days: days
            )
        } catch {
            errorMessage = "The server didn't respond in time."
        }
    }
}
