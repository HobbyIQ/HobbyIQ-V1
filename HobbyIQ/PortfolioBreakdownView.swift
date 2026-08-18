//
//  PortfolioBreakdownView.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). "Own fewer cards. Own better cards."
//
//  Answers six questions in order and nothing else: what do I own · where is my
//  money concentrated · how risky is it · am I overweight prospects or commodity
//  modern · how much true scarcity do I own · what should I improve.
//
//  RENDERS, DOES NOT COMPUTE. Every number comes from
//  GET /api/portfolioiq/breakdown. The web dashboard reads the same payload, so
//  the two clients cannot disagree about the same portfolio — which is the whole
//  reason the analysis is not duplicated here in Swift.
//

import SwiftUI
import Charts

struct PortfolioBreakdownView: View {
    @State private var result: PortfolioBreakdownResponse = .empty
    @State private var loading = true
    @State private var loadError: String?
    @State private var expandedScore = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if loading {
                    ProgressView("Analyzing portfolio…")
                        .tint(HobbyIQTheme.Colors.electricBlue)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .padding(.vertical, 48)
                } else if let loadError {
                    errorState(loadError)
                } else if result.cardCount == 0 {
                    emptyState
                } else {
                    headerStats
                    scoreCard
                    allocationCard
                    riskCard
                    concentrationCard
                    qualityCard
                    recommendationsCard
                    upgradeCard
                    dataCaveat
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .background(HobbyIQTheme.Colors.appBackground.ignoresSafeArea())
        .navigationTitle("Portfolio Breakdown")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loadError = nil
        do {
            result = try await APIService.shared.fetchPortfolioBreakdown()
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }

    // MARK: - States

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(HobbyIQTheme.Colors.warning)
            Text("Couldn’t load the breakdown")
                .font(.headline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .hiqCard()
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.pie")
                .font(.system(size: 40))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text("No holdings to analyze yet")
                .font(.headline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Add cards to your portfolio and the breakdown will build itself from what you own.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
        .hiqCard()
    }

    // MARK: - Header

    private var headerStats: some View {
        VStack(spacing: 14) {
            HStack {
                statBlock("Total Value", wholeUSDString(result.totalValue), HobbyIQTheme.Colors.pureWhite)
                Divider().frame(height: 34).overlay(HobbyIQTheme.Colors.steelGray)
                statBlock("Cost Basis", wholeUSDString(result.totalCost), HobbyIQTheme.Colors.mutedText)
            }
            HStack {
                statBlock("Profit / Loss",
                          (result.totalProfitLoss >= 0 ? "+" : "") + wholeUSDString(result.totalProfitLoss),
                          result.totalProfitLoss >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
                Divider().frame(height: 34).overlay(HobbyIQTheme.Colors.steelGray)
                statBlock("ROI", String(format: "%@%.1f%%", result.roi >= 0 ? "+" : "", result.roi),
                          result.roi >= 0 ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.danger)
            }
        }
        .padding(16)
        .hiqCard()
    }

    private func statBlock(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Score

    private var scoreCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("PORTFOLIOIQ SCORE")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(result.score.value)")
                            .font(.system(size: 42, weight: .bold, design: .rounded))
                            .foregroundStyle(scoreTint)
                        Text("/ 100")
                            .font(.headline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer()
                Text(result.score.tier)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(scoreTint)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(scoreTint.opacity(0.14), in: Capsule())
            }

            ProgressView(value: Double(result.score.value), total: 100)
                .tint(scoreTint)

            // A score the owner cannot interrogate is a horoscope.
            DisclosureGroup(isExpanded: $expandedScore) {
                VStack(spacing: 8) {
                    ForEach(result.score.components) { c in
                        HStack {
                            Text(c.name)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            Spacer()
                            Text("\(Int(c.score * 100))")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            Text("×\(String(format: "%.2f", c.weight))")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .frame(width: 42, alignment: .trailing)
                        }
                    }
                }
                .padding(.top, 8)
            } label: {
                Text("What is behind this score")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            }
            .tint(HobbyIQTheme.Colors.electricBlue)
        }
        .padding(16)
        .hiqCard()
    }

    private var scoreTint: Color {
        switch result.score.tier {
        case "Elite", "Strong Portfolio": return HobbyIQTheme.Colors.successGreen
        case "Good Portfolio", "Moderate Risk": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.danger
        }
    }

    // MARK: - Allocation

    private var allocationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("Allocation",
                         subtitle: result.usingCustomTiers == true ? "Current vs your targets" : "Current vs HobbyIQ target")

            Chart(result.allocations) { a in
                SectorMark(
                    angle: .value("Value", a.value),
                    innerRadius: .ratio(0.62),
                    angularInset: 1.5
                )
                .foregroundStyle(tint(for: a.category))
                .cornerRadius(3)
            }
            .frame(height: 190)
            .chartLegend(.hidden)
            .overlay {
                VStack(spacing: 1) {
                    Text("\(result.cardCount)")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text(result.cardCount == 1 ? "card" : "cards")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }

            VStack(spacing: 10) {
                ForEach(result.allocations) { a in allocationRow(a) }
            }
        }
        .padding(16)
        .hiqCard()
    }

    private func allocationRow(_ a: BreakdownAllocation) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Circle().fill(tint(for: a.category)).frame(width: 9, height: 9)
                Text(a.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
                Text(statusLabel(a.status))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(statusTint(a.status))
            }
            if a.blurb.isEmpty == false {
                Text(a.blurb)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Text("Current \(Int(a.currentShare * 100))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("· Target \(Int(a.targetShare * 100))%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
                Text(wholeUSDString(a.value))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            // Current bar with the target marked on it, so the gap is visible
            // without reading two numbers and subtracting.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    Capsule().fill(tint(for: a.category))
                        .frame(width: max(2, geo.size.width * min(1, a.currentShare)))
                    Rectangle()
                        .fill(HobbyIQTheme.Colors.pureWhite.opacity(0.75))
                        .frame(width: 2)
                        .offset(x: geo.size.width * a.targetShare)
                }
            }
            .frame(height: 6)
        }
    }

    /// Colours the four built-ins by identity; user-defined tiers cycle a stable
    /// palette keyed off the id, so a custom bucket keeps its colour run to run.
    private func tint(for category: String) -> Color {
        switch category {
        case "establishedGreatness": return HobbyIQTheme.Colors.hobbyGreen
        case "trueScarcity": return HobbyIQTheme.Colors.electricBlue
        case "eliteProspects": return HobbyIQTheme.Colors.brightBlue
        case "speculation": return HobbyIQTheme.Colors.warning
        case "__unassigned__": return HobbyIQTheme.Colors.steelGray
        default:
            let palette: [Color] = [
                HobbyIQTheme.Colors.hobbyGreen, HobbyIQTheme.Colors.electricBlue,
                HobbyIQTheme.Colors.brightBlue, HobbyIQTheme.Colors.warning,
                HobbyIQTheme.Colors.successGreen,
            ]
            return palette[abs(category.hashValue) % palette.count]
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "onTarget": return "ON TARGET"
        case "slightlyUnderweight": return "SLIGHTLY UNDERWEIGHT"
        case "underweight": return "UNDERWEIGHT"
        case "slightlyOverweight": return "SLIGHTLY OVERWEIGHT"
        case "overweight": return "OVERWEIGHT"
        default: return status.uppercased()
        }
    }

    /// Deliberately restrained: only real drift earns a warning colour. A screen
    /// that shouts at everything teaches people to stop reading it.
    private func statusTint(_ status: String) -> Color {
        switch status {
        case "onTarget": return HobbyIQTheme.Colors.successGreen
        case "underweight", "overweight": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    // MARK: - Risk

    private var riskCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Portfolio Risk", subtitle: nil)
            ForEach(result.risk) { m in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.name)
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text(m.detail)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    Text(m.label)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(riskTint(m))
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(riskTint(m).opacity(0.14), in: Capsule())
                }
            }
        }
        .padding(16)
        .hiqCard()
    }

    private func riskTint(_ m: BreakdownRiskMetric) -> Color {
        if m.isConcerning { return HobbyIQTheme.Colors.danger }
        let good = m.polarity == "strengthIsGood" ? m.level == "high" : m.level == "low"
        return good ? HobbyIQTheme.Colors.successGreen : HobbyIQTheme.Colors.warning
    }

    // MARK: - Concentration

    @ViewBuilder
    private var concentrationCard: some View {
        let warnings = result.concentrations.filter(\.isWarning)
        if warnings.isEmpty == false {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Concentration", subtitle: nil)
                ForEach(warnings) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.warning)
                            Text(c.displayName)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        Text("\(Int(c.share * 100))% of your portfolio value is tied to \(c.label).")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Text(c.guidance)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(HobbyIQTheme.Colors.warning.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
            .padding(16)
            .hiqCard()
        }
    }

    // MARK: - Quality

    private var qualityCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Card Quality", subtitle: "By portfolio value")
            ForEach(result.qualityBuckets) { b in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(b.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        Spacer()
                        Text("\(Int(b.valueShare * 100))%")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(qualityTint(b.tier))
                    }
                    Text(b.blurb)
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(b.cardCount) \(b.cardCount == 1 ? "card" : "cards") · \(wholeUSDString(b.value))")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                            Capsule().fill(qualityTint(b.tier))
                                .frame(width: max(2, geo.size.width * min(1, b.valueShare)))
                        }
                    }
                    .frame(height: 5)
                }
            }
        }
        .padding(16)
        .hiqCard()
    }

    private func qualityTint(_ tier: String) -> Color {
        switch tier {
        case "cornerstone": return HobbyIQTheme.Colors.hobbyGreen
        case "strongHold": return HobbyIQTheme.Colors.successGreen
        case "market": return HobbyIQTheme.Colors.electricBlue
        default: return HobbyIQTheme.Colors.warning
        }
    }

    // MARK: - Recommendations

    @ViewBuilder
    private var recommendationsCard: some View {
        if result.recommendations.isEmpty == false {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("HobbyIQ Recommendations", subtitle: nil)
                ForEach(result.recommendations) { r in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: icon(for: r.kind))
                            .font(.caption)
                            .foregroundStyle(r.kind == "strength" ? HobbyIQTheme.Colors.successGreen
                                                                  : HobbyIQTheme.Colors.electricBlue)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(r.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            Text(r.detail)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(16)
            .hiqCard()
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "allocation": return "chart.pie.fill"
        case "concentration": return "exclamationmark.triangle.fill"
        case "quality": return "star.fill"
        case "scarcity": return "diamond.fill"
        case "consolidation": return "arrow.triangle.merge"
        default: return "checkmark.seal.fill"
        }
    }

    // MARK: - Upgrades

    @ViewBuilder
    private var upgradeCard: some View {
        if let u = result.upgradeOpportunities.first {
            VStack(alignment: .leading, spacing: 10) {
                sectionTitle("Upgrade Opportunities", subtitle: nil)
                Text("You own \(u.cardCount) cards between \(wholeUSDString(u.lowValue)) and \(wholeUSDString(u.highValue)).")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Text("Combined value: \(wholeUSDString(u.combinedValue))")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen)
                Text(u.insight)
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Own fewer cards. Own better cards.")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.hobbyGreen.opacity(0.9))
                    .padding(.top, 2)
            }
            .padding(16)
            .hiqCard()
        }
    }

    // MARK: - Caveat

    /// Honesty rail. When a meaningful slice has no readable print run, the
    /// numbers above are softer than they look and the screen should say so
    /// rather than let a confident donut imply otherwise.
    @ViewBuilder
    private var dataCaveat: some View {
        if result.unknownScarcityValueShare > 0.20 {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "info.circle")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("\(Int(result.unknownScarcityValueShare * 100))% of portfolio value has no readable print run on the card record, so its scarcity is estimated from era, grade and product rather than a serial number.")
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Shared

    private func sectionTitle(_ title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.headline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            if let subtitle {
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
