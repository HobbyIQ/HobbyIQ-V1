//
//  PortfolioAdvancedViews.swift
//  HobbyIQ
//

import SwiftUI

// MARK: - Portfolio Health Card (inline, no gate)

struct PortfolioHealthCard: View {
    @State private var health: PortfolioHealthResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summaryRow

            if isExpanded {
                expandedDetail
                    .padding(.top, 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        .task { await load() }
    }

    // MARK: - Always-visible summary

    private var summaryRow: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.22)) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "heart.text.square")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)

                Text("Health")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                Spacer()

                if isLoading && health == nil {
                    ProgressView()
                        .tint(HobbyIQTheme.Colors.electricBlue)
                        .controlSize(.small)
                } else if let h = health {
                    HStack(spacing: 8) {
                        statusBadge(for: h)
                        if let score = h.score {
                            Text(String(format: "%.0f", score))
                                .font(.title3.weight(.bold).monospacedDigit())
                                .foregroundStyle(healthScoreColor(score))
                            Text("/ 100")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                } else if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.danger)
                        .lineLimit(1)
                }

                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    .animation(.easeInOut(duration: 0.22), value: isExpanded)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Hide health breakdown" : "Show health breakdown")
    }

    // MARK: - Expanded detail

    @ViewBuilder
    private var expandedDetail: some View {
        if let h = health {
            VStack(alignment: .leading, spacing: 12) {
                if let score = h.score {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 6)
                                .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                                .frame(height: 10)
                            RoundedRectangle(cornerRadius: 6)
                                .fill(healthScoreColor(score))
                                .frame(width: geo.size.width * min(max(score / 100, 0), 1), height: 10)
                        }
                    }
                    .frame(height: 10)
                }

                if let total = h.totalHoldings {
                    Text("\(total) holdings tracked")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }

                HStack(spacing: 12) {
                    if let concentration = h.concentrationRisk {
                        riskPill(
                            label: "Concentration",
                            value: concentration,
                            help: "How much of your value sits in a small number of cards. Higher % means one bad move on a top holding hurts more — diversifying lowers it."
                        )
                    }
                    if let stale = h.staleDataRisk {
                        riskPill(
                            label: "Stale Data",
                            value: stale,
                            help: "Share of holdings whose pricing hasn't refreshed lately. Higher % means today's values are based on older comps — running Reprice All brings it down."
                        )
                    }
                    if let downside = h.downsideRisk {
                        riskPill(
                            label: "Downside",
                            value: downside,
                            help: "Estimated exposure if the cards trending down keep falling. Higher % means a larger share of your value is in cards with negative momentum."
                        )
                    }
                }
            }
        } else if isLoading {
            HStack(spacing: 10) {
                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                Text("Checking health...")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
            }
        } else if let error {
            Text(error)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.danger)
        }
    }

    // MARK: - Status word

    private func statusBadge(for h: PortfolioHealthResponse) -> some View {
        let status = statusWord(for: h)
        return Text(status.label)
            .font(.caption.weight(.bold))
            .foregroundStyle(status.color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(status.color.opacity(0.16))
            .clipShape(Capsule(style: .continuous))
    }

    private struct HealthStatus {
        let label: String
        let color: Color
    }

    private func statusWord(for h: PortfolioHealthResponse) -> HealthStatus {
        let concentration = h.concentrationRisk ?? 0
        let stale = h.staleDataRisk ?? 0
        let downside = h.downsideRisk ?? 0
        let score = h.score ?? 0

        if concentration > 0.6 {
            return HealthStatus(label: "Concentrated", color: HobbyIQTheme.Colors.warning)
        }
        if stale > 0.6 {
            return HealthStatus(label: "Stale", color: HobbyIQTheme.Colors.warning)
        }
        if downside > 0.6 {
            return HealthStatus(label: "At Risk", color: HobbyIQTheme.Colors.danger)
        }
        if score >= 70 {
            return HealthStatus(label: "Healthy", color: HobbyIQTheme.Colors.successGreen)
        }
        if score >= 40 {
            return HealthStatus(label: "Watch", color: HobbyIQTheme.Colors.warning)
        }
        return HealthStatus(label: "At Risk", color: HobbyIQTheme.Colors.danger)
    }

    // MARK: - Risk pill

    private func riskPill(label: String, value: Double, help: String) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                HIQHelpButton(title: label, message: help)
            }
            Text(String(format: "%.0f%%", value * 100))
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(riskColor(value))
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.vertical, 10)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    private func healthScoreColor(_ score: Double) -> Color {
        if score >= 70 { return HobbyIQTheme.Colors.successGreen }
        if score >= 40 { return HobbyIQTheme.Colors.warning }
        return HobbyIQTheme.Colors.danger
    }

    private func riskColor(_ value: Double) -> Color {
        if value <= 0.3 { return HobbyIQTheme.Colors.successGreen }
        if value <= 0.6 { return HobbyIQTheme.Colors.warning }
        return HobbyIQTheme.Colors.danger
    }

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            health = try await APIService.shared.fetchPortfolioHealth()
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Calibration View (gated: predictions / collector+)

