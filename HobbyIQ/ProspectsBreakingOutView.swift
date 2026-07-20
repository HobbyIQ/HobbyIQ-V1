//
//  ProspectsBreakingOutView.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR #620): Prospects Breaking Out — raw
//  inversion signals where a card's raw MAX exceeds the graded
//  MEDIAN by >= 5%. Backend precomputes; iOS renders as a
//  compact banner on DailyIQ home + a full drill-down list.
//
//  Endpoint: GET /api/dailyiq/prospects/breaking-out?sport&window&limit
//

import SwiftUI

// MARK: - Wire models

struct ProspectsBreakingOutResponse: Decodable {
    let sport: String?
    let windowDays: Int?
    let computedAt: String?
    let count: Int?
    let totalDetected: Int?
    let prospects: [ProspectsBreakingOutEntry]?
}

struct ProspectsBreakingOutEntry: Decodable, Hashable, Identifiable {
    let rank: Int?
    let cardId: String?
    let playerName: String?
    let parallel: String?
    let cardNumber: String?
    let cardYear: Int?
    let grader: String?
    let gradedMedian: Double?
    let gradedCount: Int?
    let rawMedian: Double?
    let rawMax: Double?
    let rawCount: Int?
    let marginPct: Double?
    let marginUSD: Double?

    var id: String { cardId ?? "\(rank ?? 0)-\(playerName ?? "?")" }

    /// Row subtitle line: "raw $X → {grader} med $Y (+Z%)"
    var summaryLine: String {
        var parts: [String] = []
        if let raw = rawMax { parts.append("raw \(dollars(raw))") }
        if let grader, let median = gradedMedian {
            parts.append("\u{2192} \(grader) med \(dollars(median))")
        }
        if let pct = marginPct {
            let sign = pct >= 0 ? "+" : "\u{2212}"
            parts.append("(\(sign)\(String(format: "%.1f", abs(pct)))%)")
        }
        return parts.joined(separator: " ")
    }

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }
}

// MARK: - DailyIQ banner

/// Compact banner on DailyIQ home. Tap → full list. Renders a 3-row
/// preview when the response has entries; self-suppresses when empty
/// / nil / thin. Matches the visual language of `HotRightNowTile`
/// and the other DailyIQ discovery banners.
struct ProspectsBreakingOutBanner: View {
    let response: ProspectsBreakingOutResponse?

    @State private var showFullList = false

    var body: some View {
        if let response,
           let entries = response.prospects,
           entries.isEmpty == false {
            content(entries: entries, response: response)
                .navigationDestination(isPresented: $showFullList) {
                    ProspectsBreakingOutListView(seededResponse: response)
                }
        }
    }

    private func content(entries: [ProspectsBreakingOutEntry], response: ProspectsBreakingOutResponse) -> some View {
        Button {
            showFullList = true
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.right.circle.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                    Text("PROSPECTS BREAKING OUT")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                    Text("See all \(response.totalDetected.map { "\($0)" } ?? "\(entries.count)")")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.7))
                }
                Text("Raw sales landing above graded medians — signal a grade-worthy pop.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                ForEach(entries.prefix(3)) { entry in
                    entryRow(entry)
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.hobbyGreen.opacity(0.35), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func entryRow(_ entry: ProspectsBreakingOutEntry) -> some View {
        HStack(spacing: 8) {
            if let rank = entry.rank {
                Text("\(rank).")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .frame(width: 20, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.playerName ?? "\u{2014}")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Text(entry.summaryLine)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Full drill-down list

struct ProspectsBreakingOutListView: View {
    let seededResponse: ProspectsBreakingOutResponse?

    @State private var sport: String = "baseball"
    @State private var windowDays: Int = 30
    @State private var response: ProspectsBreakingOutResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var navigateCardId: String?

    init(seededResponse: ProspectsBreakingOutResponse? = nil) {
        self.seededResponse = seededResponse
    }

    private static let windowOptions: [Int] = [7, 14, 30, 60]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                filterRow
                if isLoading && response == nil {
                    loadingState
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let entries = response?.prospects, entries.isEmpty == false {
                    ForEach(entries) { entry in
                        row(entry)
                    }
                } else if response != nil {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationTitle("Prospects breaking out")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: reloadKey) {
            await reload()
        }
        .navigationDestination(item: $navigateCardId) { cardId in
            CompIQPricedCardView(hit: CompIQVariantHit(cardId: cardId))
        }
        .onAppear {
            if response == nil, let seed = seededResponse {
                response = seed
            }
        }
    }

    private var reloadKey: String {
        "\(sport)|\(windowDays)"
    }

    private var filterRow: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Window", selection: $windowDays) {
                    ForEach(Self.windowOptions, id: \.self) { d in
                        Text("\(d)d").tag(d)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text("\(windowDays)d")
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
            .buttonStyle(.plain)
            Spacer(minLength: 0)
            if let response, let total = response.totalDetected {
                Text("\(total) total signals")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private func row(_ entry: ProspectsBreakingOutEntry) -> some View {
        Button {
            navigateCardId = entry.cardId
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    if let rank = entry.rank {
                        Text("\(rank).")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .frame(width: 28, alignment: .leading)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.playerName ?? "\u{2014}")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text(cardMetadataLine(entry))
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let margin = entry.marginPct {
                        Text(pctString(margin))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                    }
                }
                Text(entry.summaryLine)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.leading, 36)
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
        .disabled(entry.cardId == nil)
    }

    private func cardMetadataLine(_ entry: ProspectsBreakingOutEntry) -> String {
        var parts: [String] = []
        if let year = entry.cardYear { parts.append("\(year)") }
        if let parallel = entry.parallel, parallel.lowercased() != "base" { parts.append(parallel) }
        if let num = entry.cardNumber { parts.append("#\(num)") }
        return parts.isEmpty ? "\u{2014}" : parts.joined(separator: " \u{00B7} ")
    }

    private func pctString(_ pct: Double) -> String {
        let sign = pct >= 0 ? "+" : "\u{2212}"
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading prospects\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "arrow.up.right.circle")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No breakouts in this window.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try a wider window.")
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
            Text("Couldn't load prospects.")
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

    private func reload() async {
        // Honor the seed on first paint w/ defaults; refetch on filter changes.
        if response != nil && seededResponse != nil && reloadKey == "baseball|30" {
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchProspectsBreakingOut(
                sport: sport,
                windowDays: windowDays,
                limit: 50
            )
        } catch {
            errorMessage = "The server didn't respond in time."
        }
    }
}
