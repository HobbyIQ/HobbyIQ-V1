//
//  SharedComponents.swift
//  HobbyIQ
//

import SwiftUI

struct SearchBarView: View {
    let placeholder: String
    @Binding var text: String
    var onSubmit: () -> Void

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            TextField(placeholder, text: $text)
                .textInputAutocapitalization(.words)
                .submitLabel(.search)
                .onSubmit(onSubmit)

            if text.isEmpty == false {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .buttonStyle(.plain)
            }
        }
        .inputFieldStyle()
    }
}

struct SectionCardView<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder var content: Content

    init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            // CF-UNIFY-SECTION-HEADERS (2026-06-17): delegates to the
            // shared HIQSectionHeader.
            HIQSectionHeader(title, subtitle: subtitle)

            content
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct MetricPillView: View {
    let title: String
    let value: String
    var accent: Color = HobbyIQTheme.Colors.pureWhite

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.appBackground.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }
}

struct ActionBadgeView: View {
    let action: RecommendationAction

    var body: some View {
        Text(action.rawValue)
            .font(.caption.weight(.bold))
            .foregroundStyle(foregroundColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(backgroundColor)
            .clipShape(Capsule())
    }

    private var foregroundColor: Color {
        switch action {
        case .buy:
            return HobbyIQTheme.Colors.electricBlue
        case .hold, .watch:
            return HobbyIQTheme.Colors.warning
        case .trim, .sell:
            return HobbyIQTheme.Colors.danger
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.14)
    }
}

struct ConfidenceMetaRow: View {
    let refreshMeta: RefreshMeta

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.small) {
            Label(refreshMeta.relativeTimestamp, systemImage: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            if let confidence = refreshMeta.confidence {
                Label("\(confidence)% confidence", systemImage: "gauge.with.dots.needle.50percent")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            Spacer()
        }
    }
}

struct RefreshMetaView: View {
    let refreshMeta: RefreshMeta

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConfidenceMetaRow(refreshMeta: refreshMeta)

            if let note = refreshMeta.note, note.isEmpty == false {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    let systemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)

            VStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct ErrorStateView: View {
    let title: String
    let message: String
    var retryTitle: String = "Retry"
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.danger)

            VStack(spacing: HobbyIQTheme.Spacing.xSmall) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            if let retry {
                Button(retryTitle, action: retry)
                    .buttonStyle(SecondaryButton())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct LoadingCardView: View {
    let title: String
    let message: String

    var body: some View {
        HStack(spacing: HobbyIQTheme.Spacing.medium) {
            ProgressView()
                .progressViewStyle(CircularProgressViewStyle(tint: HobbyIQTheme.Colors.electricBlue))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            Spacer()
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .hiqCardStyle()
    }
}

struct ActivityIndicatorView: View {
    var body: some View {
        ProgressView()
            .progressViewStyle(CircularProgressViewStyle(tint: HobbyIQTheme.Colors.electricBlue))
    }
}

struct PortfolioInsightCardView: View {
    let playerName: String
    let cardName: String
    let roiText: String
    let roiColor: Color
    let valueText: String
    let listText: String?
    let accent: Color
    let reasoning: [String]?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(playerName)
                        .font(.headline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(cardName)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                Spacer()

                Text(roiText)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(roiColor)
            }

            HStack {
                Text("Value")
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(valueText)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fontWeight(.semibold)
            }

            if let listText {
                HStack {
                    Text("List")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(listText)
                        .foregroundStyle(accent)
                        .fontWeight(.semibold)
                }
            }

            if let reasoning, reasoning.isEmpty == false {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(reasoning.prefix(2).enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Text("•")
                                .foregroundStyle(accent)
                            Text(line)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                        }
                        .font(.footnote)
                    }
                }
                .padding(12)
                .background(HobbyIQTheme.Colors.steelGray)
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.small, style: .continuous))
            }
        }
        .padding(14)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }
}

// MARK: - CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26)

