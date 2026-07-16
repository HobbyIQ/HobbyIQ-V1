//
//  HIQCardStyles.swift
//  HobbyIQ
//
//  CF-DAILYIQ-VISUAL-REFRESH (2026-07-07): shared card-style vocabulary
//  used across the app so any list-of-things page (DailyIQ, PortfolioIQ,
//  card detail) reads with the same rounded-container / tinted-signal /
//  capsule-badge language.
//
//  Design tokens (colors, gradients, radii) all come from HobbyIQTheme —
//  nothing invented here.
//

import SwiftUI

// MARK: - Currency formatting

/// CF-PILL-HEADLINE-ALIGN (2026-07-07): whole-dollar USD string with
/// explicit half-up rounding — `.49 and below` rounds down, `.5 and
/// above` rounds up. Swift's default `.currency` formatter uses
/// banker's (half-to-even) rounding, which can make pill and headline
/// disagree on `.5` boundaries. Every surface that shows the same
/// number twice (pill + MARKET VALUE headline) should route through
/// this helper so rounding can never diverge.
func wholeUSDString(_ value: Double) -> String {
    let rounded = value.rounded(.toNearestOrAwayFromZero)
    return rounded.currencyStringNoCents
}

// MARK: - Card container modifiers

extension View {
    /// Detail-screen tile container. High-emphasis: full `cardNavy` fill,
    /// 2pt gradient stroke, `Radius.xLarge`, drop shadow. Used for the
    /// identity header + each top-level tile on card detail.
    func hiqCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }

    /// Nested / section-level tile. Lower-emphasis than `hiqCard()`:
    /// 70% cardNavy, 1.6pt stroke, softer shadow. Use anywhere you want
    /// the "small premium data card" language — DailyIQ signal sections,
    /// nested groups inside a detail tile, etc.
    func hiqGroupCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.6)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.15), radius: 6, x: 0, y: 3)
    }

    /// Low-emphasis row tint. Applied inside a `hiqGroupCard()` on
    /// individual rows so a Trending Up row reads faintly green, a
    /// Cooling Off row reads faintly red, etc. Tint alpha capped at
    /// ~9% so it never competes with the container gradient border.
    func hiqSignalTint(_ signal: HIQSignal) -> some View {
        self
            .background(signal.tint.opacity(0.08))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(signal.tint.opacity(0.18), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
}

// MARK: - Signal

/// Semantic direction key for tint / badge coloring across market rows.
enum HIQSignal {
    case positive   // Trending Up, Supply Squeeze, gainers
    case negative   // Cooling Off, losers
    case neutral    // Most Traded, informational

    var tint: Color {
        switch self {
        case .positive: return HobbyIQTheme.Colors.hobbyGreen
        case .negative: return HobbyIQTheme.Colors.danger
        case .neutral:  return HobbyIQTheme.Colors.mutedText
        }
    }

    var arrowSystemImage: String? {
        switch self {
        case .positive: return "arrow.up.right"
        case .negative: return "arrow.down.right"
        case .neutral:  return nil
        }
    }
}

// MARK: - HIQBadge

/// Capsule pill matching the detail-screen `actionBadge` metrics
/// (padding 8h/4v, capsule stroke). Icon optional. Tinted foreground
/// on tinted background — no eyeballed values, all from theme.
struct HIQBadge: View {
    let text: String
    let signal: HIQSignal
    var systemImage: String?

    init(text: String, signal: HIQSignal, systemImage: String? = nil) {
        self.text = text
        self.signal = signal
        self.systemImage = systemImage ?? signal.arrowSystemImage
    }

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
            }
            Text(text)
                .font(.caption.weight(.bold).monospacedDigit())
                .tracking(0.3)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(signal.tint)
        .background(signal.tint.opacity(0.14))
        .overlay(
            Capsule(style: .continuous)
                .stroke(signal.tint.opacity(0.35), lineWidth: 1)
        )
        .clipShape(Capsule(style: .continuous))
    }
}

// MARK: - HIQAvatar

/// Two-letter monogram avatar used as the leading row anchor when no
/// per-player sparkline series is available. Kept subtle by design —
/// no team-color mapping, no gradient. Just initials on a muted disc.
struct HIQAvatar: View {
    let initials: String
    var size: CGFloat = 32

    init(from name: String, size: CGFloat = 32) {
        self.initials = HIQAvatar.extractInitials(from: name)
        self.size = size
    }

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.38, weight: .bold, design: .rounded))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .frame(width: size, height: size)
            .background(
                Circle().fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
            )
            .overlay(
                Circle().stroke(Color.white.opacity(0.08), lineWidth: 1)
            )
    }

    private static func extractInitials(from name: String) -> String {
        let parts = name
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" })
            .filter { !$0.isEmpty }
        guard parts.isEmpty == false else { return "•" }
        let first = parts.first?.first.map { String($0) } ?? ""
        let last = parts.count >= 2 ? (parts.last?.first.map { String($0) } ?? "") : ""
        let combined = (first + last).uppercased()
        return combined.isEmpty ? "•" : combined
    }
}
