//
//  HoldingRowView.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 3 (Drew, 2026-08-04).
//
//  Clean list row for portfolio holdings. Shows card art, identity,
//  grade chip, and the canonical market value from unified pricing.
//  Tilde-prefixed value for estimated rows so cost-proxy holdings
//  never claim to have real market backing.
//
//  Cross-platform reference: web portfolio row layout at
//    apps/web/src/app/app/portfolio/page.tsx (holding grid tile)
//  Same content, iOS-optimized touch targets (44pt minimum).
//
//  Blueprint: backend/docs/ios-unified-rebuild-blueprint.md
//

import SwiftUI

/// Minimal holding shape the row needs. Parameterizes on the fields
/// so it's not coupled to a specific model — every existing holding
/// type in the app (InventoryCard, PortfolioCardDetail, etc.) can
/// project onto this at the call site with a small init.
struct HoldingRowModel: Identifiable, Hashable {
    let id: String
    let title: String
    let subtitle: String?
    let gradeLabel: String
    let imageURL: URL?
    let marketValue: Double?
    let estimatedValue: Double?
    let costBasis: Double?
    let quantity: Double
    let isEstimated: Bool

    /// CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04): the holding's identity is a
    /// checklist-backed catalog card. Defaulted so every existing call site
    /// that projects onto this model keeps compiling and simply renders no
    /// mark until it passes the flag through.
    ///
    /// Tri-state, like `InventoryCard.identityVerified`: only an explicit
    /// `true` earns the check. `nil` means the wire did not say.
    var identityVerified: Bool? = nil

    /// TOTAL value for this row, following the unified fallback:
    ///   fairMarketValue × qty → estimatedValue × qty → nil
    var displayTotal: Double? {
        let qty = max(1.0, quantity)
        if let mv = marketValue, mv > 0 { return mv * qty }
        if let ev = estimatedValue, ev > 0 { return ev * qty }
        return nil
    }

    var profitLoss: Double? {
        guard let value = displayTotal, let cost = costBasis, cost > 0 else { return nil }
        return value - cost
    }
}

struct HoldingRowView: View {
    let model: HoldingRowModel
    let onTap: (() -> Void)?

    init(model: HoldingRowModel, onTap: (() -> Void)? = nil) {
        self.model = model
        self.onTap = onTap
    }

