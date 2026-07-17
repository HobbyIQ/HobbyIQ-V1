//
//  PortfolioInventoryCells.swift
//  HobbyIQ
//
//  Extracted from PortfolioIQModels.swift (2026-07-17 tech-debt split).
//  Inventory-tab list row (`PortfolioCardRow`), grid tile
//  (`PortfolioCardGridCard`), and their shared PlayerTrendArrow +
//  thumbnail helpers.
//

import Foundation
import SwiftUI

// MARK: - Shared Inventory Card Components

struct PortfolioCardRow: View {
    let card: InventoryCard
    /// Fully-resolved market value for THIS holding (already scaled by
    /// quantity). Callers compute it via
    /// `PortfolioIQViewModel.resolvedMarketValue(for:)` so the row,
    /// grid, detail hero, header total, and sort all read the same
    /// number. When nil (e.g. previews), the row falls back to the
    /// legacy per-field chain inside `inventoryRightColumn`.
    var resolvedValue: Double? = nil
    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): most recent
    /// flip within the last 14 days for this holding's player. Renders
    /// as a 6pt colored dot in the leading padding. Nil when no fresh
    /// flip exists; the row looks identical to before.
    var latestFlip: VerdictFlip? = nil
    /// Corpus signals (2026-07-17): matched-cohort player-level momentum
    /// for this row. Renders as an ▲/▼/► glyph + `+X%` string next to
    /// the player name. Flag-aware treatment (sparse = gray, dominant
    /// or dispersion = subline) applied via `PlayerTrendArrow`.
    var playerTrend: PlayerTrendResponse? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                inventoryRowThumbnail(
                    urlString: card.preferredThumbnailURL,
                    playerName: card.playerName
                )

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(card.playerName)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        // Corpus signals (2026-07-17): matched-cohort
                        // momentum arrow. Self-suppresses when the trend
                        // is unloaded / flat / directionless.
                        if let trend = playerTrend {
                            PlayerTrendArrow(trend: trend, style: .compact)
                        }
                    }

                    // 2026-07-17: consolidated metadata line —
                    // "2026 Bowman · Orange Shimmer Refractor · Raw".
                    // Set string strips trailing " Baseball" / etc. and
                    // gets titlecased on wire read; grade tier condensed
                    // to short form ("Raw" / "PSA 10").
                    if let meta = inventoryMetadataLine(for: card) {
                        Text(meta)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    // Grader status kept as its own line — surfaces "At PSA"
                    // vs "Available", which is different signal from the
                    // metadata identity above.
                    if card.graderStatus != .available {
                        HStack(spacing: 4) {
                            Text("Status:")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Text(card.graderStatus.displayLabel)
                                .font(.caption.weight(.bold))
                                .foregroundStyle(card.graderStatus.tintColor)
                        }
                    }

                    // 2026-07-17: dropped the standalone grade pill (grade
                    // is already in the metadata line) and the "via eBay"
                    // chip (it appeared on all rows, so no signal).
                    // Black Label / Needs Review / Listed chips stay —
                    // those ARE conditional signal.
                    HStack(spacing: 6) {
                        if card.isBlackLabel == true {
                            inventoryBlackLabelChip()
                        }
                        if card.showsNeedsReviewPill {
                            inventoryReviewPill()
                        }
                        if card.isListedOnEbay {
                            inventoryListedChip(price: card.listingPrice)
                        }
                    }

                    if let rec = card.actionRecommendation,
                       rec.verdict != .insufficientData {
                        inventoryActionBadge(rec: rec)
                    }
                }

                Spacer(minLength: 8)

                inventoryRightColumn(card: card, resolvedValue: resolvedValue)
            }

            // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): LiveMarket headline
            // + model line + lean badge. Self-suppresses when all three
            // blocks are absent (legacy holdings, or non-LiveMarket cards).
            LiveMarketModelSignalView(
                lastSalePrice: card.lastSaleSurface?.price,
                lastSaleCompCount: card.lastSaleSurface?.compCount,
                modelExpectation: card.modelExpectation,
                modelSignal: card.modelSignal
            )
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        // P0.7 (2026-07-16, verdict-history-flip-surfaces.md): 6pt
        // freshness dot in the row's leading gutter. Color reflects the
        // NEW verdict (post-flip); opacity fades over 14 days; hidden past
        // day 14. Sits in the padding, not over card art.
        .overlay(alignment: .leading) {
            if let flip = latestFlip, let opacity = flip.dotOpacity {
                Circle()
                    .fill(verdictFlipDotColor(for: flip.to))
                    .frame(width: 6, height: 6)
                    .opacity(opacity)
                    .padding(.leading, 3)
                    .accessibilityLabel("Recent \(flip.to ?? "verdict") flip")
            }
        }
    }
}