/// CardHedge headline + model-line + lean-badge composite. Three blocks,
/// independently optional — caller hands in whichever fields the wire
/// surfaced. Used on both the comp page (price-by-id response) and the
/// portfolio list cell + detail view (holding wire).
///
/// FALLBACK CONTRACT:
///   - last-sale absent → headline omitted
///   - modelExpectation absent → model line omitted
///   - modelSignal absent OR `lean` unknown → badge omitted (this is the
///     correct render when the helper returned null — no curated row /
///     unresolvable subset / thin base pool)
///   - all three absent → renders nothing (caller can wrap in nil-check
///     for parent-layout suppression)
struct CardHedgeModelSignalView: View {
    let lastSalePrice: Double?
    let lastSaleCompCount: Int?
    let modelExpectation: CardHedgeModelExpectation?
    let modelSignal: CardHedgeModelSignal?

    var body: some View {
        let head = headlineString()
        let model = modelLineString()
        let signal = resolvedSignal()
        let trend = resolvedTrendAnchor()
        let projection = forwardProjectionString()
        let position = positionSignalString()

        if head != nil || model != nil || signal != nil
            || trend != nil || projection != nil || position != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let head {
                    Text(head)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let model {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let signal {
                    HStack(spacing: 6) {
                        Text(signal.label)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(signal.tint)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(signal.tint.opacity(0.18))
                            .clipShape(Capsule(style: .continuous))
                        if let pct = modelSignal?.deltaPct {
                            Text(deltaPctString(pct))
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                }
                if let trend {
                    // CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26):
                    // trendAnchor chip. Direction "rising"/"falling" only
                    // (flat suppressed). Opacity = R² floored at 0.35 so
                    // a near-zero R² still reads as deliberately faded
                    // rather than invisible.
                    Text(trend.text)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(trend.tint)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(trend.tint.opacity(0.18))
                        .clipShape(Capsule(style: .continuous))
                        .opacity(trend.dimming)
                }
                if let projection {
                    Text(projection)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let position {
                    Text(position.text)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(position.tint)
                }
            }
        }
    }

    private func headlineString() -> String? {
        guard let price = lastSalePrice else { return nil }
        let dollar = price.formatted(.currency(code: "USD"))
        if let n = lastSaleCompCount, n > 0 {
            return "Last sold \(dollar) via \(n) comp\(n == 1 ? "" : "s")"
        }
        return "Last sold \(dollar)"
    }

    private func modelLineString() -> String? {
        guard let exp = modelExpectation, let value = exp.value else { return nil }
        let dollar = value.formatted(.currency(code: "USD"))
        if let lo = exp.rangeLow, let hi = exp.rangeHigh {
            let loStr = lo.formatted(.currency(code: "USD"))
            let hiStr = hi.formatted(.currency(code: "USD"))
            return "Model expects \(dollar) (range \(loStr)–\(hiStr))"
        }
        return "Model expects \(dollar)"
    }

    private func resolvedSignal() -> (label: String, tint: Color)? {
        guard let rawLean = modelSignal?.lean,
              let lean = CardHedgeLean(rawValue: rawLean.lowercased()) else {
            return nil
        }
        switch lean {
        case .buy:  return ("Lean Buy",  HobbyIQTheme.Colors.successGreen)
        case .hold: return ("In Range",  HobbyIQTheme.Colors.mutedText)
        case .sell: return ("Lean Sell", HobbyIQTheme.Colors.warning)
        }
    }

    private func deltaPctString(_ pct: Double) -> String {
        let absPct = abs(pct)
        let sign = pct >= 0 ? "+" : "−"
        let direction = pct >= 0 ? "above" : "below"
        return "\(sign)\(String(format: "%.0f%%", absPct)) \(direction) model"
    }

    /// trendAnchor → chip text/tint/opacity. Only fires on rising/falling
    /// (CF: "up/down only"); flat/unknown/missing → nil → no chip.
    private func resolvedTrendAnchor() -> (text: String, tint: Color, dimming: Double)? {
        guard let trend = modelExpectation?.trendAnchor,
              let raw = trend.direction?.lowercased() else { return nil }
        let isUp = (raw == "rising" || raw == "up")
        let isDown = (raw == "falling" || raw == "down")
        guard isUp || isDown else { return nil }
        var text = "Base market \(isUp ? "rising" : "falling")"
        if let slope = trend.slopePctPerDay {
            let sign = slope >= 0 ? "+" : "−"
            text += " \(sign)\(String(format: "%.2f%%", abs(slope)))/day"
        }
        // trendConfidence dims the chip: high confidence = full opacity,
        // low = faded. Floor at 0.35 so a near-zero confidence still reads
        // as intentional fade. (Renamed from rSquared per backend
        // CF-CH-RESPONSE-SURFACE-SUBBLOCKS, semantics identical: 0-1
        // quality-of-fit number.)
        let dimming = trend.trendConfidence.map { max(0.35, min(1.0, $0)) } ?? 0.7
        let tint = isUp ? HobbyIQTheme.Colors.successGreen : Color.red
        return (text, tint, dimming)
    }

    /// forwardProjection → "Next likely $L–$H if trend holds" when both
    /// range bounds decode cleanly. Nil if either bound missing.
    private func forwardProjectionString() -> String? {
        guard let proj = modelExpectation?.forwardProjection,
              let low = proj.low, let high = proj.high else { return nil }
        let loStr = low.formatted(.currency(code: "USD"))
        let hiStr = high.formatted(.currency(code: "USD"))
        return "Next likely \(loStr)–\(hiStr) if trend holds"
    }

    /// positionSignal → gain/loss line. Signed; green when positive, red
    /// when negative. Suppressed when `gainVsLastSale` is nil.
    /// Per backend CF-CH-RESPONSE-SURFACE-SUBBLOCKS the wire dropped
    /// `gainLoss` (vs purchase) in favor of `gainVsLastSale` (vs the
    /// closest comp). Binding redirected to the closest signed-dollar
    /// equivalent so the existing component continues to render; the
    /// "vs purchase" copy is now semantically loose — relabel + vs-
    /// purchase compute lives in a separate CF.
    private func positionSignalString() -> (text: String, tint: Color)? {
        guard let pos = modelExpectation?.positionSignal,
              let gainLoss = pos.gainVsLastSale else { return nil }
        let sign = gainLoss >= 0 ? "+" : "−"
        let absDollar = abs(gainLoss).formatted(.currency(code: "USD"))
        var text = "\(sign)\(absDollar) vs purchase"
        if let pct = pos.gainPct {
            let pctSign = pct >= 0 ? "+" : "−"
            text += " (\(pctSign)\(String(format: "%.0f%%", abs(pct))))"
        }
        let tint = gainLoss >= 0 ? HobbyIQTheme.Colors.successGreen : Color.red
        return (text, tint)
    }
}

// MARK: - CF-IOS-MODEL-SIGNAL-RENDER #Previews

fileprivate struct CardHedgeSignalPreviewWrapper<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            content()
                .padding(.vertical, 12)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                        .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
        .padding()
        .background(HobbyIQTheme.Colors.appBackground)
    }
}

#Preview("CardHedge · Hartman sell ($450 · Lean Sell +72% · model $262)") {
    CardHedgeSignalPreviewWrapper(title: "sell — full data") {
        CardHedgeModelSignalView(
            lastSalePrice: 450,
            lastSaleCompCount: 1,
            modelExpectation: CardHedgeModelExpectation(
                value: 262,
                range: [250, 273],
                multiplier: 3.20,
                multiplierRange: [3.05, 3.33],
                basis: "prices_by_card_honest",
                n: 11,
                baseAutoMedian: 82,
                baseAutoCount: 69
            ),
            modelSignal: CardHedgeModelSignal(
                lean: "sell",
                deltaPct: 72,
                expectation: 262,
                effectiveMultiplier: 3.20
            )
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · hold ($310 · In Range −2% · model $315)") {
    CardHedgeSignalPreviewWrapper(title: "hold — in-range case") {
        CardHedgeModelSignalView(
            lastSalePrice: 310,
            lastSaleCompCount: 8,
            modelExpectation: CardHedgeModelExpectation(
                value: 315,
                range: [298, 332],
                multiplier: 3.84,
                multiplierRange: [3.63, 4.05],
                basis: "prices_by_card_honest",
                n: 8,
                baseAutoMedian: 82,
                baseAutoCount: 69
            ),
            modelSignal: CardHedgeModelSignal(
                lean: "hold",
                deltaPct: -2,
                expectation: 315,
                effectiveMultiplier: 3.84
            )
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · buy ($200 · Lean Buy −32% · model $295)") {
    CardHedgeSignalPreviewWrapper(title: "buy — below model") {
        CardHedgeModelSignalView(
            lastSalePrice: 200,
            lastSaleCompCount: 6,
            modelExpectation: CardHedgeModelExpectation(
                value: 295,
                range: [280, 310],
                multiplier: 3.60,
                multiplierRange: [3.41, 3.78],
                basis: "prices_by_card_honest",
                n: 6,
                baseAutoMedian: 82,
                baseAutoCount: 69
            ),
            modelSignal: CardHedgeModelSignal(
                lean: "buy",
                deltaPct: -32,
                expectation: 295,
                effectiveMultiplier: 3.60
            )
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · no-modelSignal fallback (headline only)") {
    CardHedgeSignalPreviewWrapper(title: "no-signal fallback — helper returned null") {
        CardHedgeModelSignalView(
            lastSalePrice: 450,
            lastSaleCompCount: 11,
            modelExpectation: nil,
            modelSignal: nil
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · trendAnchor up chip (R²=0.74, +0.42%/day)") {
    CardHedgeSignalPreviewWrapper(title: "trendAnchor rising — R² dims chip opacity") {
        CardHedgeModelSignalView(
            lastSalePrice: 450,
            lastSaleCompCount: 1,
            modelExpectation: CardHedgeModelExpectation(
                value: 262,
                range: [250, 273],
                basis: "prices_by_card_honest",
                n: 11,
                trendAnchor: CardHedgeTrendAnchor(
                    direction: "rising",
                    slopePctPerDay: 0.42,
                    trendConfidence: 0.74,
                    windowDays: nil,
                    daysWithSales: nil,
                    projectedBaseAtSale: nil,
                    projectedBaseToday: nil,
                    allTimeBaseMedian: nil
                )
            ),
            modelSignal: nil
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · forwardProjection range ($460–$490 if trend holds)") {
    CardHedgeSignalPreviewWrapper(title: "forwardProjection — \"Next likely\" range line") {
        CardHedgeModelSignalView(
            lastSalePrice: 450,
            lastSaleCompCount: 1,
            modelExpectation: CardHedgeModelExpectation(
                value: 262,
                range: [250, 273],
                basis: "prices_by_card_honest",
                n: 11,
                forwardProjection: CardHedgeForwardProjection(
                    low: 460,
                    high: 490,
                    basis: nil,
                    confidence: nil
                )
            ),
            modelSignal: nil
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("CardHedge · all sub-blocks together (Hartman BXF full shape)") {
    CardHedgeSignalPreviewWrapper(title: "headline + model + badge + trendAnchor + projection + position") {
        CardHedgeModelSignalView(
            lastSalePrice: 450,
            lastSaleCompCount: 1,
            modelExpectation: CardHedgeModelExpectation(
                value: 262,
                range: [250, 273],
                multiplier: 3.20,
                multiplierRange: [3.05, 3.33],
                basis: "prices_by_card_honest",
                n: 11,
                baseAutoMedian: 82,
                baseAutoCount: 69,
                trendAnchor: CardHedgeTrendAnchor(
                    direction: "rising",
                    slopePctPerDay: 0.42,
                    trendConfidence: 0.74,
                    windowDays: nil,
                    daysWithSales: nil,
                    projectedBaseAtSale: nil,
                    projectedBaseToday: nil,
                    allTimeBaseMedian: nil
                ),
                forwardProjection: CardHedgeForwardProjection(
                    low: 460,
                    high: 490,
                    basis: nil,
                    confidence: nil
                ),
                positionSignal: CardHedgePositionSignal(
                    purchasePrice: nil,
                    gainVsLastSale: 188,
                    gainVsExpectation: nil,
                    gainPct: 71.97
                )
            ),
            modelSignal: CardHedgeModelSignal(
                lean: "sell",
                deltaPct: 72,
                expectation: 262,
                effectiveMultiplier: 3.20
            )
        )
    }
    .preferredColorScheme(.dark)
}
