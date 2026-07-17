//
//  PortfolioHoldingHeroCard.swift
//  HobbyIQ
//
//  Extracted from PortfolioIQModels.swift (2026-07-17 tech-debt split).
//  Hero-card view rendered at the top of the holding detail sheet:
//  player name, identity line, card image, gradient market-value
//  sparkline, MARKET VALUE headline, and PP/PL chips.
//

import Foundation
import SwiftUI
import Charts

/// CF-HOLDING-HERO-REDESIGN (2026-07-06): mirror the CompIQ comp-card
/// hero on the holding detail view. Centered player name, flat single-
/// line identity, centered card hero image, big MARKET VALUE headline,
/// compact PP/PL chip row. Edit lives as a floating pill top-right
/// instead of taking a corner of the top row.
struct PortfolioHoldingHeroCard: View {
    let card: InventoryCard
    /// CF-INVENTORY-COMPCARD-MATCH (2026-07-08): optional override for
    /// the MARKET VALUE headline. Callers that have a live panel-entry
    /// value (same source the comp card uses) pass it here so the
    /// two surfaces render the same number. Nil = fall back to the
    /// holding's cached `fairMarketValue` chain.
    var livePanelValue: Double? = nil
    let onEdit: () -> Void

    /// 2026-07-17: 3-month weekly price-history for the sparkline under
    /// MARKET VALUE. Nil until the first fetch; empty on thin data.
    @State private var sparklinePoints: [PriceHistoryBucketPoint]?

    /// Flat identity line: "{year} {set-no-year-no-category} [variant] [Auto] {number}"
    /// (same rule the comp-card header uses). Strips a leading year
    /// from the set name when it duplicates `card.year` (backend often
    /// ships setName as "2006 Bowman Draft Picks & Prospects Baseball",
    /// which would otherwise render as "2006 2006 Bowman Draft…").
    /// Strips " Baseball" / " Basketball" / " Football" / " Pokemon"
    /// off the set, drops literal "Base" variant, appends " Auto" when
    /// the holding is auto.
    private var flatIdentityLine: String? {
        let year = card.year.trimmingCharacters(in: .whitespaces)
        var parts: [String] = []
        if year.isEmpty == false { parts.append(year) }
        let cleanedSet = Self.stripCategorySuffix(
            Self.stripLeadingYear(from: card.setName.trimmingCharacters(in: .whitespaces), year: year)
        )
        if cleanedSet.isEmpty == false { parts.append(cleanedSet) }
        let variant = card.parallel.trimmingCharacters(in: .whitespaces)
        if variant.isEmpty == false, variant.lowercased() != "base" {
            parts.append(variant)
        }
        if card.isAuto { parts.append("Auto") }
        let joined = parts.joined(separator: " ")
        return joined.isEmpty ? nil : joined
    }

    private static let categorySuffixes: [String] = [
        " Baseball", " Basketball", " Football", " Pokemon", " Hockey", " Soccer"
    ]

    private static func stripCategorySuffix(_ raw: String) -> String {
        for s in categorySuffixes where raw.lowercased().hasSuffix(s.lowercased()) {
            return String(raw.dropLast(s.count)).trimmingCharacters(in: .whitespaces)
        }
        return raw
    }

    /// Drop a leading 4-digit year token from `setName` when it matches
    /// `year` — prevents "2006 2006 Bowman…" duplication. Only strips
    /// when the token is followed by whitespace or the set is exactly
    /// the year itself.
    static func stripLeadingYear(from setName: String, year: String) -> String {
        guard year.isEmpty == false else { return setName }
        let trimmed = setName.trimmingCharacters(in: .whitespaces)
        if trimmed == year { return "" }
        let prefix = "\(year) "
        if trimmed.hasPrefix(prefix) {
            return String(trimmed.dropFirst(prefix.count))
        }
        return trimmed
    }

