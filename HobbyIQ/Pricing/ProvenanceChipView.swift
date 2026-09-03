//
//  ProvenanceChipView.swift
//  HobbyIQ
//
//  CF-IOS-RUNG-PARITY (Drew, 2026-09-02). The iOS counterpart of
//  apps/web/src/components/ProvenanceChip.tsx.
//
//  Says, in one line beside a price, whether the number was OBSERVED from
//  this card's own pool or is an ESTIMATE from somewhere else — and, when
//  the pool behind it has gone cold, that the price is projected to
//  today's market rather than read off two-month-old prints.
//
//  The two chips are separate on purpose. The rung says which pool; the
//  staleness says how old that pool is; those are different facts and
//  neither replaces the other. The staleness chip is warning-coloured
//  because it is a CAVEAT on the number, not a second provenance claim.
//

import SwiftUI

/// Colour per rung kind, on the app's dark design-system palette.
///
/// The app runs `.preferredColorScheme(.dark)` app-wide (MainAppView) over
/// the fixed HobbyIQTokens palette, so these read identically whatever the
/// device's system appearance is — there is no second palette to drift.
private func rungColor(_ kind: RungKind) -> Color {
    switch kind {
    case .observed: return HobbyIQTheme.Colors.successGreen
    case .estimate: return HobbyIQTheme.Colors.electricBlue
    case .unpriced: return HobbyIQTheme.Colors.mutedText
    case .unknown:  return HobbyIQTheme.Colors.warning
    }
}

/// SF Symbol per rung kind — the mark web draws with ●/◐/○/?.
private func rungSymbol(_ kind: RungKind) -> String {
    switch kind {
    case .observed: return "circle.fill"
    case .estimate: return "circle.lefthalf.filled"
    case .unpriced: return "circle"
    case .unknown:  return "questionmark.circle"
    }
}

/// The provenance chip pair: the rung, and (when the pool is cold) the
/// speculation caveat beside it.
struct ProvenanceChipView: View {
    let rung: RungDescription
    /// `pricingSource` / route name — carried in the accessibility label
    /// so nothing the wire said is lost, never shown inline.
    var source: String?
    /// Age of the newest direct comp behind THIS number. Must come from
    /// the same path that supplied the value — see the call sites: a
    /// grade-curve tile prices one tier off its own pool and reports no
    /// age, so it passes nil rather than borrowing price-by-id's.
    var daysSinceNewestComp: Int?

    private var staleness: StalenessNote? {
        describeStaleness(daysSinceNewestComp: daysSinceNewestComp)
    }

    /// An estimate's words already begin with "estimate"; the others get
    /// the head word so "observed" and "unknown" are said, not implied by
    /// colour alone.
    private var words: String {
        if let head = rung.headWord { return "\(head) · \(rung.text)" }
        return rung.text
    }

    var body: some View {
        // Wraps rather than truncating — the staleness line is a full
        // sentence fragment and clipping it would drop the half that
        // carries the meaning.
        VStack(alignment: .leading, spacing: 4) {
            chip(
                symbol: rungSymbol(rung.kind),
                text: words,
                color: rungColor(rung.kind)
            )
            .accessibilityLabel(accessibilityText)

            if let stale = staleness {
                chip(
                    symbol: "clock.badge.exclamationmark",
                    text: stale.short,
                    color: HobbyIQTheme.Colors.warning
                )
                .accessibilityLabel(stale.long)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func chip(symbol: String, text: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(color)
                .accessibilityHidden(true)
            Text(text)
                .font(.caption2.weight(.medium))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(color.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(color.opacity(0.28), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }

    /// Everything the wire said, for VoiceOver: the words, the raw label,
    /// the pipeline that wrote the number, and the comp age when stale.
    private var accessibilityText: String {
        var parts: [String] = [words, "rung: \(rung.label ?? "none")"]
        if let source, source.isEmpty == false { parts.append("source: \(source)") }
        if let stale = staleness { parts.append("newest comp \(stale.daysSinceNewestComp) days old") }
        return parts.joined(separator: ". ")
    }
}

// MARK: - Convenience

extension ProvenanceChipView {
    /// Build straight off a wire label — the common call shape.
    init(label: String?, compsUsed: Int? = nil, source: String? = nil, daysSinceNewestComp: Int? = nil) {
        self.init(
            rung: describeRung(label, compsUsed: compsUsed),
            source: source,
            daysSinceNewestComp: daysSinceNewestComp
        )
    }
}

#Preview("Rungs") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ProvenanceChipView(label: "exact-pool-projection", compsUsed: 5, source: "price-by-id")
                ProvenanceChipView(label: "exact-pool-projection", compsUsed: 5, source: "price-by-id", daysSinceNewestComp: 63)
                ProvenanceChipView(label: "player-index-projection", source: "price-by-id", daysSinceNewestComp: 70)
                ProvenanceChipView(label: "sibling-estimate", source: "unified")
                ProvenanceChipView(label: "no-basis")
                ProvenanceChipView(label: "a-rung-nobody-shipped")
                ProvenanceChipView(label: nil)
            }
            .padding()
        }
    }
    .preferredColorScheme(.dark)
}
