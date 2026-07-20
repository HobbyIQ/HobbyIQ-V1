//
//  CascadeAlertsListView.swift
//  HobbyIQ
//
//  Phase 3.8 (2026-07-17, PR #527): drill-down for the portfolio-home
//  Cascade Alerts banner. Renders every fired event with a severity chip,
//  reason copy, and the underlying detection input as a small caption
//  block so users can see WHY the signal fired.
//
//  Severity ordering: insider > emerging > confirmed. Insider = graded
//  moving alone (early insider signal); confirmed = later-stage.
//

import SwiftUI

struct CascadeAlertsListView: View {
    let alerts: CascadeAlertsResponse?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if let events = sortedEvents(), events.isEmpty == false {
                    ForEach(events) { event in
                        eventCard(event)
                    }
                    caveatFooter
                } else {
                    emptyState
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Cascade Signals")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }

    // MARK: - Header

    private var header: some View {
        let scanned = alerts?.ownedPlayers ?? 0
        let fired = alerts?.events?.count ?? 0
        return VStack(alignment: .leading, spacing: 4) {
            Text("\(fired) cascade signal\(fired == 1 ? "" : "s")")
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Across \(scanned) player\(scanned == 1 ? "" : "s") in your portfolio · sorted by severity")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Event card

    private func eventCard(_ event: CascadeEvent) -> some View {
        let severity = event.severity?.lowercased() ?? ""
        let color = severityColor(severity)
        let glyph = severityGlyph(severity)
        let label = severityLabel(severity)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(glyph)
                    .font(.title3)
                Text(label)
                    .font(.caption.weight(.bold))
                    .tracking(0.5)
                    .foregroundStyle(color)
                Spacer(minLength: 0)
                if let detectedAt = event.detectedAt.flatMap({ Self.friendlyDate($0) }) {
                    Text(detectedAt)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            Text(event.player ?? "—")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            if let reason = event.reason?.trimmingCharacters(in: .whitespaces),
               reason.isEmpty == false {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let input = event.detectionInput {
                detectionInputStrip(input)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(color.opacity(0.4), lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    /// Underlying signal breakdown — raw vs graded momentum + qualifying
    /// card counts. Advisor-voice; helps the user see the math.
    @ViewBuilder
    private func detectionInputStrip(_ input: CascadeDetectionInput) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let raw = input.rawMomentum, let graded = input.gradedMomentum {
                Text("Raw: \(momentumString(raw)) · Graded: \(momentumString(graded))")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            if let rawN = input.rawQualifyingCards, let gradedN = input.gradedQualifyingCards {
                Text("Sample: \(rawN) raw / \(gradedN) graded qualifying cards")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
            }
        }
        .padding(.top, 4)
    }

    private var caveatFooter: some View {
        Text("Cascade signals fire when a player's graded market moves ahead of the raw market — an early insider signal before broader prices catch on.")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.8))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "waveform")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No cascade signals firing right now")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("We rescan nightly. You'll get pinged if you've opted in.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
    }

    // MARK: - Helpers

    private func sortedEvents() -> [CascadeEvent]? {
        alerts?.events?.sorted { lhs, rhs in
            if lhs.severityRank != rhs.severityRank {
                return lhs.severityRank > rhs.severityRank
            }
            return (lhs.detectedAt ?? "") > (rhs.detectedAt ?? "")
        }
    }

    private func severityColor(_ severity: String) -> Color {
        switch severity {
        case "insider": return HobbyIQTheme.Colors.danger
        case "emerging": return HobbyIQTheme.Colors.warning
        case "confirmed": return HobbyIQTheme.Colors.successGreen
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    private func severityGlyph(_ severity: String) -> String {
        switch severity {
        case "insider": return "\u{1F6A8}"
        case "emerging": return "\u{26A1}"
        case "confirmed": return "\u{1F4C8}"
        default: return "\u{1F3AF}"
        }
    }

    private func severityLabel(_ severity: String) -> String {
        switch severity {
        case "insider": return "INSIDER SIGNAL"
        case "emerging": return "EMERGING"
        case "confirmed": return "CONFIRMED"
        default: return severity.uppercased()
        }
    }

    private func momentumString(_ momentum: Double) -> String {
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    nonisolated private static func friendlyDate(_ raw: String) -> String? {
        let parsers: [ISO8601DateFormatter] = [
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return f
            }(),
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime]
                return f
            }()
        ]
        guard let date = parsers.compactMap({ $0.date(from: raw) }).first else { return nil }
        let delta = Date().timeIntervalSince(date)
        if delta < 3_600 { return "\(Int(delta / 60))m ago" }
        if delta < 86_400 { return "\(Int(delta / 3_600))h ago" }
        return "\(Int(delta / 86_400))d ago"
    }
}
