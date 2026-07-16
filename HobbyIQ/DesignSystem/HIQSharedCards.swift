//
//  HIQSharedCards.swift
//  HobbyIQ
//
//  Shared PortfolioIQ-language components used by any tab that renders a
//  hero card + action pills grid + recent-activity list.
//

import SwiftUI

// MARK: - Hero Delta

/// Convenience payload for the single-line "since last period" chip.
/// Callers who want more structure (e.g. PortfolioIQ's `$X • Y% ROI`)
/// pass a custom view into `HIQHeroCard`'s `delta` builder instead.
struct HIQHeroDelta: Equatable {
    let text: String
    let isPositive: Bool
}

/// Default rendering for a simple `HIQHeroDelta` — arrow + text, colored
/// by sign. Financials uses this straight through; PortfolioIQ builds its
/// own composition to preserve the `P/L • ROI` shape.
struct HIQHeroDeltaLine: View {
    let delta: HIQHeroDelta

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: delta.isPositive ? "arrow.up.right" : "arrow.down.right")
                .font(.caption2.weight(.bold))
            Text(delta.text)
                .font(.subheadline.weight(.semibold))
        }
        .foregroundStyle(delta.isPositive ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
    }
}

// MARK: - Hero Card

/// The full-width card at the top of a tab: title + green status dot +
/// date + big white value + composable delta / sparkline / metadata slots
/// + optional trailing button. Applies the shared `hiqCardStyle` chrome
/// so every tab's hero renders in the same visual language.
///
/// Slot order is fixed (title-row → value+delta → sparkline → meta); each
/// slot defaults to `EmptyView` so callers only pass what they need.
/// Horizontal alignment for the hero card title row.
/// `.leading` — title on the left, leading slot before it (PortfolioIQ, Financials).
/// `.center` — title horizontally centered; leading/trailing slots pin to the edges.
enum HIQHeroTitleAlignment {
    case leading
    case center
}

struct HIQHeroCard<Leading: View, Trailing: View, Delta: View, Sparkline: View, Meta: View>: View {
    let title: String
    let statusDate: String
    let heroValue: String
    let titleAlignment: HIQHeroTitleAlignment
    let leading: Leading
    let trailing: Trailing
    let delta: Delta
    let sparkline: Sparkline
    let meta: Meta

    init(
        title: String,
        statusDate: String,
        heroValue: String,
        titleAlignment: HIQHeroTitleAlignment = .leading,
        @ViewBuilder leading: () -> Leading = { EmptyView() },
        @ViewBuilder trailing: () -> Trailing = { EmptyView() },
        @ViewBuilder delta: () -> Delta = { EmptyView() },
        @ViewBuilder sparkline: () -> Sparkline = { EmptyView() },
        @ViewBuilder meta: () -> Meta = { EmptyView() }
    ) {
        self.title = title
        self.statusDate = statusDate
        self.heroValue = heroValue
        self.titleAlignment = titleAlignment
        self.leading = leading()
        self.trailing = trailing()
        self.delta = delta()
        self.sparkline = sparkline()
        self.meta = meta()
    }

    @ViewBuilder
    private var titleBlock: some View {
        VStack(spacing: 4) {
            Text(title)
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            HStack(spacing: 6) {
                Circle()
                    .fill(HobbyIQTheme.Colors.hobbyGreen)
                    .frame(width: 7, height: 7)
                Text(statusDate)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
        }
    }

    @ViewBuilder
    private var titleRow: some View {
        switch titleAlignment {
        case .leading:
            HStack(alignment: .top, spacing: 12) {
                leading
                titleBlock
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
            }
        case .center:
            ZStack {
                titleBlock
                HStack {
                    leading
                    Spacer()
                    trailing
                }
            }
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            titleRow

            VStack(spacing: 6) {
                Text(heroValue)
                    .font(.system(size: 36, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)

                delta
            }
            .frame(maxWidth: .infinity)

            sparkline

            meta
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCardStyle()
    }
}

// MARK: - Action Pill

/// Horizontal pill button used by PortfolioIQ (Weekly Brief / Calibration
/// / Reprice All / Scan Card / Export / Import) and by Financials (P&L /
/// Expenses / Reconcile / Reports). Blue icon left, bold white label,
/// steelGray container. Meant to live in a 2-column grid.
struct HIQActionPill: View {
    let title: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.steelGray.opacity(0.2))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Compact Sale Row

/// Purpose-built row for the Financials "Recent sales" list: thumbnail +
/// player + set subtitle + trailing green sale price + muted sold date.
/// Distinct from `moverRow` (which surfaces historical P/L and action
/// recommendations, not realized transactions).
struct HIQCompactSaleRow: View {
    let entry: PortfolioLedgerEntry

    private var subtitle: String {
        entry.cardTitle ?? "—"
    }

    private var salePrice: Double {
        if let gp = entry.grossProceeds, gp > 0 { return gp }
        return (entry.unitSalePrice ?? 0) * Double(entry.quantitySold ?? 1)
    }

    private var soldDateShort: String {
        guard let raw = entry.soldAt else { return "" }
        for parser in Self.isoParsers {
            if let date = parser.date(from: raw) {
                return Self.shortDate.string(from: date)
            }
        }
        return ""
    }

    private static let isoParsers: [ISO8601DateFormatter] = {
        let a = ISO8601DateFormatter()
        a.formatOptions = [.withInternetDateTime]
        let b = ISO8601DateFormatter()
        b.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return [b, a]
    }()

    private static let shortDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            inventoryRowThumbnail(urlString: nil, playerName: entry.playerName)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.playerName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: 2) {
                Text(salePrice.portfolioCurrencyText)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                if soldDateShort.isEmpty == false {
                    Text(soldDateShort)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
    }
}