    var body: some View {
        Button(action: { onTap?() }) {
            HStack(alignment: .center, spacing: HobbyIQTheme.Spacing.medium) {
                cardImage
                identityStack
                Spacer(minLength: 0)
                pricingStack
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Card image

    private var cardImage: some View {
        Group {
            if let url = model.imageURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        placeholderImage
                    }
                }
            } else {
                placeholderImage
            }
        }
        .frame(width: 48, height: 64)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous)
                .stroke(HobbyIQTheme.Colors.border.opacity(0.6), lineWidth: 0.5)
        )
    }

    private var placeholderImage: some View {
        ZStack {
            HobbyIQTheme.Colors.slateGray
            Image(systemName: "rectangle.stack")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    // MARK: Identity stack

    private var identityStack: some View {
        VStack(alignment: .leading, spacing: 4) {
            // CF-VERIFIED-IS-A-CHECK (Drew, 2026-09-04): "Rather than say
            // Verified — let's just do a green check for it next to the card
            // details." The mark rides the TITLE, because verified is a claim
            // about the CARD, not about the price.
            //
            // The check is appended to the title's own Text via interpolation
            // rather than placed in an HStack beside it, so it flows with the
            // last word and wraps with it. An HStack sibling would hold a
            // column of its own and push the two-line title narrower on every
            // row, verified or not.
            //
            // NOTE ON SCOPE: this view is currently reached only by the
            // storefront picker (APIService.swift `StorefrontHolding.rowModel`),
            // which does not carry the flag — so `identityVerified` arrives nil
            // there and no mark renders. The marker is wired here so the two
            // row implementations agree the day the storefront wire carries it;
            // the surface Drew sees is `PortfolioCardRow`.
            titleWithOptionalCheck
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                // VoiceOver reads the glyph as an unnamed image otherwise. The
                // label names the whole line so the check is announced as part
                // of the card it qualifies, not as a stray icon after it.
                .accessibilityLabel(
                    model.identityVerified == true
                        ? "\(model.title), verified identity"
                        : model.title
                )

            if let subtitle = model.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(HobbyIQTheme.Typography.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
            }

            gradeChip
        }
    }

    /// The title, with the green check appended ONLY when the identity is
    /// verified. Returns a `Text` (not `some View`) so the caller can apply
    /// the font and line limits to one composed string — an unverified row
    /// renders exactly the title it always did, with no spacer and no gap.
    ///
    /// `identityVerified` is tri-state; only an explicit `true` earns the
    /// mark. A `nil` from a legacy holding, or from a payload that predates
    /// the field, must never paint a checklist-backed claim.
    private var titleWithOptionalCheck: Text {
        let title = Text(model.title)
        guard model.identityVerified == true else { return title }
        return title
            + Text(verbatim: "  ")
            + Text(Image(systemName: "checkmark.circle.fill"))
                .foregroundColor(HobbyIQTheme.Colors.successGreen)
    }

    private var gradeChip: some View {
        Text(model.gradeLabel)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }

    // MARK: Pricing stack

    private var pricingStack: some View {
        VStack(alignment: .trailing, spacing: 4) {
            valueText
            if let pl = model.profitLoss {
                profitLossChip(pl)
            }
        }
    }

    @ViewBuilder
    private var valueText: some View {
        if let total = model.displayTotal {
            let prefix = model.isEstimated ? "~" : ""
            Text(prefix + wholeUSDString(total))
                .font(HobbyIQTheme.Typography.statSubtle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
                .monospacedDigit()
        } else {
            Text("—")
                .font(HobbyIQTheme.Typography.statSubtle)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func profitLossChip(_ pl: Double) -> some View {
        let color: Color = pl > 0
            ? HobbyIQTheme.Colors.hobbyGreen
            : pl < 0
                ? HobbyIQTheme.Colors.danger
                : HobbyIQTheme.Colors.mutedText
        let sign = pl > 0 ? "+" : (pl < 0 ? "-" : "")
        return Text("\(sign)\(wholeUSDString(abs(pl)))")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
            .monospacedDigit()
    }
}

// MARK: - Preview

#Preview("Observed holding") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        VStack(spacing: 12) {
            HoldingRowView(model: HoldingRowModel(
                id: "1",
                title: "2018 Bowman Chrome Shohei Ohtani #1",
                subtitle: "Base auto",
                gradeLabel: "PSA 9",
                imageURL: nil,
                marketValue: 2596,
                estimatedValue: nil,
                costBasis: 2349.86,
                quantity: 1,
                isEstimated: false,
                // CF-VERIFIED-IS-A-CHECK: the verified row — a green check on
                // the title, no word, no chip.
                identityVerified: true
            ))

            HoldingRowView(model: HoldingRowModel(
                id: "2",
                title: "2026 Bowman Chrome Black & White Red Ink Victor Figueroa #CPA-VF",
                subtitle: "Red Ink SSP auto",
                gradeLabel: "Raw",
                imageURL: nil,
                marketValue: 278.60,
                estimatedValue: nil,
                costBasis: 278.60,
                quantity: 1,
                isEstimated: false
            ))

            HoldingRowView(model: HoldingRowModel(
                id: "3",
                title: "2020 Bowman Chrome Bobby Witt Jr. #CPA-BWJ",
                subtitle: "Base auto",
                gradeLabel: "BGS 9.5",
                imageURL: nil,
                marketValue: nil,
                estimatedValue: 1415,
                costBasis: 1260,
                quantity: 1,
                isEstimated: true
            ))
        }
        .padding()
    }
}
