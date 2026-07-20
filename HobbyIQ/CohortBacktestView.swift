//
//  CohortBacktestView.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR #620): Cohort Backtest — "how has the
//  2020 rookie class done" narrative surface. User picks a cohort
//  year; iOS renders a header stat ("median growth Y% over N
//  months") plus two collapsible lists: top gainers and top
//  decliners. Row tap pushes Player Detail.
//
//  Endpoint: GET /api/compiq/cohort-backtest?sport&cohortYear&window&limit
//

import SwiftUI

// MARK: - Wire models

struct CohortBacktestResponse: Decodable {
    let sport: String?
    let cohortYear: Int?
    let windowDays: Int?
    let medianGrowthPct: Double?
    let memberCount: Int?
    let topGainers: [CohortBacktestPlayer]?
    let topDecliners: [CohortBacktestPlayer]?
}

struct CohortBacktestPlayer: Decodable, Hashable, Identifiable {
    let playerName: String?
    let cardId: String?
    let cohortYear: Int?
    let initialMedian: Double?
    let currentMedian: Double?
    let growthPct: Double?
    let currentSampleN: Int?
    let initialSampleN: Int?

    var id: String { cardId ?? playerName ?? UUID().uuidString }
}

// MARK: - DailyIQ card

/// Collapsible narrative card. Two sections that expand on tap.
/// Cohort-year picker in the header lets the user shift between
/// 2018 / 2019 / 2020 / 2021 / 2022 rookie classes.
struct CohortBacktestCard: View {
    /// Optional seed response — DailyIQ can pre-fetch the default
    /// cohort so first paint is instant. Filter changes always
    /// trigger a fresh fetch.
    let seededResponse: CohortBacktestResponse?
    /// Callback for row taps — hands the player name up so DailyIQ
    /// can push its shared PlayerDetail destination.
    let onPlayerTap: (String) -> Void

    @State private var cohortYear: Int = 2020
    @State private var response: CohortBacktestResponse?
    @State private var isLoading = false
    @State private var expandGainers: Bool = true
    @State private var expandDecliners: Bool = false

    private static let cohortYears: [Int] = [2018, 2019, 2020, 2021, 2022]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            summaryLine
            gainersSection
            declinersSection
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.25), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        .task(id: cohortYear) {
            await reload()
        }
        .onAppear {
            if response == nil, let seed = seededResponse {
                response = seed
                if let y = seed.cohortYear { cohortYear = y }
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "chart.bar.doc.horizontal")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text("COHORT BACKTEST")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
            Menu {
                Picker("Cohort year", selection: $cohortYear) {
                    ForEach(Self.cohortYears, id: \.self) { y in
                        Text("\(String(y)) rookies").tag(y)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(String(cohortYear))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Summary line

    @ViewBuilder
    private var summaryLine: some View {
        if let response {
            let months = (response.windowDays ?? 0) / 30
            HStack(spacing: 8) {
                Text("\(String(response.cohortYear ?? cohortYear)) rookie class")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                if let growth = response.medianGrowthPct {
                    Text(pctString(growth))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(color(for: growth))
                }
                Spacer(minLength: 0)
            }
            if months > 0 {
                Text("Median growth over \(months) months, \(response.memberCount.map { "\($0)" } ?? "\u{2014}") players")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        } else if isLoading {
            HStack(spacing: 8) {
                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                Text("Loading cohort\u{2026}")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: - Collapsible sections

    @ViewBuilder
    private var gainersSection: some View {
        if let gainers = response?.topGainers, gainers.isEmpty == false {
            collapsibleSection(
                title: "Top gainers",
                icon: "arrow.up.right.circle",
                tint: HobbyIQTheme.Colors.hobbyGreen,
                rows: gainers,
                isExpanded: $expandGainers
            )
        }
    }

    @ViewBuilder
    private var declinersSection: some View {
        if let decliners = response?.topDecliners, decliners.isEmpty == false {
            collapsibleSection(
                title: "Top decliners",
                icon: "arrow.down.right.circle",
                tint: HobbyIQTheme.Colors.danger,
                rows: decliners,
                isExpanded: $expandDecliners
            )
        }
    }

    private func collapsibleSection(
        title: String,
        icon: String,
        tint: Color,
        rows: [CohortBacktestPlayer],
        isExpanded: Binding<Bool>
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .foregroundStyle(tint)
                    Text(title)
                        .font(.caption.weight(.bold))
                        .tracking(0.5)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer(minLength: 0)
                    Text("\(rows.count)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isExpanded.wrappedValue {
                ForEach(rows) { row in
                    playerRow(row)
                }
            }
        }
    }

    private func playerRow(_ row: CohortBacktestPlayer) -> some View {
        Button {
            if let name = row.playerName {
                onPlayerTap(name)
            }
        } label: {
            HStack(spacing: 8) {
                Text(row.playerName ?? "\u{2014}")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let g = row.growthPct {
                    Text(pctString(g))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color(for: g))
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(row.playerName == nil)
    }

    // MARK: - Format

    private func pctString(_ pct: Double) -> String {
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    private func color(for pct: Double) -> Color {
        if pct > 0 { return HobbyIQTheme.Colors.successGreen }
        if pct < 0 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    // MARK: - Reload

    private func reload() async {
        // Honor the seed only on first paint w/ matching cohort year.
        if response != nil, response?.cohortYear == cohortYear {
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchCohortBacktest(
                sport: "baseball",
                cohortYear: cohortYear,
                windowDays: 90,
                limit: 30
            )
        } catch {
            // Silent — card body renders the last-known state (or nothing).
        }
    }
}
