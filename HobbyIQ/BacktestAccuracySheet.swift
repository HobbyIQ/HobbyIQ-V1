//
//  BacktestAccuracySheet.swift
//  HobbyIQ
//
//  Drill-down sheet for the engine-accuracy trust badge (PR #548).
//  Presented when the user taps the badge under the total portfolio
//  value on the Portfolio landing.
//

import SwiftUI

struct BacktestAccuracySheet: View {
    let response: PredictedPriceAccuracyResponse
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                HobbyIQBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        headerBlock

                        VStack(spacing: 12) {
                            statRow(label: "Within \u{00B1}10% of predicted", value: percentString(response.accuracy?.hitRateWithin10Pct))
                            statRow(label: "Within \u{00B1}20% of predicted", value: percentString(response.accuracy?.hitRateWithin20Pct))
                            statRow(label: "Median error", value: medianErrorString)
                            statRow(label: "Bias", value: biasString)
                        }
                        .padding(HobbyIQTheme.Spacing.medium)
                        .background(HobbyIQTheme.Colors.cardNavy)
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.4)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))

                        Text("Compares each holding's predicted price to the actual sale price when a comparable comp lands. Backtest is rolling; it reflects how the engine has performed on your portfolio's kinds of cards recently.")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(HobbyIQTheme.Spacing.screenPadding)
                }
            }
            .navigationTitle("Engine Accuracy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ENGINE ACCURACY")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(headerLine)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var headerLine: String {
        let pairs = response.accuracy?.matchedPairs ?? 0
        return "Last 90 days · \(pairs) matched sale\(pairs == 1 ? "" : "s")"
    }

    private func statRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private var medianErrorString: String {
        guard let median = response.accuracy?.medianAbsPctError else { return "—" }
        return String(format: "%.0f%%", median * 100)
    }

    private var biasString: String {
        guard let over = response.accuracy?.overShootShare else { return "—" }
        let overPct = Int((over * 100).rounded())
        if overPct >= 60 {
            return "Bullish (\(overPct)% over)"
        } else if overPct <= 40 {
            return "Bearish (\(100 - overPct)% under)"
        } else {
            return "Balanced"
        }
    }

    private func percentString(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.0f%%", value * 100)
    }
}
