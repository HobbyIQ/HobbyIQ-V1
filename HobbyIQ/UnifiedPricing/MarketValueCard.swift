//
//  MarketValueCard.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 1 (Drew, 2026-08-04).
//
//  The hero pricing block that renders MARKET VALUE + PREDICTED (7D)
//  in the pattern the blueprint locked. Drop-in for any surface that
//  needs to display a canonical price + companion prediction from
//  unified pricing.
//
//  Cross-platform parity: mirrors the web hero at
//    apps/web/src/app/app/portfolio/[id]/page.tsx
//  Same information density, same field labels, same colors from
//  HobbyIQTheme.
//
//  Blueprint: backend/docs/ios-unified-rebuild-blueprint.md
//

import SwiftUI

/// Renders the MARKET VALUE headline + optional PREDICTED (7D)
/// companion + optional range detail underneath.
///
/// Semantics locked in the blueprint:
///   - `marketValue` — the ONE canonical current value (unified marketValue).
///     Rendered big and bold. `~$X` prefix when `isEstimated` is true.
///   - `predictedPrice` — companion 7d forward projection. Only shown
///     when it differs from marketValue by ≥ $1 (thin-pool flat cases
///     hide the redundant repeat).
///   - `confidence` — 0-1. Confidence pill shows when < 0.6 as a caveat.
///   - `rangeLow` / `rangeHigh` — optional p10/p90 or predicted range.
///     Rendered as small muted caption underneath.
struct MarketValueCard: View {
    let marketValue: Double?
    let predictedPrice: Double?
    let confidence: Double?
    let rangeLow: Double?
    let rangeHigh: Double?
    let isEstimated: Bool
    let onTap: (() -> Void)?

    init(
        marketValue: Double?,
        predictedPrice: Double? = nil,
        confidence: Double? = nil,
        rangeLow: Double? = nil,
        rangeHigh: Double? = nil,
        isEstimated: Bool = false,
        onTap: (() -> Void)? = nil
    ) {
        self.marketValue = marketValue
        self.predictedPrice = predictedPrice
        self.confidence = confidence
        self.rangeLow = rangeLow
        self.rangeHigh = rangeHigh
        self.isEstimated = isEstimated
        self.onTap = onTap
    }

    var body: some View {
        VStack(spacing: HobbyIQTheme.Spacing.small) {
            marketValueBlock
            if hasVisiblePrediction {
                predictedBlock
            }
            if let low = rangeLow, let high = rangeHigh, low > 0, high > 0 {
                rangeCaption(low: low, high: high)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: MARKET VALUE headline

    @ViewBuilder
    private var marketValueBlock: some View {
        VStack(spacing: 8) {
            Text("MARKET VALUE")
                .font(.caption.weight(.semibold))
                .tracking(1.0)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            if let mv = marketValue, mv > 0 {
                let prefix = isEstimated ? "~" : ""
                Text(prefix + wholeUSDString(mv))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                HobbyIQTheme.Colors.pureWhite,
                                HobbyIQTheme.Colors.electricBlue.opacity(0.85)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 14, x: 0, y: 0)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentShape(Rectangle())
                    .onTapGesture { onTap?() }
                if let confidence, confidence < 0.6 {
                    lowConfidencePill(confidence: confidence)
                }
            } else {
                Text("—")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("Not enough sales in the pool yet")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: PREDICTED (7D) companion

    /// Only render when the predicted number is meaningfully different
    /// from the market value — thin pools set predicted = market and
    /// we skip the redundant repeat.
    private var hasVisiblePrediction: Bool {
        guard let predicted = predictedPrice, predicted > 0,
              let market = marketValue, market > 0 else {
            return false
        }
        return abs(predicted - market) >= 1.0
    }

    @ViewBuilder
    private var predictedBlock: some View {
        if let predicted = predictedPrice, let market = marketValue, market > 0 {
            let deltaPct = ((predicted - market) / market) * 100
            let isUp = deltaPct > 0.5
            let isDown = deltaPct < -0.5
            let deltaColor: Color = {
                if isUp { return HobbyIQTheme.Colors.hobbyGreen }
                if isDown { return HobbyIQTheme.Colors.danger }
                return HobbyIQTheme.Colors.mutedText
            }()
            let arrow: String = {
                if isUp { return "↑" }
                if isDown { return "↓" }
                return ""
            }()
            VStack(spacing: 4) {
                Text("PREDICTED (7D)")
                    .font(.caption2.weight(.semibold))
                    .tracking(1.0)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                HStack(spacing: 8) {
                    Text(wholeUSDString(predicted))
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    if !arrow.isEmpty || abs(deltaPct) >= 0.1 {
                        Text(deltaText(arrow: arrow, deltaPct: deltaPct))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(deltaColor)
                    }
                }
            }
        }
    }

    private func deltaText(arrow: String, deltaPct: Double) -> String {
        let magnitudeText = String(format: "%.1f%%", abs(deltaPct))
        if arrow.isEmpty { return magnitudeText }
        return "\(arrow) \(magnitudeText)"
    }

    // MARK: Range caption

    private func rangeCaption(low: Double, high: Double) -> some View {
        Text("Range \(wholeUSDString(low)) – \(wholeUSDString(high))")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
    }

    // MARK: Low confidence pill

    private func lowConfidencePill(confidence: Double) -> some View {
        let pct = Int((confidence * 100).rounded())
        return Text("ESTIMATE · \(pct)% CONFIDENCE")
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .foregroundStyle(HobbyIQTheme.Colors.warning)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(HobbyIQTheme.Colors.warning.opacity(0.14))
            .clipShape(Capsule(style: .continuous))
    }
}

// MARK: - Preview

#Preview("Observed with up trend") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        MarketValueCard(
            marketValue: 2596,
            predictedPrice: 2743,
            confidence: 1.0,
            rangeLow: 1750,
            rangeHigh: 3101,
            isEstimated: false
        )
        .padding()
    }
}

#Preview("Thin pool no prediction") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        MarketValueCard(
            marketValue: 279,
            predictedPrice: 279,
            confidence: 0.4,
            rangeLow: nil,
            rangeHigh: nil,
            isEstimated: false
        )
        .padding()
    }
}

#Preview("Estimated (ladder-derived)") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        MarketValueCard(
            marketValue: 1415,
            predictedPrice: nil,
            confidence: 0.35,
            rangeLow: 1200,
            rangeHigh: 1600,
            isEstimated: true
        )
        .padding()
    }
}

#Preview("No data") {
    ZStack {
        HobbyIQTheme.Gradients.background.ignoresSafeArea()
        MarketValueCard(
            marketValue: nil,
            predictedPrice: nil,
            confidence: 0,
            rangeLow: nil,
            rangeHigh: nil,
            isEstimated: false
        )
        .padding()
    }
}