/// P0.7 (2026-07-16): dot color mapping per verdict-history-flip-surfaces.md.
/// Green for bull-side, red for bear-side, gray for neutral / unknown.
/// Kept separate from `VerdictStyle.color` because that helper's palette
/// uses opacity-modulated hues (bull vs strong_bull tinting) that read
/// poorly at 6pt.
private func verdictFlipDotColor(for verdict: String?) -> Color {
    switch verdict?.lowercased() {
    case "bull", "strong_bull", "supply_tight":
        return .green
    case "bear", "soft", "weak", "oversupply":
        return .red
    default:
        return .gray
    }
}

/// Corpus signals (2026-07-17): matched-cohort player-level momentum
/// glyph + optional % text. Renders as ▲ (green) / ▼ (red) / omitted
/// (flat) per the corpus-signals prompt. Compact style is for inline use
/// next to the player name on inventory rows; detail style adds a
/// larger typographic treatment for the card-detail Player Momentum block.
///
/// Flags-aware treatment:
///   - "sparse" → glyph dimmed to 40% opacity with a system-image
///     info tooltip surface (accessibility hint).
///   - Any other flag → normal glyph (subline copy handled by caller).
///
/// The whole view self-suppresses when direction is `"flat"` / nil /
/// unknown — the row reads cleaner with no signal than with a "─".
struct PlayerTrendArrow: View {
    let trend: PlayerTrendResponse
    let style: Style

    enum Style {
        /// Inline chip: 10pt glyph + 11pt caption text next to player name.
        case compact
        /// Full-size: 22pt glyph + 15pt semibold caption for card detail.
        case detail
    }

