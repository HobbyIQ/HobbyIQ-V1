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

// MARK: - Pricing labels

//  CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
//
//  The caveats a price must be read with, rendered beside it. Drew's
//  standing ruling (2026-09-01): a self-comp PUBLISHES **and is LABELED** —
//  the number still shows, and the label says what is behind it.
//
//  The sentences are NOT written here. They arrive on the wire, composed by
//  the backend's `labelsForResult` (ebaySellDraft.service.ts) and stamped
//  onto the holding by the writer that decided the price, so this chip, the
//  web row, the card page and the sell draft all say the same thing in the
//  same words. This view chooses a colour and a symbol; it never edits the
//  text and never invents a label the wire did not send.
//
//  Kept separate from the rung chip on purpose, for the same reason the
//  staleness chip is separate: the rung says WHICH POOL the number came
//  from, these say WHAT IS WRONG WITH THAT POOL. Different facts, and
//  neither replaces the other.

/// Severity, not category. `speculative` and `self-anchored` are the two
/// that say the number may not reflect a real market at all, so they take
/// the warning colour; the other two mean the number is real, just further
/// from the exact card.
private func pricingLabelColor(_ code: String) -> Color {
    switch code {
    case "speculative", "self-anchored": return HobbyIQTheme.Colors.warning
    case "fallback-rung":                return HobbyIQTheme.Colors.electricBlue
    default:                             return HobbyIQTheme.Colors.mutedText
    }
}

private func pricingLabelSymbol(_ code: String) -> String {
    switch code {
    case "speculative":   return "dice"
    case "self-anchored": return "person.crop.circle.badge.exclamationmark"
    case "fallback-rung": return "circle.lefthalf.filled"
    default:              return "exclamationmark.circle"
    }
}

/// The two or three words shown inline. The full sentence — the wire's own
/// `text` — is the accessibility label, so nothing the backend said is lost
/// to the abbreviation.
private func pricingLabelWords(_ code: String, selfAnchored: SelfAnchoredRatio?) -> String {
    switch code {
    case "speculative":   return "speculative"
    case "fallback-rung": return "estimated"
    case "low-confidence": return "low confidence"
    case "self-anchored":
        if let r = selfAnchored, r.own < r.total {
            return "self-anchored \(r.own) of \(r.total)"
        }
        return "self-anchored"
    default:
        return code
    }
}

/// One caveat chip.
struct PricingLabelChipView: View {
    let label: PricingLabel
    /// Refines only the self-anchored chip's inline words — a fully
    /// self-anchored price says so, a partial one shows its ratio. The
    /// sentence behind it is the wire's either way.
    var selfAnchored: SelfAnchoredRatio?

    var body: some View {
        let color = pricingLabelColor(label.code)
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: pricingLabelSymbol(label.code))
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(color)
                .accessibilityHidden(true)
            Text(pricingLabelWords(label.code, selfAnchored: selfAnchored))
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
        // The backend's sentence, verbatim — the same copy the sell draft
        // puts in front of a buyer.
        .accessibilityLabel(label.text)
    }
}

/// Every caveat on a price, in the order the engine emitted them —
/// strongest claim about the number's softness first. The order is the
/// backend's; re-sorting here would put a different emphasis on the same
/// facts than the sell draft does. Renders nothing when there are none.
struct PricingLabelChipsView: View {
    let labels: [PricingLabel]
    var selfAnchored: SelfAnchoredRatio?
    /// When true the full sentence renders under the chips. The detail
    /// surface has the room; a dense list row does not.
    var showSentences: Bool = false

    var body: some View {
        if labels.isEmpty == false {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(labels, id: \.code) { label in
                    PricingLabelChipView(label: label, selfAnchored: selfAnchored)
                }
                if showSentences {
                    ForEach(labels, id: \.code) { label in
                        Text(label.text)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}
