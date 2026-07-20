//
//  MarketMoversListView.swift
//  HobbyIQ
//
//  2026-07-19 (backend PR #608): full-screen Market Movers surface.
//  Renders card-level price movement over a window (7d/14d/30d),
//  scoped by sport and direction. Distinct from
//  `HotRightNowListView` — that surface renders player-level
//  matched-cohort momentum (Hot Right Now), whereas Market Movers is
//  a card-level delta view driven by `priorMedian` vs `currentMedian`
//  on `sold_comps`.
//
//  Row tap → Comp Sheet for the moving cardId.
//

import SwiftUI

// MARK: - Wire models (GET /api/compiq/market-movers)

struct MarketMoversResponse: Decodable {
    let sport: String?
    let windowDays: Int?
    let totalSkusInWindow: Int?
    let qualifyingMovers: Int?
    let returned: Int?
    let movers: [MarketMoversEntry]?
}

struct MarketMoversEntry: Decodable, Hashable, Identifiable {
    let cardId: String?
    let playerName: String?
    let product: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let cardYear: Int?
    let cardNumber: String?
    let priorMedian: Double?
    let currentMedian: Double?
    let deltaPct: Double?
    let deltaUSD: Double?
    let salesInWindow: Int?
    let sampleImageUrl: String?

    var id: String {
        cardId ?? "\(playerName ?? "?")|\(cardYear ?? 0)|\(cardNumber ?? "?")|\(parallel ?? "-")"
    }

    var directionGlyph: String {
        guard let d = deltaPct else { return "\u{2500}" }
        if d > 0 { return "\u{25B2}" }
        if d < 0 { return "\u{25BC}" }
        return "\u{2500}"
    }

    var isUp: Bool { (deltaPct ?? 0) > 0 }
    var isDown: Bool { (deltaPct ?? 0) < 0 }

    var displayTitle: String {
        var parts: [String] = []
        if let year = cardYear { parts.append("\(year)") }
        if let product { parts.append(product) }
        if let parallel, parallel.lowercased() != "base" { parts.append(parallel) }
        if let cardNumber { parts.append("#\(cardNumber)") }
        return parts.joined(separator: " ")
    }
}

// MARK: - Filters

enum MarketMoversSport: String, CaseIterable, Identifiable {
    case baseball, football, basketball, hockey
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

enum MarketMoversWindow: String, CaseIterable, Identifiable {
    case sevenDay = "7d"
    case fourteenDay = "14d"
    case thirtyDay = "30d"
    var id: String { rawValue }
    var days: Int {
        switch self {
        case .sevenDay: return 7
        case .fourteenDay: return 14
        case .thirtyDay: return 30
        }
    }
    var label: String { rawValue }
}

enum MarketMoversDirection: String, CaseIterable, Identifiable {
    case both, gainers, losers
    var id: String { rawValue }
    var apiValue: String { rawValue == "both" ? "both" : (rawValue == "gainers" ? "up" : "down") }
    var label: String {
        switch self {
        case .both: return "All"
        case .gainers: return "Gainers"
        case .losers: return "Losers"
        }
    }
}

// MARK: - View

struct MarketMoversListView: View {
    /// Optional seed data — used by the Dashboard at-a-glance handoff
    /// so the initial paint is instant with the already-fetched
    /// response. Absent when the surface loads from a fresh entry
    /// point (Sales tab, deep-link).
    let seededResponse: MarketMoversResponse?

    @State private var sport: MarketMoversSport = .baseball
    @State private var window: MarketMoversWindow = .sevenDay
    @State private var direction: MarketMoversDirection = .both
    @State private var response: MarketMoversResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var navigateCardId: String?
    @State private var navigatePlayerName: String?