    /// Holding hero image — delegates to `card.preferredThumbnailURL`
    /// (PR #383 priority: `photos[0] → ebayImageUrl → imageFrontUrl →
    /// catalogImageUrl`). eBay-auto rows show the Browse photo; manual
    /// holdings still fall through to the user's uploaded photo since
    /// `photos[]` and `ebayImageUrl` are nil there.
    private var heroImageUrlString: String? {
        card.preferredThumbnailURL?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 14) {
                VStack(alignment: .center, spacing: 4) {
                    Text(card.playerName.isEmpty ? card.fullDisplayName : card.playerName)
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    if let details = flatIdentityLine {
                        Text(details)
                            .font(.system(size: 14))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 36) // clear the Edit pill overlay
                .frame(maxWidth: .infinity)

                heroImage
                    .frame(maxWidth: 193)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                // CF-HOLDING-GRADE-CHIP (2026-07-06, v2): static
                // grade chip locks the page to the holding's grade.
                // Raw shows "Raw"; graded shows "PSA 9" / "BGS 9.5"
                // / etc. Non-interactive — the whole detail view
                // (MARKET VALUE, PREDICTED, action badge, scenario)
                // is scoped to this one grade.
                gradeChip

                marketValueBlock
            }
            .padding(18)
            .frame(maxWidth: .infinity)
            .background(
                LinearGradient(
                    colors: [Color(hex: 0x141821), Color(hex: 0x1A1F2E)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.25), Color.white.opacity(0.06)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1.2
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))

            editPill
                .padding(.top, 10)
                .padding(.trailing, 10)
        }
    }

    /// Card hero — same treatment as the comp-card hero (scaledToFit +
    /// scaleEffect(0.85) inside a maxWidth-constrained frame). Falls
    /// through to a neutral card-shape placeholder when no URL is on
    /// hand.
    @ViewBuilder
    private var heroImage: some View {
        if let urlString = heroImageUrlString, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit().scaleEffect(0.85)
                case .empty, .failure:
                    heroImagePlaceholder
                @unknown default:
                    heroImagePlaceholder
                }
            }
        } else {
            heroImagePlaceholder
        }
    }

    private var heroImagePlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
            Image(systemName: "rectangle.portrait")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.5))
        }
        .aspectRatio(0.72, contentMode: .fit)
    }

    /// MARKET VALUE headline — canonical comp-card "Market value $X" +
    /// gradient text + electric-blue glow.
    /// CF-INVENTORY-COMPCARD-MATCH (2026-07-08): source order aligns
    /// with the comp card. First try the live panel entry for this
    /// holding's grade — `resolvedMarketValue` is the exact same
    /// fallback chain the comp card uses (`trendAdjustedValue →
    /// value → weightedMedianPrice → plainMedianPrice`), so the
    /// inventory detail and the comp card render the same number.
    /// Only if the panel hasn't loaded yet (or has no entry for this
    /// grade) do we degrade to the holding's cached
    /// `fairMarketValue` → `currentValue` → `estimatedValue`.
    private var marketValueBlock: some View {
        let value: Double? = {
            if let live = livePanelValue, live > 0 { return live }
            if let v = card.fairMarketValue, v > 0 { return v }
            if card.currentValue > 0 { return card.currentValue }
            if let v = card.estimatedValue, v > 0 { return v }
            return nil
        }()
        return VStack(spacing: 8) {
            Text("MARKET VALUE")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let value {
                Text(wholeUSDString(value))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 14, x: 0, y: 0)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                // 2026-07-17: 30-day sparkline directly under the price.
                // Fetches on task from /price-history (window=3m, bucket=weekly).
                // Hidden entirely when < 2 usable points arrive.
                heroSparkline
            } else {
                Text("Not enough data yet")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .task(id: card.cardId ?? "") { await loadHeroSparkline() }
    }

    /// Compact sparkline card with a signed delta chip + gradient-filled
    /// price line. 60pt total (chart 44pt + chip 12pt caption). Trend
    /// color follows the first-to-last delta: green when the 30-day
    /// median rose, brick when it dropped, muted when flat.
    @ViewBuilder
    private var heroSparkline: some View {
        let usable = (sparklinePoints ?? []).filter {
            $0.parsedDate != nil && ($0.medianPrice ?? 0) > 0
        }
        if usable.count >= 2,
           let firstMedian = usable.first?.medianPrice, firstMedian > 0,
           let lastMedian = usable.last?.medianPrice, lastMedian > 0 {
            let deltaPct = ((lastMedian / firstMedian) - 1.0) * 100.0
            let direction: SparklineDirection = {
                if deltaPct >= 2.0 { return .up }
                if deltaPct <= -2.0 { return .down }
                return .flat
            }()
            let tint = direction.tint
            let deltaLabel = direction == .flat
                ? "Flat 30d"
                : "\(direction.glyph) \(String(format: "%.1f", abs(deltaPct)))% 30d"

            VStack(spacing: 4) {
                Chart {
                    ForEach(usable) { point in
                        if let date = point.parsedDate,
                           let median = point.medianPrice {
                            // Gradient area fill under the line so the
                            // sparkline reads as a wedge, not a thin
                            // wire — fades to transparent at the axis.
                            AreaMark(
                                x: .value("Date", date),
                                y: .value("Price", median)
                            )
                            .interpolationMethod(.monotone)
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [tint.opacity(0.35), tint.opacity(0.02)],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                            )
                            LineMark(
                                x: .value("Date", date),
                                y: .value("Price", median)
                            )
                            .interpolationMethod(.monotone)
                            .foregroundStyle(tint)
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        }
                    }
                    // End-point emphasis dot so the latest value reads
                    // as the "current" anchor.
                    if let lastDate = usable.last?.parsedDate {
                        PointMark(
                            x: .value("Date", lastDate),
                            y: .value("Price", lastMedian)
                        )
                        .foregroundStyle(tint)
                        .symbolSize(60)
                    }
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartPlotStyle { plot in
                    plot.background(Color.clear).border(Color.clear, width: 0)
                }
                .frame(height: 44)

                // Signed delta chip — small caption underneath so the
                // sparkline reads as a scaled signal, not just decoration.
                HStack {
                    Spacer()
                    Text(deltaLabel)
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.4)
                        .foregroundStyle(tint)
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 4)
        }
    }

    private enum SparklineDirection {
        case up, down, flat
        var tint: Color {
            switch self {
            case .up: return HobbyIQTheme.Colors.successGreen
            case .down: return HobbyIQTheme.Colors.danger
            case .flat: return HobbyIQTheme.Colors.mutedText
            }
        }
        var glyph: String {
            switch self {
            case .up: return "\u{25B2}"
            case .down: return "\u{25BC}"
            case .flat: return "\u{2500}"
            }
        }
    }

    private func loadHeroSparkline() async {
        let id = card.cardId?.trimmingCharacters(in: .whitespaces) ?? ""
        guard id.isEmpty == false else { return }
        do {
            let response = try await APIService.shared.fetchPriceHistory(
                cardId: id,
                window: PriceHistoryWindow.threeMonths.rawValue,
                bucket: PriceHistoryBucket.weekly.rawValue
            )
            sparklinePoints = response.points
        } catch {
            sparklinePoints = nil
        }
    }

    /// The holding's locked grade as a display label — "Raw" for
    /// ungraded holdings, "PSA 10" / "BGS 9.5" / etc. for graded.
    /// Composed from `(gradeCompany, gradeValue)` when both present,
    /// falls back to the wire's `grade` string when they're not.
    private var gradeChipLabel: String {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           let value = card.gradeValue,
           company.isEmpty == false {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return "\(company) \(valueStr)"
        }
        let trimmed = card.grade.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "Raw" : trimmed
    }

    /// Same visual as a GradePillPanel pill in the selected state —
    /// electric-blue accent, gradient stroke, filled background — but
    /// non-interactive.
    private var gradeChip: some View {
        Text(gradeChipLabel)
            .font(.caption.weight(.bold))
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(HobbyIQTheme.Colors.electricBlue.opacity(0.22))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(
                        LinearGradient(
                            colors: [
                                HobbyIQTheme.Colors.electricBlue,
                                HobbyIQTheme.Colors.hobbyGreen.opacity(0.7)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        ),
                        lineWidth: 1.5
                    )
            )
            .clipShape(Capsule(style: .continuous))
    }

    private var editPill: some View {
        Button(action: onEdit) {
            HStack(spacing: 4) {
                Image(systemName: "pencil")
                    .font(.caption2.weight(.bold))
                Text("Edit")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.85))
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.4), lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