struct CalibrationView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var report: CalibrationReportResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        Text("Loading calibration...")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                    }
                }

                if let error {
                    portfolioErrorBanner(error)
                }

                if let r = report {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack(spacing: 8) {
                                Image(systemName: "scope")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                                Text("Pricing Calibration")
                                    .font(HobbyIQTheme.Typography.cardTitle)
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }

                            if let sample = r.sampleCount {
                                portfolioDataRow(label: "Sample Count", value: "\(sample)")
                            }
                            if let mape = r.meanAbsolutePctError {
                                HIQMetricLabel(
                                    title: "Prediction Accuracy (MAPE)",
                                    value: String(format: "%.1f%%", mape * 100),
                                    help: "Mean Absolute % Error — how far off, on average, our price predictions land. Lower is better. Under 10% is strong; 10–20% is typical; over 20% means predictions have been swingy."
                                )
                            }
                        }
                        .padding(HobbyIQTheme.Spacing.medium)
                        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                        .overlay(
                            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
                    }
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }
        .background(HobbyIQBackground())
        .navigationTitle("Calibration")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            report = try await APIService.shared.fetchCalibration()
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Weekly Brief View (gated: predictions / collector+)

struct WeeklyBriefView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var brief: WeeklyBriefResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @State private var feedbackStates: [String: String] = [:]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                        Text("Loading weekly brief...")
                            .font(.subheadline)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                    }
                }

                if let error {
                    portfolioErrorBanner(error)
                }

                if let b = brief {
                    headlineCard(b)
                    summaryCard(b)

                    if let winners = b.topWinners, !winners.isEmpty {
                        moverSection(title: "Top Winners", icon: "arrow.up.circle.fill", tint: HobbyIQTheme.Colors.successGreen, movers: winners)
                    }
                    if let losers = b.topLosers, !losers.isEmpty {
                        moverSection(title: "Top Losers", icon: "arrow.down.circle.fill", tint: HobbyIQTheme.Colors.danger, movers: losers)
                    }

                    if let recs = b.recommendations, !recs.isEmpty {
                        recommendationsSection(recs)
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Weekly Brief")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
        .task { await load() }
    }

    private func headlineCard(_ b: WeeklyBriefResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let period = b.period {
                Text(period.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .tracking(0.8)
            }
            if let headline = b.headline {
                Text(headline)
                    .font(HobbyIQTheme.Typography.title)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let gen = b.generatedAt {
                Text("Generated: \(gen)")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    @ViewBuilder
    private func summaryCard(_ b: WeeklyBriefResponse) -> some View {
        if let s = b.summary {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "chart.bar.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Text("Summary")
                        .font(HobbyIQTheme.Typography.cardTitle)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }

                if let holdings = s.holdings {
                    portfolioDataRow(label: "Holdings", value: "\(holdings)")
                }
                if let alerts = s.alerts {
                    portfolioDataRow(label: "Alerts", value: "\(alerts)")
                }
                if let critical = s.criticalAlerts {
                    portfolioDataRow(label: "Critical Alerts", value: "\(critical)")
                }
                if let feedback = s.feedbackEvents {
                    HIQMetricLabel(
                        title: "Feedback Events",
                        value: "\(feedback)",
                        help: "How many of this week's recommendations you acted on (followed or dismissed). Used to tune the recommendation engine to your style over time."
                    )
                }
                if let followRate = s.recommendationFollowRatePct {
                    HIQMetricLabel(
                        title: "Follow Rate",
                        value: String(format: "%.0f%%", followRate),
                        help: "Share of recommendations you've followed instead of dismissed. Higher means the suggestions are matching what you'd already do — lower means we're suggesting moves you tend to skip."
                    )
                }
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
        }
    }

    private func moverSection(title: String, icon: String, tint: Color, movers: [WeeklyBriefMover]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            ForEach(movers) { mover in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(mover.playerName ?? "Unknown")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        if let cardTitle = mover.cardTitle {
                            Text(cardTitle)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        if let pct = mover.movePct {
                            Text(String(format: "%+.1f%%", pct))
                                .font(.subheadline.weight(.bold).monospacedDigit())
                                .foregroundStyle(tint)
                        }
                        if let value = mover.latestValue {
                            Text(value.currencyStringNoCents)
                                .font(.caption.weight(.medium).monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                }
                .padding(10)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func recommendationsSection(_ recs: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "lightbulb.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text("Recommendations")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            ForEach(Array(recs.enumerated()), id: \.offset) { index, rec in
                VStack(alignment: .leading, spacing: 8) {
                    Text(rec)
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        .fixedSize(horizontal: false, vertical: true)

                    let key = "rec_\(index)"
                    if let state = feedbackStates[key] {
                        Text(state == "followed" ? "Followed" : state == "ignored" ? "Dismissed" : "Noted")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                    } else {
                        HStack(spacing: 8) {
                            Button {
                                Task { await sendFeedback(rec: rec, action: "followed", key: key) }
                            } label: {
                                Label("Follow", systemImage: "hand.thumbsup")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(HobbyIQTheme.Colors.successGreen.opacity(0.12))
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)

                            Button {
                                Task { await sendFeedback(rec: rec, action: "ignored", key: key) }
                            } label: {
                                Label("Dismiss", systemImage: "hand.thumbsdown")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.3))
                                    .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(10)
                .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func sendFeedback(rec: String, action: String, key: String) async {
        do {
            _ = try await APIService.shared.submitRecommendationFeedback(
                request: RecommendationFeedbackRequest(
                    holdingId: "",
                    recommendation: rec,
                    actionTaken: action,
                    notes: nil
                )
            )
            feedbackStates[key] = action
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }

    private func load() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            brief = try await APIService.shared.fetchWeeklyBrief()
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Batch Reprice View (gated: predictions / collector+)

struct BatchRepriceView: View {
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @State private var result: BatchRepriceResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showUpgradePaywall = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Batch Reprice")
                        .font(HobbyIQTheme.Typography.title)
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Text("Refresh pricing for all holdings in your portfolio.")
                        .font(HobbyIQTheme.Typography.body)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(HobbyIQTheme.Spacing.medium)
                .background(HobbyIQTheme.Colors.cardNavy)
                .overlay(
                    RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                        .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.0)
                )
                .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))

                HIQPrimaryButton(title: isLoading ? "Repricing..." : "Reprice All", systemImage: "arrow.triangle.2.circlepath") {
                    Task { await runReprice() }
                }
                .disabled(isLoading)

                if let error {
                    portfolioErrorBanner(error)
                }

                if let r = result {
                    repriceResultCard(r)
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationTitle("Batch Reprice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .lockedOverlay(
            feature: GatedFeature.predictions,
            subscriptionManager: sessionViewModel.subscriptionManager
        ) {
            showUpgradePaywall = true
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.predictions)
            )
        }
    }

    private func repriceResultCard(_ r: BatchRepriceResponse) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.successGreen)
                Text("Reprice Complete")
                    .font(HobbyIQTheme.Typography.cardTitle)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let requested = r.requested {
                portfolioDataRow(label: "Requested", value: "\(requested)")
            }
            if let repriced = r.repriced {
                portfolioDataRow(label: "Repriced", value: "\(repriced)")
            }
            if let skipped = r.skipped {
                portfolioDataRow(label: "Skipped", value: "\(skipped)")
            }
            if let examined = r.examined {
                portfolioDataRow(label: "Examined", value: "\(examined)")
            }
            if let freshSkipped = r.freshSkipped {
                portfolioDataRow(label: "Fresh (Skipped)", value: "\(freshSkipped)")
            }
            if let throttled = r.throttled, throttled {
                Text("Throttled — try again later")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
            }
            if let reason = r.reason {
                portfolioDataRow(label: "Reason", value: reason)
            }
            if let gates = r.gates {
                if let minConf = gates.minPricingConfidence {
                    portfolioDataRow(label: "Min Confidence Gate", value: String(format: "%.0f%%", minConf * 100))
                }
                if let minComps = gates.minCompsUsed {
                    portfolioDataRow(label: "Min Comps Gate", value: "\(minComps)")
                }
            }

            if let updates = r.updates, !updates.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("UPDATES")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.8)

                    ForEach(updates) { update in
                        HStack {
                            Text(update.id.prefix(12) + "…")
                                .font(.caption.weight(.medium).monospacedDigit())
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .lineLimit(1)
                            Spacer()
                            if let status = update.status {
                                Text(status)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(repriceStatusColor(status))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(repriceStatusColor(status).opacity(0.15))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }
            }
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private func repriceStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "repriced": return HobbyIQTheme.Colors.successGreen
        case "skipped", "fresh": return HobbyIQTheme.Colors.warning
        case "error": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    private func runReprice() async {
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            result = try await APIService.shared.runBatchReprice()
        } catch {
            self.error = APIService.errorMessage(from: error)
        }
    }
}

// MARK: - Shared Helpers

fileprivate func portfolioDataRow(label: String, value: String) -> some View {
    HStack {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        Spacer()
        Text(value)
            .font(.subheadline.weight(.bold).monospacedDigit())
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
    }
}

fileprivate func portfolioErrorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(HobbyIQTheme.Colors.danger)
        Text(message)
            .font(.footnote)
            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(HobbyIQTheme.Colors.danger.opacity(0.25))
    .overlay(
        RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
            .stroke(HobbyIQTheme.Colors.danger.opacity(0.3), lineWidth: 2.0)
    )
    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
}