    var body: some View {
        let direction = trend.direction?.lowercased() ?? ""
        let color: Color = {
            switch direction {
            case "up": return HobbyIQTheme.Colors.successGreen
            case "down": return HobbyIQTheme.Colors.danger
            default: return HobbyIQTheme.Colors.mutedText
            }
        }()
        let glyph: String? = {
            switch direction {
            case "up": return "\u{25B2}"
            case "down": return "\u{25BC}"
            default: return nil
            }
        }()

        if let glyph, let pct = trend.momentumPercentString {
            let sparse = trend.hasFlag("sparse")
            HStack(spacing: 3) {
                Text(glyph)
                    .font(style == .detail ? .system(size: 22, weight: .bold) : .caption.weight(.bold))
                    .foregroundStyle(color)
                Text(pct)
                    .font(style == .detail ? .system(size: 15, weight: .semibold) : .caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            .opacity(sparse ? 0.4 : 1.0)
            .accessibilityLabel(sparse ? "\(pct) player momentum, limited data" : "\(pct) player momentum")
        }
    }
}

struct PortfolioCardGridCard: View {
    let card: InventoryCard
    /// Same canonical `resolvedMarketValue(for:)` output the list row
    /// takes; keeps grid and row in sync.
    var resolvedValue: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            inventoryGridThumbnail(
                urlString: card.preferredThumbnailURL,
                playerName: card.playerName
            )

            VStack(alignment: .leading, spacing: 4) {
                Text(card.playerName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .lineLimit(1)

                // 2026-07-17: single consolidated metadata line (same as
                // the row layout). Grade tier is baked in — no separate pill.
                if let meta = inventoryMetadataLine(for: card) {
                    Text(meta)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .lineLimit(1)
                }

                if card.graderStatus != .available {
                    HStack(spacing: 3) {
                        Text("Status:")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(card.graderStatus.displayLabel)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(card.graderStatus.tintColor)
                            .lineLimit(1)
                    }
                }

                // 2026-07-17: dropped the grade pill (in metadata line)
                // and the via-eBay chip (universal → no signal).
                HStack(spacing: 4) {
                    if card.showsNeedsReviewPill {
                        inventoryReviewPill()
                    }
                    if card.isListedOnEbay {
                        inventoryListedChip(price: card.listingPrice)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)

            Spacer(minLength: 6)

            let value: Double = {
                if let resolvedValue, resolvedValue > 0 { return resolvedValue }
                let qty = max(1.0, card.quantity ?? 1.0)
                if let v = card.fairMarketValue, v > 0 { return v * qty }
                if card.currentValue > 0 { return card.currentValue }
                if let v = card.estimatedValue, v > 0 { return v * qty }
                if let best = card.bestKnownMarketValue { return best.perUnit * qty }
                return 0
            }()

            // 2026-07-17: dropped MARKET VALUE caption from grid tile.
            Text(value > 0 ? inventoryWholeDollarString(value) : "—")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(value > 0 ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.mutedText)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
    }
}

// MARK: - Inventory row helpers (private to the inventory rows above)

/// Composes the muted secondary line: "Year · Set". Falls back to the legacy
/// cardName when neither structured field is present so we never render a
/// blank line in legacy data.
// MARK: - CF-IOS-MODEL-SIGNAL-RENDER list-cell preview (2026-06-26)

#Preview("PortfolioCardRow · Hartman sell (model-signal on list)") {
    let card = InventoryCard(
        playerName: "Eric Hartman",
        cardName: "Green Shimmer Refractor /99 Auto",
        cost: 0,
        currentValue: 450,
        status: "active",
        year: "2026",
        setName: "Bowman",
        parallel: "Green Shimmer Refractor",
        grade: "",
        isAuto: true,
        lastSaleSurface: LiveMarketLastSaleSurface(price: 450, date: "2026-06-20T12:00:00Z", compCount: 1),
        modelExpectation: LiveMarketModelExpectation(
            value: 262, range: [250, 273], multiplier: 3.20, multiplierRange: [3.05, 3.33],
            basis: "prices_by_card_honest", n: 11, baseAutoMedian: 82, baseAutoCount: 69
        ),
        modelSignal: LiveMarketModelSignal(
            lean: "sell", deltaPct: 72, expectation: 262, effectiveMultiplier: 3.20
        )
    )
    return VStack(spacing: 12) {
        Text("List row — Hartman Green Shimmer /99 Auto (sell signal)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        PortfolioCardRow(card: card)
            .background(HobbyIQTheme.Colors.cardNavy)
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
    .padding()
    .background(HobbyIQTheme.Colors.appBackground)
    .preferredColorScheme(.dark)
}

/// 2026-07-17: single-line row metadata — "2026 Bowman · Orange Shimmer
/// Refractor · Raw". Strips trailing " Baseball" / etc. off the set,
/// titlecases when it's all-lowercase (backend feed hygiene follow-up),
/// and dedupes when the set already leads with the year.
private func inventoryMetadataLine(for card: InventoryCard) -> String? {
    var parts: [String] = []
    let year = card.year.trimmingCharacters(in: .whitespacesAndNewlines)
    var setName = PortfolioHoldingHeroCard.stripLeadingYear(
        from: card.setName.trimmingCharacters(in: .whitespacesAndNewlines),
        year: year
    )
    // Strip trailing category from set name — reads cleaner.
    for suffix in [" Baseball", " Basketball", " Football", " Pokemon", " Hockey", " Soccer"] {
        if setName.lowercased().hasSuffix(suffix.lowercased()) {
            setName = String(setName.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
            break
        }
    }
    // Titlecase when the whole string is lowercase — backend feed
    // sometimes ships lowercased set strings and it looks like a bug.
    // TODO(2026-07-17): backend follow-up to canonicalize on the wire.
    if setName.isEmpty == false, setName == setName.lowercased() {
        setName = setName.capitalized(with: .current)
    }

    if year.isEmpty == false, setName.isEmpty == false {
        parts.append("\(year) \(setName)")
    } else if year.isEmpty == false {
        parts.append(year)
    } else if setName.isEmpty == false {
        parts.append(setName)
    }

    var parallel = card.parallel.trimmingCharacters(in: .whitespacesAndNewlines)
    if parallel.lowercased() == "base" { parallel = "" }
    if card.isAuto, parallel.isEmpty == false {
        parts.append("\(parallel) Auto")
    } else if card.isAuto {
        parts.append("Auto")
    } else if parallel.isEmpty == false {
        parts.append(parallel)
    }

    // Grade tier — "Raw" for ungraded, condensed grade string otherwise.
    let gradeShort: String = {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           company.isEmpty == false,
           let value = card.gradeValue {
            let v = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(company) \(v)"
        }
        let raw = card.grade.trimmingCharacters(in: .whitespaces)
        return raw.isEmpty ? "Raw" : raw
    }()
    parts.append(gradeShort)

    let line = parts.joined(separator: " · ")
    return line.isEmpty ? nil : line
}

// 2026-07-17: inventoryCardSubtitle + inventoryCardSecondaryDetailLine
// helpers deleted — replaced by inventoryMetadataLine(for:), which
// produces a single consolidated identity line for both the list row
// and grid tile.

/// Single grade pill — sentence-case label, soft surface, neutral by default.
@ViewBuilder
private func inventoryGradePill(text: String) -> some View {
    Text(text)
        .font(.caption2.weight(.medium))
        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
        .clipShape(Capsule(style: .continuous))
}

/// P0.3 (2026-07-16): BGS 10 Black Label / Pristine chip. Rendered
/// next to the grade pill when the holding's `isBlackLabel == true`.
/// Distinct high-contrast black + gold treatment so the ~9× premium
/// tier reads at a glance without competing with the grade pill.
@ViewBuilder
private func inventoryBlackLabelChip() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "star.fill")
            .font(.system(size: 9, weight: .bold))
        Text("Black Label")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(Color(hex: 0xE5B64A))
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(Color.black.opacity(0.55))
    .overlay(
        Capsule(style: .continuous)
            .stroke(Color(hex: 0xE5B64A).opacity(0.55), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): compact "via eBay" chip
/// on rows where the holding was Browse-enriched. Signals structured
/// data provenance so users don't second-guess the auto-created row.
@ViewBuilder
private func inventoryEbayChip() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 9, weight: .bold))
        Text("via eBay")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.electricBlue.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-EBAY-RELIST (backend PR #388): "Listed on eBay — $X" chip on
/// rows whose holding was published. Rendered next to the grade pill
/// so users can eyeball which holdings are live sale-side.
@ViewBuilder
private func inventoryListedChip(price: Double?) -> some View {
    HStack(spacing: 4) {
        Image(systemName: "tag.fill")
            .font(.system(size: 9, weight: .bold))
        Text(priceLabel(price))
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.successGreen.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.successGreen.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

private func priceLabel(_ price: Double?) -> String {
    if let p = price, p > 0 { return "Listed \(p.portfolioCurrencyText)" }
    return "Listed on eBay"
}

/// CF-EBAY-BROWSE-ENRICHMENT (backend PR #383): "Needs review" nudge on
/// title-parsed rows (parseConfidence 0.70–0.94) so the user knows to
/// confirm player/set/grade before trusting the row. Suppressed when
/// `enrichedFromEbay == true` — those are already confirmed.
@ViewBuilder
private func inventoryReviewPill() -> some View {
    HStack(spacing: 4) {
        Image(systemName: "exclamationmark.circle.fill")
            .font(.system(size: 9, weight: .bold))
        Text("Needs review")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.4)
    }
    .foregroundStyle(HobbyIQTheme.Colors.warning)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(HobbyIQTheme.Colors.warning.opacity(0.14))
    .overlay(
        Capsule(style: .continuous)
            .stroke(HobbyIQTheme.Colors.warning.opacity(0.35), lineWidth: 1)
    )
    .clipShape(Capsule(style: .continuous))
}

/// CF-ACTION-BADGES (2026-07-06, backend §1): per-holding verdict badge
/// rendered under the grade pill in the inventory row. Uses the shared
/// `ActionBadgeStyle` so the color / icon / fill treatment matches the
/// comp-card action block and the portfolio movers badge.
@ViewBuilder
func inventoryActionBadge(rec: CardPanelGradeEntry.ActionRecommendation) -> some View {
    let style = ActionBadgeStyle(verdict: rec.verdict, urgency: rec.urgency)
    HStack(spacing: 4) {
        Image(systemName: style.icon)
            .font(.system(size: 9, weight: .bold))
        Text(style.label)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(0.5)
        if rec.verdict == .list, let t = rec.targetPrice, t > 0 {
            Text("· \(t.currencyStringNoCents)")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
        }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .foregroundStyle(style.foreground)
    .background(style.background)
    .overlay(
        Capsule(style: .continuous)
            .stroke(style.tint, lineWidth: style.strokeWidth)
    )
    .clipShape(Capsule(style: .continuous))
}

/// Row right column — the canonical resolved market value for the
/// holding under a "MARKET VALUE" caption. Legacy per-field fallbacks
/// (fmv → estimated → best-known) are handled inside
/// `resolvedValue`'s producer on the ViewModel, so the row itself is
/// a single-value display and never disagrees with header/sort/detail.
@ViewBuilder
private func inventoryRightColumn(card: InventoryCard, resolvedValue: Double? = nil) -> some View {
    let value: Double = {
        if let resolvedValue, resolvedValue > 0 { return resolvedValue }
        let qty = max(1.0, card.quantity ?? 1.0)
        if let v = card.fairMarketValue, v > 0 { return v * qty }
        if card.currentValue > 0 { return card.currentValue }
        if let v = card.estimatedValue, v > 0 { return v * qty }
        if let best = card.bestKnownMarketValue { return best.perUnit * qty }
        return 0
    }()

    // 2026-07-17: dropped the "MARKET VALUE" caption per row — the
    // column position + weight make it read as the price. Bumped the
    // number to .headline.bold so it carries the visual weight the
    // label used to add.
    VStack(alignment: .trailing, spacing: 3) {
        if value > 0 {
            Text(inventoryWholeDollarString(value))
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .monospacedDigit()
        } else {
            Text("—")
                .font(.headline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .monospacedDigit()
        }

        // P0.6 (2026-07-16) per nearest-graded-anchor-rendering.md:
        // when the backend rescued the estimate via the grade-ladder
        // fallback, surface a compact "based on PSA 9 · $1,325 · 8 mo
        // ago" caption tinted by the anchor's confidence band. Wire
        // field is omitted for healthy-priced holdings so the caption
        // self-suppresses on the common path.
        if let anchor = card.nearestGradedAnchor {
            Text("based on \(anchor.grade) · \(portfolioCurrencyString(anchor.price)) · \(anchor.shortAge)")
                .font(.caption2)
                .foregroundStyle(anchor.tintColor)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }
}

/// CF-MARKET-VALUE-EVERYWHERE (2026-07-12): human-readable subtitle for
/// the fallback value source shown when observed FMV / live cache /
/// estimated are all absent. Keeps the row honest about how the
/// number was derived.
private func bestKnownSourceLabel(_ source: InventoryCard.MarketValueSource) -> String {
    switch source {
    case .fmv: return "Market"
    case .current: return "Estimated"
    case .estimated: return "Estimated"
    case .midpoint: return "Range midpoint"
    case .atCost: return "At cost"
    }
}

/// Whole-dollar currency for inventory rows + header ("$5,903" — no cents).
/// Uses NumberFormatter so locale grouping survives. Internal so the
/// InventoryIQView header reads its total value through the same helper.
func inventoryWholeDollarString(_ value: Double) -> String {
    inventoryWholeDollarFormatter.string(from: NSNumber(value: value)) ?? "$0"
}

private let inventoryWholeDollarFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    formatter.maximumFractionDigits = 0
    formatter.minimumFractionDigits = 0
    return formatter
}()

/// Row thumbnail: 42pt-wide rounded tile. Shows the player's initials on
/// a slate-gray tile when there is no image OR the AsyncImage fails —
/// never the legacy "broken photo" SF Symbol.
///
/// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit + maxWidth-only so
/// the LiveMarket CDN's 754×1028 (aspect 0.733) renders at its natural
/// aspect. The old 42×56 fixed frame forced 0.75, stretching cards.
func inventoryRowThumbnail(urlString: String?, playerName: String) -> some View {
    // CF-INVENTORY-THUMB-COMP-CARD-PARITY (2026-07-05): mirrors the
    // comp-card hero exactly —
    //   `image.resizable().scaledToFit().scaleEffect(0.85)`
    // for the 15% inner breathing margin, `.frame(width:height:)` at
    // the outer Group for row-height stability, and a single
    // `.clipShape` applied to the container so every branch (image,
    // AsyncImage placeholder, initials tile) picks up the same
    // rounded-rect crop.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 14)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 14)
        }
    }
    .frame(width: 42, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
}

/// Grid thumbnail: full-width × 90pt tile with the same initials fallback.
/// CF-CARD-IMAGE-NO-DISTORT (2026-07-03): scaledToFit inside the tile so
/// non-standard aspects letterbox instead of stretching. Container size
/// preserved for LazyVGrid uniformity.
private func inventoryGridThumbnail(urlString: String?, playerName: String) -> some View {
    // CF-INVENTORY-THUMB-COMP-CARD-PARITY (2026-07-05): mirrors the
    // comp-card hero — `.scaledToFit().scaleEffect(0.85)` inside the
    // 90pt-tall tile so non-standard aspects letterbox with the same
    // 15% breathing margin the hero uses. `.clipShape` at the
    // container level matches the hero's rounded-rect crop.
    Group {
        if let urlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                @unknown default:
                    inventoryInitialsTile(playerName: playerName, fontSize: 22)
                }
            }
        } else {
            inventoryInitialsTile(playerName: playerName, fontSize: 22)
        }
    }
    .frame(maxWidth: .infinity)
    .frame(height: 90)
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
}

/// CF-PLACEHOLDER-CARD (2026-07-04): generic card-shape placeholder for
/// inventory rows without an uploaded photo. Renders a subtle rounded
/// rectangle with a photo glyph, matching how the CDN-thumbnail placeholder
/// looks — no more colored initials tiles.
private func inventoryInitialsTile(playerName: String, fontSize: CGFloat) -> some View {
    // 2026-07-17: monogram fallback — never render a blank / photo-glyph
    // placeholder. Player initials on an electric-blue-tinted card shape
    // read as "we know who this is, we just don't have art yet" instead
    // of "this looks broken".
    let initials = inventoryInitials(from: playerName)
    return ZStack {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        HobbyIQTheme.Colors.electricBlue.opacity(0.28),
                        HobbyIQTheme.Colors.electricBlue.opacity(0.12)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.45), lineWidth: 1)
        Text(initials)
            .font(.system(size: fontSize, weight: .bold, design: .rounded))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

/// Up to two initials from the first two whitespace-separated words.
/// Empty input falls back to "?" so the tile is never blank.
private func inventoryInitials(from name: String) -> String {
    let words = name
        .split(whereSeparator: { $0.isWhitespace })
        .prefix(2)
    let letters = words.compactMap { $0.first }
    if letters.isEmpty { return "?" }
    return letters.map { String($0).uppercased() }.joined()
}
