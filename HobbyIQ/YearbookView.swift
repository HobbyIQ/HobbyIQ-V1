//
//  YearbookView.swift
//  HobbyIQ
//
//  Phase 4.14 (2026-07-17, PR #533): annual/quarterly recap. Full-screen
//  retrospective accessible from Profile → "Your {YYYY} Yearbook" after
//  Dec 15 each year. Shows realized + unrealized gains, cards
//  bought/sold/held, top performers vs. biggest misses, and a
//  counterfactual "what if you held everything" opportunity-cost callout.
//

import SwiftUI

struct YearbookView: View {
    let year: Int
    let quarter: String?

    @State private var response: YearbookResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?

    init(year: Int, quarter: String? = nil) {
        self.year = year
        self.quarter = quarter
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                heroBlock
                if isLoading && response == nil {
                    loadingState
                } else if let response {
                    totalsBlock(response)
                    activityBlock(response)
                    performersBlock(response)
                    counterfactualBlock(response)
                } else if let errorMessage {
                    Text(errorMessage)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .frame(maxWidth: .infinity, minHeight: 200)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Yearbook")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task { await load() }
    }

    // MARK: - Blocks

    private var heroBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(response?.period ?? String(year))
                .font(.system(size: 42, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Your card year in review")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func totalsBlock(_ r: YearbookResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("PORTFOLIO TOTALS")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)

            if let realized = r.totalRealizedGainUsd {
                totalRow(label: "Realized gain", value: realized)
            }
            if let unrealized = r.totalUnrealizedGainUsd {
                totalRow(label: "Unrealized gain", value: unrealized)
            }
            Divider().overlay(HobbyIQTheme.Colors.steelGray.opacity(0.35))
            if let cost = r.totalCostBasis {
                totalRow(label: "Cost basis", value: cost, tint: .white)
            }
            if let value = r.totalCurrentValue {
                totalRow(label: "Current value", value: value, tint: .white)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func totalRow(label: String, value: Double, tint: Color = HobbyIQTheme.Colors.successGreen) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            let color: Color = {
                if tint == .white { return HobbyIQTheme.Colors.pureWhite }
                return value >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger
            }()
            let prefix = (value > 0 && tint != .white) ? "+" : ""
            Text("\(prefix)\(portfolioCurrencyString(value))")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(color)
        }
    }

    @ViewBuilder
    private func activityBlock(_ r: YearbookResponse) -> some View {
        HStack(spacing: 8) {
            activityChip(label: "Bought", count: r.cardsBought)
            activityChip(label: "Sold", count: r.cardsSold)
            activityChip(label: "Held", count: r.cardsHeld)
        }
    }

    @ViewBuilder
    private func activityChip(label: String, count: Int?) -> some View {
        VStack(spacing: 6) {
            Text(count.map { "\($0)" } ?? "—")
                .font(.system(size: 28, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    @ViewBuilder
    private func performersBlock(_ r: YearbookResponse) -> some View {
        if let tops = r.topPerformers, tops.isEmpty == false {
            performerList(title: "Top performers", performers: tops, tint: HobbyIQTheme.Colors.successGreen)
        }
        if let misses = r.biggestMisses, misses.isEmpty == false {
            performerList(title: "Biggest misses", performers: misses, tint: HobbyIQTheme.Colors.danger)
        }
    }

    @ViewBuilder
    private func performerList(title: String, performers: [YearbookPerformer], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            ForEach(performers) { performer in
                HStack {
                    Text(performer.player ?? "—")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .lineLimit(1)
                    Spacer()
                    if let pct = performer.gainPct {
                        Text(formatSignedPct(pct))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(tint)
                    }
                    if let usd = performer.gainUsd {
                        let prefix = usd > 0 ? "+" : "\u{2212}"
                        Text("(\(prefix)\(portfolioCurrencyString(abs(usd))))")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(tint.opacity(0.35), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func formatSignedPct(_ pct: Double) -> String {
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        if abs(pct) >= 100 {
            return "\(sign)\(Int(abs(pct).rounded()))%"
        }
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    @ViewBuilder
    private func counterfactualBlock(_ r: YearbookResponse) -> some View {
        if let cf = r.whatIfHeldAll,
           let opportunityCost = cf.opportunityCostUsd, opportunityCost > 0 {
            VStack(alignment: .leading, spacing: 8) {
                Text("WHAT IF YOU HELD EVERYTHING")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                if let cfValue = cf.counterfactualCurrentValue {
                    Text(portfolioCurrencyString(cfValue))
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                Text("Opportunity cost: +\(portfolioCurrencyString(opportunityCost))")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                if let note = cf.note?.trimmingCharacters(in: .whitespaces), note.isEmpty == false {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.warning.opacity(0.4), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    // MARK: - States

    private var loadingState: some View {
        HStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Building your yearbook…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
    }

    // MARK: - Load

    private func load() async {
        do {
            response = try await APIService.shared.fetchYearbook(year: year, quarter: quarter)
            isLoading = false
        } catch {
            errorMessage = "Couldn't load your yearbook right now."
            isLoading = false
        }
    }
}
