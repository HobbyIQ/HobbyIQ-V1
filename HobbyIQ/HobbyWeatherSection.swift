//
//  HobbyWeatherSection.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR #622): "Hobby Weather" — week-over-week
//  index of the entire hobby (activity + median transaction) plus
//  top gainers / decliners from the last 7 days. Rendered as a
//  section near the top of DailyIQ so users see the hobby-wide
//  mood before diving into their own holdings. A compact
//  preview card also appears on the Dashboard at-a-glance section.
//
//  Endpoint: GET /api/insights/weekly-hobby-index?sport=baseball
//

import SwiftUI

// MARK: - Wire models

struct WeeklyHobbyIndexResponse: Decodable {
    let sport: String?
    let weekStart: String?
    let weekEnd: String?
    let computedAt: String?
    let activity: WeeklyHobbyActivity?
    let index: WeeklyHobbyIndex?
    let topGainers: [WeeklyHobbyMover]?
    let topDecliners: [WeeklyHobbyMover]?
}

struct WeeklyHobbyActivity: Decodable, Hashable {
    let salesThisWeek: Int?
    let salesPriorWeek: Int?
    let activityDeltaPct: Double?
    let distinctCardsThisWeek: Int?
}

struct WeeklyHobbyIndex: Decodable, Hashable {
    let medianTransactionThisWeek: Double?
    let medianTransactionPriorWeek: Double?
    let indexDeltaPct: Double?
}

struct WeeklyHobbyMover: Decodable, Hashable, Identifiable {
    let cardId: String?
    let playerName: String?
    let priorMedian: Double?
    let currentMedian: Double?
    let deltaPct: Double?
    let deltaUSD: Double?

    var id: String { cardId ?? UUID().uuidString }
}

// MARK: - DailyIQ section

/// Full-width section rendered near the top of DailyIQ. Two-column
/// header (activity + index WoW), then two 5-row lists (gainers /
/// decliners). Row tap pushes Comp Sheet for the moving cardId.
///
/// Self-suppresses when the response is nil — DailyIQ silently
/// hides the section if the weekly job hasn't computed yet.
struct HobbyWeatherSection: View {
    let response: WeeklyHobbyIndexResponse?

    var body: some View {
        if let response {
            content(response)
        }
    }

    @ViewBuilder
    private func content(_ response: WeeklyHobbyIndexResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader
            headerStats(response)
            if let gainers = response.topGainers, gainers.isEmpty == false {
                moverList(title: "Top gainers", rows: gainers, isUp: true)
            }
            if let decliners = response.topDecliners, decliners.isEmpty == false {
                moverList(title: "Top decliners", rows: decliners, isUp: false)
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private var sectionHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text("HOBBY WEATHER")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func headerStats(_ response: WeeklyHobbyIndexResponse) -> some View {
        HStack(alignment: .top, spacing: 12) {
            statBlock(
                title: "Activity",
                delta: response.activity?.activityDeltaPct,
                subtitle: response.activity?.salesThisWeek.map { "\($0.formatted(.number.grouping(.automatic))) sales" }
            )
            statBlock(
                title: "Index",
                delta: response.index?.indexDeltaPct,
                subtitle: response.index?.medianTransactionThisWeek.map { dollars($0) }
            )
        }
    }

    private func statBlock(title: String, delta: Double?, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.bold))
                .tracking(0.4)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            HStack(spacing: 4) {
                if let delta {
                    Text(pctString(delta))
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(color(for: delta))
                } else {
                    Text("\u{2014}")
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func moverList(title: String, rows: [WeeklyHobbyMover], isUp: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.bold))
                .tracking(0.5)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            ForEach(rows.prefix(5)) { row in
                moverRow(row, isUp: isUp)
            }
        }
    }

    private func moverRow(_ row: WeeklyHobbyMover, isUp: Bool) -> some View {
        // 2026-07-20: row tap pushes CompIQPricedCardView via a
        // synthetic CompIQVariantHit — same pattern as Market Movers.
        NavigationLink {
            if let id = row.cardId {
                CompIQPricedCardView(hit: CompIQVariantHit(cardId: id))
            }
        } label: {
            HStack(spacing: 8) {
                Text(row.playerName ?? "\u{2014}")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let delta = row.deltaPct {
                    Text(pctString(delta))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color(for: delta))
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(row.cardId == nil)
    }

    // MARK: - Format helpers

    private func pctString(_ pct: Double) -> String {
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    private func color(for pct: Double) -> Color {
        if pct > 0 { return HobbyIQTheme.Colors.successGreen }
        if pct < 0 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }

    private func dollars(_ value: Double) -> String {
        "$\(Int(value.rounded()).formatted(.number.grouping(.automatic)))"
    }
}