    init(seededResponse: MarketMoversResponse? = nil) {
        self.seededResponse = seededResponse
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                filterRow
                summaryCaption
                if isLoading && response == nil {
                    loadingState
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let movers = response?.movers, movers.isEmpty == false {
                    ForEach(movers) { mover in
                        moverRow(mover)
                    }
                } else if response != nil {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Movers")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: reloadKey) {
            await reload()
        }
        .navigationDestination(item: $navigateCardId) { cardId in
            // 2026-07-19: route row-tap to CompIQPricedCardView (Comp
            // Sheet). Constructs a synthetic `CompIQVariantHit` from
            // just the cardId — the view fetches identity + comps on
            // appear via /api/compiq/price-by-id.
            CompIQPricedCardView(hit: CompIQVariantHit(cardId: cardId))
        }
        .navigationDestination(item: $navigatePlayerName) { name in
            PlayerDetailView(playerName: name)
        }
        .onAppear {
            if response == nil, let seed = seededResponse {
                response = seed
            }
        }
    }

    private var reloadKey: String {
        "\(sport.rawValue)|\(window.rawValue)|\(direction.rawValue)"
    }

    // MARK: - Filter row

    private var filterRow: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Sport", selection: $sport) {
                    ForEach(MarketMoversSport.allCases) { s in
                        Text(s.label).tag(s)
                    }
                }
            } label: {
                filterChip(label: sport.label)
            }
            .buttonStyle(.plain)

            Menu {
                Picker("Window", selection: $window) {
                    ForEach(MarketMoversWindow.allCases) { w in
                        Text(w.label).tag(w)
                    }
                }
            } label: {
                filterChip(label: window.label)
            }
            .buttonStyle(.plain)

            Picker("Direction", selection: $direction) {
                ForEach(MarketMoversDirection.allCases) { d in
                    Text(d.label).tag(d)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func filterChip(label: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            Capsule(style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
    }

    // MARK: - Summary caption

    @ViewBuilder
    private var summaryCaption: some View {
        if let response, let qualifying = response.qualifyingMovers, let pool = response.totalSkusInWindow {
            Text("\(qualifying.formatted(.number.grouping(.automatic))) qualifying movers in \(pool.formatted(.number.grouping(.automatic))) SKUs (last \(window.days)d)")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // MARK: - Row

    private func moverRow(_ mover: MarketMoversEntry) -> some View {
        // 2026-07-20 (spec §5): row body has two tap zones — the
        // player-name button routes to `PlayerDetailView`, the rest
        // of the row routes to Comp Sheet. Using `onTapGesture` on
        // the row container instead of an outer Button avoids
        // nested-button hit-testing ambiguity.
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(mover.directionGlyph)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(directionColor(mover))
                    .frame(width: 20, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    if let name = mover.playerName {
                        Button {
                            navigatePlayerName = name
                        } label: {
                            HStack(spacing: 3) {
                                Text(name)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
                            }
                        }
                        .buttonStyle(.plain)
                    } else {
                        Text("\u{2014}")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    Text(mover.displayTitle)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let pct = mover.deltaPct {
                    Text(pctString(pct))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(directionColor(mover))
                }
            }

            HStack(spacing: 6) {
                if let prior = mover.priorMedian, let current = mover.currentMedian {
                    Text("\(dollars(prior)) \u{2192} \(dollars(current))")
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                Spacer(minLength: 0)
                if let n = mover.salesInWindow {
                    Text("\(n) sales")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                }
            }
            .padding(.leading, 28)
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
        .onTapGesture {
            navigateCardId = mover.cardId
        }
    }

    private func directionColor(_ mover: MarketMoversEntry) -> Color {
        if mover.isUp { return HobbyIQTheme.Colors.successGreen }
        if mover.isDown { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    private func pctString(_ pct: Double) -> String {
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading movers\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No qualifying movers in this window.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try a wider window or a different sport.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
            Text("Couldn't load movers.")
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
        // Honor the seed only on the first paint; subsequent filter
        // changes re-fetch from the backend.
        if response != nil && seededResponse != nil && reloadKey == "baseball|7d|both" {
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await APIService.shared.fetchMarketMovers(
                sport: sport.rawValue,
                window: window.rawValue,
                direction: direction.apiValue,
                limit: 50
            )
            response = result
        } catch {
            errorMessage = "The server didn't respond in time."
        }
    }
}
