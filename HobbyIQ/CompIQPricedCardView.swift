//
//  CompIQPricedCardView.swift
//  HobbyIQ
//

import SwiftUI
import Charts
import os

struct CompIQPricedCardView: View {
    let hit: CompIQVariantHit
    @State private var priceResponse: CompIQPriceByIdResponse?
    @State private var isLoading = false
    @State private var error: String?
    @State private var selectedGrade: GradeOption = .raw
    @State private var fetchTask: Task<Void, Never>?
    @State private var showLayerBreakdown = false
    @State private var segmentTrajectoryFull: SegmentTrajectoryFull?
    @State private var isLoadingFullTrendIQ = false
    @State private var showGradePremium = false
    @State private var showSellWindow = false
    @State private var showCompsByPlayer = false
    @State private var showWhatIf = false
    @State private var showUpgradePaywall = false
    @EnvironmentObject private var sessionViewModel: AppSessionViewModel
    @Environment(\.dismiss) private var dismiss
    private var skipFetch: Bool = false

    private let logger = Logger(subsystem: "com.compiq.app", category: "CompIQ")

    init(hit: CompIQVariantHit, previewResponse: CompIQPriceByIdResponse? = nil, initialGrade: GradeOption? = nil) {
        self.hit = hit
        if let previewResponse {
            self._priceResponse = State(initialValue: previewResponse)
            self.skipFetch = true
        }
        if let initialGrade {
            self._selectedGrade = State(initialValue: initialGrade)
        }
    }

    /// Maps a backend cert candidate's (gradeCompany, gradeValue) pair to the
    /// matching GradeOption so a comped result lands grade-matched on first
    /// paint. Returns nil when the grade falls outside the picker's known
    /// options — caller should leave `selectedGrade` at its default (.raw).
    static func gradeOption(forCompany company: String?, value: Double?) -> GradeOption? {
        guard let company = company?.uppercased(), let value else { return nil }
        switch (company, value) {
        case ("PSA", 9):    return .psa9
        case ("PSA", 10):   return .psa10
        case ("BGS", 9.5):  return .bgs95
        default:            return nil
        }
    }

    enum GradeOption: String, CaseIterable, Identifiable {
        case raw = "Raw"
        case psa9 = "PSA 9"
        case psa10 = "PSA 10"
        case bgs95 = "BGS 9.5"

        var id: String { rawValue }

        var gradeCompany: String? {
            switch self {
            case .raw: return nil
            case .psa9, .psa10: return "PSA"
            case .bgs95: return "BGS"
            }
        }

        var gradeValue: Double? {
            switch self {
            case .raw: return nil
            case .psa9: return 9
            case .psa10: return 10
            case .bgs95: return 9.5
            }
        }
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: HobbyIQTheme.Spacing.large) {
                headerCard
                contentSection
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
            .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
        }
        .background(HobbyIQBackground())
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Back")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
                .buttonStyle(.plain)
            }
        }
        .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            guard !skipFetch else { return }
            await fetchPrice()
            if sessionViewModel.subscriptionManager.has(GatedFeature.trendIQLayer3Full) {
                await fetchTrendIQFull()
            }
        }
        .onChange(of: selectedGrade) { _, _ in
            guard !skipFetch else { return }
            fetchTask?.cancel()
            fetchTask = Task {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                await fetchPrice()
                if sessionViewModel.subscriptionManager.has(GatedFeature.trendIQLayer3Full) {
                    await fetchTrendIQFull()
                }
            }
        }
        .sheet(isPresented: $showLayerBreakdown) {
            if let trendIQ = priceResponse?.trendIQ {
                TrendIQLayerBreakdownView(trendIQ: trendIQ)
            }
        }
        .sheet(isPresented: $showGradePremium) {
            GradePremiumView(
                playerName: hit.player ?? "",
                cardYear: hit.year,
                product: hit.set,
                parallel: hit.variant
            )
            .environmentObject(sessionViewModel)
        }
        .sheet(isPresented: $showSellWindow) {
            SellWindowView(
                playerName: hit.player ?? "",
                cardYear: hit.year,
                sport: nil
            )
            .environmentObject(sessionViewModel)
        }
        .sheet(isPresented: $showCompsByPlayer) {
            CompsByPlayerView(
                playerName: hit.player ?? "",
                product: hit.set,
                cardYear: hit.year
            )
        }
        .sheet(isPresented: $showWhatIf) {
            WhatIfView(
                playerName: hit.player ?? "",
                cardYear: hit.year,
                product: hit.set,
                parallel: hit.variant,
                gradeCompany: selectedGrade.gradeCompany,
                gradeValue: selectedGrade.gradeValue
            )
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(
                sessionViewModel: sessionViewModel,
                suggestedTier: GatedFeature.minimumTier(for: GatedFeature.trendIQComposite)
            )
        }
    }

    // MARK: - Header (integrated grade picker)

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(hit.resolvedLabel)
                .font(HobbyIQTheme.Typography.title)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .fixedSize(horizontal: false, vertical: true)

            gradePicker
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hiqCard()
    }

    // MARK: - Grade Picker

    private var gradePicker: some View {
        HStack(spacing: 6) {
            ForEach(GradeOption.allCases) { grade in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        selectedGrade = grade
                    }
                } label: {
                    Text(grade.rawValue)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(
                            selectedGrade == grade
                                ? HobbyIQTheme.Colors.pureWhite
                                : HobbyIQTheme.Colors.mutedText
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(
                            selectedGrade == grade
                                ? HobbyIQTheme.Colors.electricBlue
                                : HobbyIQTheme.Colors.steelGray.opacity(0.4)
                        )
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(
                                    selectedGrade == grade
                                        ? HobbyIQTheme.Colors.electricBlue.opacity(0.5)
                                        : Color.clear,
                                    lineWidth: 1.5
                                )
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(HobbyIQTheme.Colors.cardNavy.opacity(0.8))
        .clipShape(Capsule())
    }

    // MARK: - Content

    @ViewBuilder
    private var contentSection: some View {
        if let error {
            errorBanner(error)
        }

        if isLoading {
            loadingCard
        }

        if let response = priceResponse {
            if response.hasInsufficientComps {
                insufficientCompsCard
            } else {
                // Hero image — CF-B addition (2026-06-08). Sits above
                // the FMV card so the user has a visual anchor for the
                // card identity before the pricing rolls in.
                cardHeroImageCard(response)

                // Hero
                fmvCard(response)

                // Verdict
                verdictPill(response)

                // Warning
                variantWarningBanner(response)

                // TrendIQ (leads when available)
                trendIQSection(response)

                // Segment Trajectory Full (pro_seller gate)
                segmentTrajectoryFullSection

                // Advanced pricing tools
                advancedToolsSection(response)

                // Market Analysis group
                cardGroup(title: "Market Analysis", icon: "chart.bar.fill") {
                    predictedPriceContent(response)
                    zonesCard(response)
                    buyWindowContent(response)
                    confidenceContent(response)
                }

                // Trends group
                cardGroup(title: "Trends", icon: "arrow.triangle.swap") {
                    trendContent(response)
                    trendIQDetailContent(response)
                    broaderTrendContent(response)
                }

                // Regime group — CF-COMP-DETAIL-EXPAND (2026-06-07).
                // Only renders when the backend produced regime
                // classification output; insufficient_data short-circuits
                // skip the section so we don't show empty rows.
                if response.regime != nil || response.regimeDiagnostics != nil {
                    cardGroup(title: "Regime", icon: "waveform.path.ecg") {
                        regimeContent(response)
                    }
                }

                // Strategy group
                cardGroup(title: "Strategy", icon: "target") {
                    exitStrategyContent(response)
                    freshnessContent(response)
                }

                // CF-PRICEHISTORY-60D (2026-06-10): 60d chart series for
                // the comp page. Rendered as its own section card so the
                // chart precedes the "Recent sales" table inside
                // Reference Data (chart-then-table pattern). The view fn
                // self-suppresses (returns EmptyView) when priceHistory
                // has fewer than 2 points — never a broken axis.
                if let history = response.priceHistory, history.count >= 2 {
                    cardGroup(title: "Price History", icon: "chart.xyaxis.line") {
                        priceHistoryContent(response)
                    }
                }

                // Reference Data group
                cardGroup(title: "Reference Data", icon: "doc.text.magnifyingglass") {
                    explanationContent(response)
                    compsContent(response)
                    excludedCompsContent(response)
                }
            }
        }
    }

    // MARK: - FMV Hero Card

    private func fmvCard(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(spacing: HobbyIQTheme.Spacing.medium) {
            // FMV section
            VStack(spacing: 8) {
                sectionHeader(title: "Fair Market Value")

                Text(response.formattedFMV)
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [HobbyIQTheme.Colors.pureWhite, HobbyIQTheme.Colors.electricBlue.opacity(0.85)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.4), radius: 16, x: 0, y: 0)

                // Metadata row
                HStack(spacing: 12) {
                    if let high = response.marketTier?.high {
                        metadataChip(label: "High", value: high.formatted(.currency(code: "USD")))
                    }
                    if let grade = response.gradeUsed {
                        metadataChip(label: "Grade", value: grade)
                    }
                    if let comps = response.compsUsed {
                        // CF-COMP-DETAIL-EXPAND (2026-06-07): show "N of M"
                        // when compsAvailable is known so the user sees the
                        // condition-filter delta. Falls back to bare count
                        // for older responses that don't carry the
                        // denominator.
                        metadataChip(
                            label: "Comps",
                            value: response.compsAvailable.map { available in
                                available >= comps ? "\(comps) of \(available)" : "\(comps)"
                            } ?? "\(comps)"
                        )
                    }
                }
                .padding(.top, 2)
            }
            .frame(maxWidth: .infinity)

            // Quick Sale / Premium tiles
            if response.quickSaleValue != nil || response.premiumValue != nil {
                HStack(spacing: 10) {
                    if let quick = response.quickSaleValue {
                        priceTileBlock(
                            label: "QUICK SALE",
                            value: quick.formatted(.currency(code: "USD")),
                            icon: "bolt.fill",
                            tint: HobbyIQTheme.Colors.successGreen
                        )
                    }

                    if let premium = response.premiumValue {
                        priceTileBlock(
                            label: "PREMIUM",
                            value: premium.formatted(.currency(code: "USD")),
                            icon: "arrow.up.circle.fill",
                            tint: HobbyIQTheme.Colors.danger
                        )
                    }
                }
            }
        }
        .hiqHeroCard()
    }

    private func priceTileBlock(label: String, value: String, icon: String, tint: Color) -> some View {
        VStack(spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tint.opacity(0.7))
                Text(label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.8)
            }

            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(tint.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Verdict Pill

    @ViewBuilder
    private func verdictPill(_ response: CompIQPriceByIdResponse) -> some View {
        if let summary = response.summary, summary.isEmpty == false {
            HStack(spacing: 10) {
                Image(systemName: verdictIcon(response.verdictText))
                    .font(.headline)
                    .foregroundStyle(verdictColor(response.verdictText))
                Text(summary)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(HobbyIQTheme.Spacing.medium)
            .background(verdictColor(response.verdictText).opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(verdictColor(response.verdictText).opacity(0.3), lineWidth: 2.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: verdictColor(response.verdictText).opacity(0.2), radius: 8, x: 0, y: 4)
        }
    }

    // MARK: - Zones

    private func zonesCard(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(spacing: 10) {
            sectionHeader(title: "Zones")

            HStack(spacing: 8) {
                zoneChip(
                    title: Labels.buyZone,
                    low: response.buyZone?.low,
                    high: response.buyZone?.high,
                    tint: HobbyIQTheme.Colors.successGreen
                )
                zoneChip(
                    title: "Hold",
                    low: response.holdZone?.low,
                    high: response.holdZone?.high,
                    tint: HobbyIQTheme.Colors.warning
                )
                zoneChip(
                    title: Labels.sellZone,
                    low: response.sellZone?.low,
                    high: response.sellZone?.high,
                    tint: HobbyIQTheme.Colors.danger
                )
            }
        }
    }

    private func zoneChip(title: String, low: Double?, high: Double?, tint: Color) -> some View {
        VStack(spacing: 8) {
            // Zone label with colored dot
            HStack(spacing: 5) {
                Circle()
                    .fill(tint)
                    .frame(width: 8, height: 8)
                    .shadow(color: tint.opacity(0.5), radius: 3, x: 0, y: 0)
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(0.6)
            }

            // Price range
            if let low, let high {
                VStack(spacing: 2) {
                    Text(low.formatted(.currency(code: "USD")))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                    Text("to")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
                    Text(high.formatted(.currency(code: "USD")))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .foregroundStyle(tint)
                }
            } else if let low {
                Text(low.formatted(.currency(code: "USD")))
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(tint)
            } else {
                Text("—")
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(tint.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - Buy Window (inner content, no card wrapper)

    @ViewBuilder
    private func buyWindowContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let bw = response.buyWindow, bw.label != nil || bw.score != nil {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Buy Window")

                HStack(spacing: 12) {
                    if let label = bw.label {
                        Text(label)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(buyWindowColor(bw.score))
                    }
                    Spacer()
                    if let score = bw.score {
                        Text(String(format: "%.0f", score))
                            .font(.headline.weight(.bold))
                            .foregroundStyle(buyWindowColor(score))
                    }
                }

                if let reasons = bw.reasons, reasons.isEmpty == false {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(reasons, id: \.self) { reason in
                            HStack(alignment: .top, spacing: 6) {
                                Circle()
                                    .fill(HobbyIQTheme.Colors.electricBlue)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                Text(reason)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Confidence (inner content)

    private func confidenceContent(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: Labels.confidence)

            let conf = response.confidence ?? 0

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(conf.formatted(.percent.precision(.fractionLength(0))))
                    .font(HobbyIQTheme.Typography.statNumber)
                    .foregroundStyle(confidenceBarColor(conf))
                Text("confidence")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                        .frame(height: 12)

                    RoundedRectangle(cornerRadius: 6)
                        .fill(
                            LinearGradient(
                                colors: [confidenceBarColor(conf), confidenceBarColor(conf).opacity(0.7)],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: geo.size.width * min(max(conf, 0), 1), height: 12)
                        .shadow(color: confidenceBarColor(conf).opacity(0.4), radius: 6, x: 0, y: 0)
                }
            }
            .frame(height: 12)
        }
    }

    // MARK: - Trend (inner content)

    @ViewBuilder
    private func trendContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let trend = response.trendAnalysis {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Trend")

                HStack(spacing: 12) {
                    Image(systemName: trendArrow(trend.marketDirection))
                        .font(.title2.weight(.bold))
                        .foregroundStyle(trendColor(trend.marketDirection))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(trend.marketDirection?.capitalized ?? "Flat")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

                        if let pct = response.trendPercent {
                            Text(String(format: "%+.1f%%", pct))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(trendColor(trend.marketDirection))
                        }
                    }

                    Spacer()

                    if let liquidity = trend.liquidity, liquidity.isEmpty == false {
                        Text(liquidity)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.5))
                            .clipShape(Capsule())
                    }
                }
            }
        }
    }

    // MARK: - Broader Trend (inner content)

    @ViewBuilder
    private func broaderTrendContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let bt = response.broaderTrend, bt.label != nil || bt.direction != nil {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Broader Trend")

                HStack(spacing: 10) {
                    Image(systemName: trendArrow(bt.direction))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(trendColor(bt.direction))
                    VStack(alignment: .leading, spacing: 2) {
                        if let label = bt.label {
                            Text(label)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        if let note = bt.note {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                    Spacer()
                }
            }
        }
    }

    // MARK: - TrendIQ

    @ViewBuilder
    private func trendIQSection(_ response: CompIQPriceByIdResponse) -> some View {
        if let trendIQ = response.trendIQ {
            cardGroup(title: "TrendIQ", icon: "waveform.path.ecg") {
                trendIQHeadline(trendIQ)
                trendIQCoverageRow(trendIQ)
            }
            .lockedOverlay(
                feature: GatedFeature.trendIQComposite,
                subscriptionManager: sessionViewModel.subscriptionManager
            ) {
                showUpgradePaywall = true
            }
        }
    }

    private func trendIQHeadline(_ trendIQ: TrendIQResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Signal")

            HStack(spacing: 12) {
                Image(systemName: trendIQDirectionIcon(trendIQ.direction))
                    .font(.title2.weight(.bold))
                    .foregroundStyle(trendIQDirectionColor(trendIQ.direction))

                VStack(alignment: .leading, spacing: 2) {
                    if let composite = trendIQ.composite {
                        // TODO: post-diagnosis decision — raw percentage for now
                        Text(String(format: "%.1f%%", composite * 100))
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(trendIQDirectionColor(trendIQ.direction))
                    }

                    if let direction = trendIQ.direction {
                        Text(direction.capitalized)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                Spacer()

                if let impliedPct = trendIQ.impliedPct {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(String(format: "%+.1f%%", impliedPct))
                            .font(.headline.weight(.bold))
                            .foregroundStyle(trendIQDirectionColor(trendIQ.direction))
                        Text("implied")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }

            Button {
                showLayerBreakdown = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chart.bar.doc.horizontal")
                        .font(.caption.weight(.semibold))
                    Text("Layer Breakdown")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func trendIQCoverageRow(_ trendIQ: TrendIQResponse) -> some View {
        if let coverage = trendIQ.coverage {
            HStack(spacing: 8) {
                let display = trendIQCoverageDisplay(coverage)
                Image(systemName: display.icon)
                    .font(.caption)
                    .foregroundStyle(display.color)
                Text(display.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(display.color)
                Spacer()
                if let weights = trendIQ.weights {
                    Text(trendIQWeightsSummary(weights))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
        }
    }

    private func trendIQDirectionIcon(_ direction: String?) -> String {
        switch direction?.lowercased() {
        case "rising": return "arrow.up.right"
        case "falling": return "arrow.down.right"
        case "flat": return "arrow.right"
        case "stable": return "arrow.right"
        default: return "arrow.right"
        }
    }

    private func trendIQDirectionColor(_ direction: String?) -> Color {
        switch direction?.lowercased() {
        case "rising": return HobbyIQTheme.Colors.successGreen
        case "falling": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.warning
        }
    }

    private func trendIQCoverageDisplay(_ coverage: String) -> (label: String, icon: String, color: Color) {
        switch coverage.lowercased() {
        case "full":
            return ("Full coverage — all 3 layers active", "checkmark.seal.fill", HobbyIQTheme.Colors.successGreen)
        case "card_only":
            return ("Player + card layers active", "circle.lefthalf.filled", HobbyIQTheme.Colors.warning)
        case "no_segment":
            return ("Player + card layers active", "circle.lefthalf.filled", HobbyIQTheme.Colors.warning)
        case "player_only":
            return ("Player layer only", "person.fill", HobbyIQTheme.Colors.mutedText)
        case "no_card":
            return ("Player layer only — no card data", "person.fill", HobbyIQTheme.Colors.mutedText)
        default:
            return ("Coverage: \(coverage)", "questionmark.circle", HobbyIQTheme.Colors.mutedText)
        }
    }

    private func trendIQWeightsSummary(_ weights: TrendIQWeights) -> String {
        var parts: [String] = []
        if let p = weights.playerMomentum, p > 0 { parts.append("P:\(Int(p * 100))%") }
        if let c = weights.cardTrajectory, c > 0 { parts.append("C:\(Int(c * 100))%") }
        if let s = weights.segmentTrajectory, s > 0 { parts.append("S:\(Int(s * 100))%") }
        return parts.joined(separator: " ")
    }

    // MARK: - Exit Strategy (inner content)

    @ViewBuilder
    private func exitStrategyContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let exit = response.exitStrategy, exit.recommendedMethod != nil || exit.timingRecommendation != nil {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Exit Strategy")

                if let method = exit.recommendedMethod {
                    HStack {
                        Text("Method")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text(method)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let days = exit.expectedDaysToSell {
                    HStack {
                        Text("Expected Days to Sell")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text("\(days)")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let timing = exit.timingRecommendation {
                    Text(timing)
                        .font(.caption)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Explanation (inner content)

    @ViewBuilder
    private func explanationContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let bullets = response.explanation, bullets.isEmpty == false {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: Labels.howWeCompedIt)

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(bullets, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(HobbyIQTheme.Colors.electricBlue)
                                .frame(width: 6, height: 6)
                                .padding(.top, 7)
                            Text(line)
                                .font(.subheadline)
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if let quality = response.compQuality {
                    HStack(spacing: 6) {
                        Text("Comp Quality:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(quality)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let sufficiency = response.dataSufficiency {
                    HStack(spacing: 6) {
                        Text("Data:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(sufficiency)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let premium = response.graderPremium {
                    HStack(spacing: 6) {
                        Text("Grader Premium:")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text(String(format: "%.0f%%", premium * 100))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
        }
    }

    // MARK: - Recent Comps (inner content)

    /// CF-B (2026-06-08): per-mockup row layout —
    ///   thumbnail | [ price  saleTypeChip  · below market ]
    ///             | title · date  (single line, ellipsized)
    /// Header line: "Recent sales" left, "N of M" right (compsUsed of
    /// compsAvailable). Belt-and-suspenders: section is hidden entirely
    /// when there are no comps.
    @ViewBuilder
    private func compsContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let comps = response.recentComps, comps.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                compsHeader(response)
                VStack(spacing: 0) {
                    ForEach(Array(comps.enumerated()), id: \.element.id) { index, comp in
                        recentCompRow(comp, showsTopDivider: index > 0)
                    }
                }
            }
        }
    }

    /// "Recent sales" + "N of M" — only emits the ratio when both counts
    /// are non-nil so a partial response collapses to just the title.
    private func compsHeader(_ response: CompIQPriceByIdResponse) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Recent sales")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            if let used = response.compsUsed, let avail = response.compsAvailable {
                Text("\(used) of \(avail)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    // MARK: - Price History chart (CF-PRICEHISTORY-60D 2026-06-10)

    /// Auction amber — matches the inline literal in `saleTypeChip` so the
    /// chart legend reads as the same color the auction chip uses.
    /// Kept inline (not lifted to HobbyIQTheme) to scope this CF.
    private static let priceHistoryAuctionAmber = Color(hex: 0xE5B64A)

    /// Trend/reference line neutral. Subdued enough to read as a derived
    /// overlay, not a third data series.
    private static let priceHistoryNeutralLine =
        HobbyIQTheme.Colors.mutedText.opacity(0.6)

    /// 60-day comp-page price-history chart. Suppressed by caller when the
    /// series has fewer than 2 points. Within ≥2-point series, the trend
    /// line additionally requires ≥2 distinct x values; the reference line
    /// is only drawn when `marketTier.value` falls inside the padded y
    /// domain. Either may be absent on edge cases without breaking the
    /// chart — the points always render.
    @ViewBuilder
    private func priceHistoryContent(_ response: CompIQPriceByIdResponse) -> some View {
        let history: [PriceHistoryPoint] = (response.priceHistory ?? []).filter { p in
            p.parsedDate != nil && (p.price ?? 0) > 0
        }
        if history.count >= 2 {
            let prices = history.compactMap { $0.price }
            let yMinRaw = prices.min() ?? 0
            let yMaxRaw = prices.max() ?? 0
            let yPad = max((yMaxRaw - yMinRaw) * 0.10, 1.0)
            let yMin = max(0, yMinRaw - yPad)
            let yMax = yMaxRaw + yPad
            let dates = history.compactMap { $0.parsedDate }
            let xMin = dates.min() ?? Date()
            let xMax = dates.max() ?? Date()

            let regression = priceHistoryLeastSquares(history)
            let reference: Double? = {
                guard let v = response.marketTier?.value, v >= yMin, v <= yMax else { return nil }
                return v
            }()

            VStack(alignment: .center, spacing: 10) {
                priceHistoryHeader(response)
                priceHistoryLegend(showsTrend: regression != nil, showsReference: reference != nil)
                priceHistoryChart(
                    history: history,
                    yMin: yMin,
                    yMax: yMax,
                    xMin: xMin,
                    xMax: xMax,
                    regression: regression,
                    reference: reference
                )
                .frame(height: 210)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func priceHistoryHeader(_ response: CompIQPriceByIdResponse) -> some View {
        let grade = response.gradeUsed?.trimmingCharacters(in: .whitespaces)
        let subhead = (grade?.isEmpty == false)
            ? "\(grade!) · last 60 days"
            : "last 60 days"
        return Text(subhead)
            .font(.caption.weight(.medium))
            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            .frame(maxWidth: .infinity, alignment: .center)
    }

    private func priceHistoryLegend(showsTrend: Bool, showsReference: Bool) -> some View {
        HStack(spacing: 14) {
            priceHistoryLegendChip(
                color: HobbyIQTheme.Colors.electricBlue,
                shape: .circle,
                label: "BIN"
            )
            priceHistoryLegendChip(
                color: Self.priceHistoryAuctionAmber,
                shape: .triangle,
                label: "Auction"
            )
            if showsTrend {
                priceHistoryLegendDash(
                    color: Self.priceHistoryNeutralLine,
                    label: "Trend",
                    dotted: false
                )
            }
            if showsReference {
                priceHistoryLegendDash(
                    color: Self.priceHistoryNeutralLine,
                    label: "Market",
                    dotted: true
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private enum PriceHistoryLegendShape { case circle, triangle }

    private func priceHistoryLegendChip(
        color: Color, shape: PriceHistoryLegendShape, label: String
    ) -> some View {
        HStack(spacing: 5) {
            Group {
                if shape == .triangle {
                    Triangle().fill(color).frame(width: 9, height: 9)
                } else {
                    Circle().fill(color).frame(width: 8, height: 8)
                }
            }
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    private func priceHistoryLegendDash(
        color: Color, label: String, dotted: Bool
    ) -> some View {
        HStack(spacing: 5) {
            DashedLineSwatch(color: color, dotted: dotted)
                .frame(width: 18, height: 2)
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
    }

    /// The chart body itself. Pulled into its own fn so the parent stack
    /// reads cleanly + so the type-checker doesn't choke on a 200-line
    /// `some View` expression.
    @ViewBuilder
    private func priceHistoryChart(
        history: [PriceHistoryPoint],
        yMin: Double,
        yMax: Double,
        xMin: Date,
        xMax: Date,
        regression: (slope: Double, intercept: Double, xEpoch: Double)?,
        reference: Double?
    ) -> some View {
        Chart {
            ForEach(history) { p in
                if let date = p.parsedDate, let price = p.price {
                    if p.kind == .auction {
                        PointMark(
                            x: .value("Date", date),
                            y: .value("Price", price)
                        )
                        .symbol(.triangle)
                        .symbolSize(34)
                        .foregroundStyle(Self.priceHistoryAuctionAmber)
                    } else {
                        PointMark(
                            x: .value("Date", date),
                            y: .value("Price", price)
                        )
                        .symbol(.circle)
                        .symbolSize(34)
                        .foregroundStyle(
                            p.kind == .bin
                                ? HobbyIQTheme.Colors.electricBlue
                                : HobbyIQTheme.Colors.mutedText.opacity(0.7)
                        )
                    }
                }
            }

            if let regression {
                let yStart = regression.intercept
                    + regression.slope * (xMin.timeIntervalSince1970 - regression.xEpoch)
                let yEnd = regression.intercept
                    + regression.slope * (xMax.timeIntervalSince1970 - regression.xEpoch)
                LineMark(
                    x: .value("Date", xMin),
                    y: .value("Trend", yStart),
                    series: .value("series", "trend")
                )
                .foregroundStyle(Self.priceHistoryNeutralLine)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                LineMark(
                    x: .value("Date", xMax),
                    y: .value("Trend", yEnd),
                    series: .value("series", "trend")
                )
                .foregroundStyle(Self.priceHistoryNeutralLine)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }

            if let reference {
                RuleMark(y: .value("Market", reference))
                    .foregroundStyle(Self.priceHistoryNeutralLine)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
            }
        }
        .chartLegend(.hidden)
        .chartYScale(domain: yMin...yMax)
        .chartXScale(domain: xMin...xMax)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let n = value.as(Double.self) {
                        Text(n.formatted(.currency(code: "USD").precision(.fractionLength(0))))
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: .dateTime.month(.abbreviated).day())
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
            }
        }
    }

    /// Client-side least-squares: slope m = Σ((xi-x̄)(yi-ȳ)) / Σ((xi-x̄)²),
    /// intercept b = ȳ - m·x̄. Returns nil when fewer than 2 distinct x
    /// values are present (can't fit a line through coincident x's), or
    /// when the variance is zero (all-coincident data). Date offsets are
    /// computed against `xEpoch` (the min date's timeInterval) so the
    /// numbers stay in a sensible magnitude.
    private func priceHistoryLeastSquares(
        _ points: [PriceHistoryPoint]
    ) -> (slope: Double, intercept: Double, xEpoch: Double)? {
        let usable: [(x: Double, y: Double)] = points.compactMap { p in
            guard let d = p.parsedDate, let y = p.price else { return nil }
            return (d.timeIntervalSince1970, y)
        }
        let distinctXs = Set(usable.map { $0.x })
        guard distinctXs.count >= 2 else { return nil }
        let xEpoch = usable.map { $0.x }.min() ?? 0
        let xs = usable.map { $0.x - xEpoch }
        let ys = usable.map { $0.y }
        let n = Double(usable.count)
        let xMean = xs.reduce(0, +) / n
        let yMean = ys.reduce(0, +) / n
        var cov = 0.0
        var varX = 0.0
        for i in 0..<usable.count {
            let dx = xs[i] - xMean
            cov += dx * (ys[i] - yMean)
            varX += dx * dx
        }
        guard varX > 0 else { return nil }
        let slope = cov / varX
        // Translate back: the intercept we expose is at x = xEpoch (i.e.
        // raw timeInterval). So at any raw timeInterval xRaw, the fitted
        // y is intercept + slope * (xRaw - xEpoch).
        let intercept = yMean - slope * xMean
        return (slope: slope, intercept: intercept, xEpoch: xEpoch)
    }

    private func recentCompRow(_ comp: CompIQPriceRecentComp, showsTopDivider: Bool) -> some View {
        let isBelowMarket = comp.belowMarket == true
        return HStack(alignment: .center, spacing: 11) {
            compThumbnail(urlString: comp.imageUrl)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    if let price = comp.price {
                        Text(price.formatted(.currency(code: "USD")))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                    if let saleType = comp.saleType, saleType.isEmpty == false {
                        saleTypeChip(saleType)
                    }
                    if isBelowMarket {
                        Text("· below market")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Text(compTitleWithDate(title: comp.title, dateString: comp.relativeDate))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .opacity(isBelowMarket ? 0.78 : 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
        .overlay(alignment: .top) {
            if showsTopDivider {
                Rectangle()
                    .fill(HobbyIQTheme.Colors.steelGray.opacity(0.35))
                    .frame(height: 0.5)
            }
        }
    }

    /// CF-B (2026-06-08): "Excluded from value" — comps the engine dropped
    /// from valuation (damage, lot, please-read). Whole section recedes
    /// (opacity 0.5); the row keeps the inline mockup layout with a
    /// struck-through price and a red-tinted condition chip from `.label`.
    /// Suppressed entirely when `excludedComps` is nil or empty.
    @ViewBuilder
    private func excludedCompsContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let comps = response.excludedComps, comps.isEmpty == false {
            VStack(alignment: .leading, spacing: 6) {
                Text("Excluded from value")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .padding(.top, 4)
                VStack(spacing: 0) {
                    ForEach(Array(comps.enumerated()), id: \.element.id) { _, comp in
                        excludedCompRow(comp)
                    }
                }
            }
            .opacity(0.55)
        }
    }

    private func excludedCompRow(_ comp: CompIQPriceExcludedComp) -> some View {
        HStack(alignment: .center, spacing: 11) {
            compThumbnail(urlString: comp.imageUrl)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    if let price = comp.price {
                        Text(price.formatted(.currency(code: "USD")))
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .strikethrough(true, color: HobbyIQTheme.Colors.mutedText)
                    }
                    if let display = excludedLabelDisplay(comp.label) {
                        excludedLabelChip(display)
                    }
                }
                Text(compTitleWithDate(title: comp.title, dateString: comp.relativeDate))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9)
    }

    // MARK: - Card Hero Image (CF-B addition, 2026-06-08)

    /// Hero image for the priced-card detail. Sized to standard sports-
    /// card aspect (2.5:3.5) and centered. Reuses the same graceful
    /// neutral-card placeholder used for the comp rows so a missing or
    /// 404'd photo never surfaces a broken-image glyph.
    @ViewBuilder
    private func cardHeroImageCard(_ response: CompIQPriceByIdResponse) -> some View {
        HStack {
            Spacer(minLength: 0)
            cardHeroImage(urlString: response.cardImageUrl)
                .frame(width: 180, height: 252) // 2.5:3.5 → 180:252
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
    }

    private func cardHeroImage(urlString: String?) -> some View {
        Group {
            if let urlString, urlString.isEmpty == false, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .empty, .failure:
                        compThumbnailPlaceholder
                    @unknown default:
                        compThumbnailPlaceholder
                    }
                }
            } else {
                compThumbnailPlaceholder
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.45), lineWidth: 0.5)
        )
        .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.12), radius: 14, x: 0, y: 6)
    }

    // MARK: - Comp Thumbnail (shared by recent + excluded rows)

    /// AsyncImage with a graceful neutral-card placeholder on nil/load
    /// failure. NEVER shows a broken-image glyph — the eBay 225px thumbs
    /// can 404 after ~90d and that path needs to be silent.
    private func compThumbnail(urlString: String?) -> some View {
        Group {
            if let urlString, urlString.isEmpty == false, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .empty, .failure:
                        compThumbnailPlaceholder
                    @unknown default:
                        compThumbnailPlaceholder
                    }
                }
            } else {
                compThumbnailPlaceholder
            }
        }
        .frame(width: 40, height: 55)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.45), lineWidth: 0.5)
        )
    }

    private var compThumbnailPlaceholder: some View {
        Rectangle()
            .fill(HobbyIQTheme.Colors.steelGray.opacity(0.25))
    }

    /// "Buy It Now" → blue; "Auction" → amber. Anything else → neutral.
    /// Mockup pairing — light pastel pill, weight-matched dark text — is
    /// adapted to the app's dark theme via the same fg/bg.opacity recipe
    /// used elsewhere (AUTO/grade pills in the variant picker).
    @ViewBuilder
    private func saleTypeChip(_ raw: String) -> some View {
        let lower = raw.lowercased()
        let isAuction = lower.contains("auction")
        let isBIN = lower.contains("buy") || lower.contains("now")
        let (fg, bg): (Color, Color) = {
            if isAuction {
                let amber = Color(hex: 0xE5B64A)
                return (amber, amber.opacity(0.18))
            }
            if isBIN {
                return (HobbyIQTheme.Colors.electricBlue, HobbyIQTheme.Colors.electricBlue.opacity(0.18))
            }
            return (HobbyIQTheme.Colors.pureWhite.opacity(0.85), HobbyIQTheme.Colors.steelGray.opacity(0.35))
        }()
        Text(raw)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
    }

    /// Normalize the backend-emitted exclusion label to a display string.
    /// Known engine codes get a tightened user-facing form; anything else
    /// passes through unchanged so a new label code never disappears.
    /// nil/empty → nil → the chip is omitted from the row.
    private func excludedLabelDisplay(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), raw.isEmpty == false else {
            return nil
        }
        switch raw.lowercased() {
        case "seller-described damage": return "Damaged"
        case "please read":             return "Please read"
        default:                        return raw
        }
    }

    /// Condition chip on the excluded row — the mockup pairs damage/please-
    /// read tags with a red-tinted pill so the exclusion reason is clear.
    @ViewBuilder
    private func excludedLabelChip(_ raw: String) -> some View {
        Text(raw)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(HobbyIQTheme.Colors.danger)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(HobbyIQTheme.Colors.danger.opacity(0.18))
            .clipShape(Capsule())
    }

    /// Joins title + relative date with " · " when both present, gracefully
    /// degrades to whichever exists. Returns "" only when both are missing.
    private func compTitleWithDate(title: String?, dateString: String) -> String {
        let cleanTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let hasTitle = cleanTitle.isEmpty == false
        let cleanDate = dateString.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasDate = cleanDate.isEmpty == false && cleanDate.lowercased() != "unknown"
        switch (hasTitle, hasDate) {
        case (true, true):  return "\(cleanTitle) · \(cleanDate)"
        case (true, false): return cleanTitle
        case (false, true): return cleanDate
        case (false, false): return ""
        }
    }

    // MARK: - Freshness (inner content)

    @ViewBuilder
    private func freshnessContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let f = response.freshness, f.status != nil || f.daysSinceNewestComp != nil {
            HStack(spacing: 10) {
                Image(systemName: freshnessIcon(f.status))
                    .foregroundStyle(freshnessColor(f.status))
                VStack(alignment: .leading, spacing: 2) {
                    Text(f.status?.capitalized ?? "Unknown")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(freshnessColor(f.status))
                    if let days = f.daysSinceNewestComp ?? response.daysSinceNewestComp {
                        Text("Newest comp \(days)d ago")
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer()
                if let deal = response.dealScore {
                    VStack(alignment: .trailing, spacing: 2) {
                        HStack(spacing: 4) {
                            Text("Deal Score")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            HIQHelpButton(
                                title: "Deal Score",
                                message: "How attractive this comp looks vs. recent sales, on a 0–100 scale. 70+ is a strong deal, 40–69 is fair, under 40 means it's priced above what comps support."
                            )
                        }
                        Text(String(format: "%.0f", deal))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(dealScoreColor(deal))
                    }
                }
            }
        }
    }

    // MARK: - Predicted Price (CF-COMP-DETAIL-EXPAND, 2026-06-07)

    @ViewBuilder
    private func predictedPriceContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let predicted = response.predictedPrice {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "Predicted Price")

                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(predicted.formatted(.currency(code: "USD")))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    Spacer()
                    if let attribution = response.predictedPriceAttribution,
                       let mechanism = attribution.mechanism {
                        Text(mechanism)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.6)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                            .clipShape(Capsule())
                    }
                }

                if let range = response.predictedPriceRange,
                   let low = range.low, let high = range.high {
                    HStack(spacing: 6) {
                        Text("Range")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Text("\(low.formatted(.currency(code: "USD"))) – \(high.formatted(.currency(code: "USD")))")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }

                if let factor = response.predictedPriceAttribution?.forwardProjectionFactor {
                    HStack(spacing: 6) {
                        Text("Forward Projection Factor")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        Spacer()
                        Text(String(format: "%.4f", factor))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    }
                }
            }
        }
    }

    // MARK: - TrendIQ Detail (CF-COMP-DETAIL-EXPAND, 2026-06-07)

    @ViewBuilder
    private func trendIQDetailContent(_ response: CompIQPriceByIdResponse) -> some View {
        if let trendIQ = response.trendIQ {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(title: "TrendIQ")

                // Composite + direction + impliedPct + coverage row.
                HStack(spacing: 12) {
                    Image(systemName: trendArrow(trendIQ.direction))
                        .font(.title3.weight(.bold))
                        .foregroundStyle(trendColor(trendIQ.direction))

                    VStack(alignment: .leading, spacing: 2) {
                        if let composite = trendIQ.composite {
                            Text(String(format: "Composite %.3f", composite))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                        }
                        if let pct = trendIQ.impliedPct {
                            Text(String(format: "%+.1f%%", pct))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(trendColor(trendIQ.direction))
                        }
                    }

                    Spacer()

                    if let coverage = trendIQ.coverage {
                        Text(coverage)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.6)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                            .clipShape(Capsule())
                    }
                }

                // Card Trajectory detail — recent vs older median.
                if let card = trendIQ.components?.cardTrajectory {
                    Divider().background(HobbyIQTheme.Colors.steelGray.opacity(0.4))

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Card Trajectory")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.4)

                        if let recent = card.recentMedian, let older = card.olderMedian {
                            HStack(spacing: 6) {
                                Text("Recent median")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Spacer()
                                Text(recent.formatted(.currency(code: "USD")))
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                            HStack(spacing: 6) {
                                Text("Older median")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Spacer()
                                Text(older.formatted(.currency(code: "USD")))
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                        }

                        if let pctChange = card.pctChange {
                            HStack(spacing: 6) {
                                Text("Δ recent vs older")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Spacer()
                                Text(String(format: "%+.1f%%", pctChange))
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(trendColor(trendIQ.direction))
                            }
                        }

                        if let rc = card.recentCount, let oc = card.olderCount {
                            HStack(spacing: 6) {
                                Text("Sample sizes (recent / older)")
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                                Spacer()
                                Text("\(rc) / \(oc)")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Regime (CF-COMP-DETAIL-EXPAND, 2026-06-07)

    @ViewBuilder
    private func regimeContent(_ response: CompIQPriceByIdResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Headline: regime + confidence chips.
            HStack(spacing: 10) {
                if let regime = response.regime {
                    Text(regime.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
                if let confidence = response.regimeConfidence {
                    Text(confidence.uppercased() + " CONFIDENCE")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        .tracking(0.6)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(HobbyIQTheme.Colors.steelGray.opacity(0.4))
                        .clipShape(Capsule())
                }
                Spacer()
            }

            if let diag = response.regimeDiagnostics {
                Divider().background(HobbyIQTheme.Colors.steelGray.opacity(0.4))

                VStack(alignment: .leading, spacing: 6) {
                    if let slope = diag.slopePctPerMonth {
                        regimeRow(label: "Slope", value: String(format: "%+.2f%%/mo", slope))
                    }
                    if let cov = diag.coefficientOfVariation {
                        regimeRow(label: "Coefficient of Variation", value: String(format: "%.3f", cov))
                    }
                    if let r2 = diag.r2 {
                        regimeRow(label: "R²", value: String(format: "%.3f", r2))
                    }
                    if let recent = diag.recentMeanLast14d {
                        regimeRow(label: "Recent mean (14d)", value: recent.formatted(.currency(code: "USD")))
                    }
                    if let older = diag.olderMean14to90d {
                        regimeRow(label: "Older mean (14–90d)", value: older.formatted(.currency(code: "USD")))
                    }
                    if let pct = diag.pctChangeRecentVsOlder {
                        regimeRow(label: "Δ recent vs older", value: String(format: "%+.2f%%", pct))
                    }
                    if let reason = diag.classificationReason {
                        Text(reason)
                            .font(.caption2)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func regimeRow(label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Spacer()
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    // MARK: - Variant Warning

    @ViewBuilder
    private func variantWarningBanner(_ response: CompIQPriceByIdResponse) -> some View {
        if let warning = response.variantWarning, warning.isEmpty == false {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.warning)
                Text(warning)
                    .font(.footnote)
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.warning.opacity(0.15))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.warning.opacity(0.3), lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
        }
    }

    // MARK: - Insufficient Comps

    private var insufficientCompsCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "chart.bar.xaxis.ascending")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(HobbyIQTheme.Colors.warning)

            Text("Insufficient Recent Comps")
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)

            Text("There aren't enough recent sales to price this variant. Try a different grade or check back later.")
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .hiqCard()
    }

    // MARK: - Loading & Error

    private var loadingCard: some View {
        HStack(spacing: 12) {
            ProgressView()
                .tint(HobbyIQTheme.Colors.electricBlue)
            Text("Fetching price data...")
                .font(HobbyIQTheme.Typography.bodyEmphasis)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
        }
        .hiqCard()
    }

    private func errorBanner(_ message: String) -> some View {
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

    // MARK: - Section Headers

    private func sectionHeader(title: String) -> some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
                .tracking(1.2)
                .fixedSize()
            Rectangle()
                .fill(HobbyIQTheme.Colors.electricBlue.opacity(0.25))
                .frame(height: 1)
        }
    }

    private func groupSectionHeader(title: String, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
            Text(title)
                .font(HobbyIQTheme.Typography.cardTitle)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Group Wrapper

    private func cardGroup<Content: View>(title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            groupSectionHeader(title: title, icon: icon)
            content()
        }
        .hiqGroupCard()
    }

    // MARK: - Helper Chips

    private func metadataChip(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
                .tracking(0.5)
            Text(value)
                .font(.caption.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func pricePill(label: String, value: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(tint.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                .stroke(tint.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
    }

    // MARK: - Color / Icon Helpers

    private func verdictColor(_ verdict: String) -> Color {
        let lower = verdict.lowercased()
        if lower.contains("buy") { return HobbyIQTheme.Colors.successGreen }
        if lower.contains("sell") { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.warning
    }

    private func verdictIcon(_ verdict: String) -> String {
        let lower = verdict.lowercased()
        if lower.contains("buy") { return "checkmark.seal.fill" }
        if lower.contains("sell") { return "arrow.up.right.circle.fill" }
        return "pause.circle.fill"
    }

    private func trendArrow(_ direction: String?) -> String {
        switch direction?.lowercased() {
        case "up": return "arrow.up.right"
        case "down": return "arrow.down.right"
        default: return "arrow.right"
        }
    }

    private func trendColor(_ direction: String?) -> Color {
        switch direction?.lowercased() {
        case "up": return HobbyIQTheme.Colors.successGreen
        case "down": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.warning
        }
    }

    private func confidenceBarColor(_ value: Double) -> Color {
        switch value {
        case 0.7...: return HobbyIQTheme.Colors.successGreen
        case 0.4..<0.7: return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.danger
        }
    }

    private func buyWindowColor(_ score: Double?) -> Color {
        guard let score else { return HobbyIQTheme.Colors.mutedText }
        if score >= 70 { return HobbyIQTheme.Colors.successGreen }
        if score >= 40 { return HobbyIQTheme.Colors.warning }
        return HobbyIQTheme.Colors.danger
    }

    private func freshnessIcon(_ status: String?) -> String {
        switch status?.lowercased() {
        case "fresh": return "checkmark.seal.fill"
        case "stale": return "clock.arrow.circlepath"
        default: return "questionmark.circle"
        }
    }

    private func freshnessColor(_ status: String?) -> Color {
        switch status?.lowercased() {
        case "fresh": return HobbyIQTheme.Colors.successGreen
        case "stale": return HobbyIQTheme.Colors.warning
        default: return HobbyIQTheme.Colors.mutedText
        }
    }

    private func dealScoreColor(_ score: Double) -> Color {
        if score >= 70 { return HobbyIQTheme.Colors.successGreen }
        if score >= 40 { return HobbyIQTheme.Colors.warning }
        return HobbyIQTheme.Colors.danger
    }

    // MARK: - Segment Trajectory Full

    @ViewBuilder
    private var segmentTrajectoryFullSection: some View {
        if let full = segmentTrajectoryFull {
            cardGroup(title: "Segment Trajectory (Full)", icon: "chart.xyaxis.line") {
                if let reanchor = full.reanchorApplied {
                    segmentDataRow(label: "Re-anchor Applied", value: reanchor ? "Yes" : "No")
                }
                if let effective = full.effectiveAnchorDate {
                    segmentDataRow(label: "Effective Anchor", value: effective)
                }
                if let original = full.originalAnchorDate {
                    segmentDataRow(label: "Original Anchor", value: original)
                }

                if let perWindow = full.perWindow {
                    HStack(spacing: 12) {
                        windowStatTile(title: "Pre-Anchor", stat: perWindow.pre)
                        windowStatTile(title: "Post-Anchor", stat: perWindow.post)
                    }
                }

                if let preSales = full.preAnchorSales, !preSales.isEmpty {
                    anchorSalesSection(title: "Pre-Anchor Sales", sales: preSales)
                }
                if let postSales = full.postAnchorSales, !postSales.isEmpty {
                    anchorSalesSection(title: "Post-Anchor Sales", sales: postSales)
                }

                if let siblings = full.siblingCardIds, !siblings.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SIBLING CARD IDS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)
                        Text(siblings.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .lockedOverlay(
                feature: GatedFeature.trendIQLayer3Full,
                subscriptionManager: sessionViewModel.subscriptionManager
            ) {
                showUpgradePaywall = true
            }
        } else if isLoadingFullTrendIQ {
            HStack(spacing: 12) {
                ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
                Text("Loading full trajectory...")
                    .font(.subheadline)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer()
            }
            .hiqGroupCard()
        }
    }

    private func segmentDataRow(label: String, value: String) -> some View {
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

    private func windowStatTile(title: String, stat: SegmentTrajectoryFull.WindowStat) -> some View {
        VStack(spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.6)
            Text(stat.mean.formatted(.currency(code: "USD")))
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            HStack(spacing: 8) {
                Text("p25: \(stat.p25.formatted(.currency(code: "USD")))")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Text("p75: \(stat.p75.formatted(.currency(code: "USD")))")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func anchorSalesSection(title: String, sales: [SegmentTrajectoryFull.AnchorSale]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.8)
            ForEach(sales) { sale in
                HStack {
                    Text(anchorSaleDate(sale.ts))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Spacer()
                    Text(sale.price.formatted(.currency(code: "USD")))
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                }
            }
        }
    }

    private func anchorSaleDate(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        return formatter.string(from: date)
    }

    // MARK: - Advanced Tools

    private func advancedToolsSection(_ response: CompIQPriceByIdResponse) -> some View {
        cardGroup(title: "Advanced Tools", icon: "wrench.and.screwdriver") {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                toolButton(title: "What-If", icon: "questionmark.circle", action: { showWhatIf = true })
                toolButton(title: "Grade Premium", icon: "star.circle", action: { showGradePremium = true })
                toolButton(title: "Sell Window", icon: "calendar.circle", action: { showSellWindow = true })
                toolButton(title: "Comps by Player", icon: "person.2.circle", action: { showCompsByPlayer = true })
            }
        }
    }

    private func toolButton(title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                Spacer()
            }
            .padding(12)
            .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.3), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Fetch

    private func fetchPrice() async {
        isLoading = true
        error = nil

        do {
            let response = try await CompIQSearchService.shared.priceByCardId(
                hit.cardsightCardId,
                query: hit.displayLabel ?? hit.resolvedLabel,
                gradeCompany: selectedGrade.gradeCompany,
                gradeValue: selectedGrade.gradeValue
            )
            priceResponse = response
        } catch {
            logger.error("price-by-id error: \(error.localizedDescription)")
            self.error = APIService.errorMessage(from: error)
        }

        isLoading = false
    }

    private func fetchTrendIQFull() async {
        isLoadingFullTrendIQ = true
        defer { isLoadingFullTrendIQ = false }

        do {
            let request = TrendIQRequest(
                cardsightCardId: hit.cardsightCardId,
                query: hit.displayLabel ?? hit.resolvedLabel,
                gradeCompany: selectedGrade.gradeCompany,
                gradeValue: selectedGrade.gradeValue
            )
            let response = try await APIService.shared.fetchTrendIQFull(request: request)
            segmentTrajectoryFull = response.segmentTrajectoryFull
        } catch {
            logger.error("trendiq-full error: \(error.localizedDescription)")
        }
    }
}

// MARK: - Portfolio Holding → CompIQ Bridge

struct PortfolioCompIQBridgeView: View {
    let holding: InventoryCard
    @State private var resolvedHit: CompIQVariantHit?
    @State private var isSearching = true
    @State private var searchError: String?
    @Environment(\.dismiss) private var dismiss

    private var searchQuery: String {
        [holding.playerName, holding.year, holding.setName, holding.parallel]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    var body: some View {
        Group {
            if let hit = resolvedHit {
                CompIQPricedCardView(hit: hit)
            } else if isSearching {
                VStack(spacing: 16) {
                    ProgressView()
                        .tint(.white)
                    Text("Finding card...")
                        .font(.subheadline)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(HobbyIQBackground())
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text("Could not find this card in CompIQ")
                        .font(.headline.bold())
                        .foregroundStyle(.white)
                    if let searchError {
                        Text(searchError)
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    Text("Search: \(searchQuery)")
                        .font(.caption2)
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Button("Done") { dismiss() }
                        .buttonStyle(.bordered)
                        .tint(HobbyIQTheme.Colors.electricBlue)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(HobbyIQBackground())
            }
        }
        .task {
            await search()
        }
    }

    private func search() async {
        do {
            let hits = try await CompIQSearchService.shared.searchVariants(query: searchQuery)
            if let first = hits.first {
                resolvedHit = first
            } else {
                resolvedHit = CompIQVariantHit(from: holding)
            }
        } catch {
            searchError = APIService.errorMessage(from: error)
            resolvedHit = CompIQVariantHit(from: holding)
        }
        isSearching = false
    }
}

// MARK: - Card Modifiers

private extension View {
    func hiqHeroCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(
                ZStack {
                    HobbyIQTheme.Colors.cardNavy
                    RadialGradient(
                        colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.12), .clear],
                        center: .topLeading,
                        startRadius: 20,
                        endRadius: 200
                    )
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 2.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: HobbyIQTheme.Colors.electricBlue.opacity(0.25), radius: 20, x: 0, y: 10)
    }

    func hiqCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy)
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.6), lineWidth: 1.2)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.2), radius: 8, x: 0, y: 4)
    }

    func hiqGroupCard() -> some View {
        self
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
            .shadow(color: Color.black.opacity(0.15), radius: 6, x: 0, y: 3)
    }
}

#Preview {
    NavigationStack {
        CompIQPricedCardView(
            hit: CompIQVariantHit.previewHit,
            previewResponse: CompIQPriceByIdResponse.previewMock
        )
    }
    .environmentObject(AppSessionViewModel())
    .preferredColorScheme(.dark)
}

private extension CompIQVariantHit {
    static var previewHit: CompIQVariantHit {
        // Wire-shape per b540f53 + CF-VARIANT-PICKER-RICH (2026-06-07):
        // exercise the full disambiguator set so the preview canvas matches
        // the production row layout (pills + footnote dot + expand details).
        let json = #"""
        {
            "candidateId": "cardsight:preview-1",
            "source": "cardsight-catalog",
            "attribution": "ranked",
            "confidence": 0.86,
            "player": "Caleb Bonemer",
            "brand": "Bowman",
            "setName": "2024 Bowman Draft",
            "cardNumber": "BD-31",
            "parallel": "Sky Blue",
            "variation": "Refractor",
            "isAuto": true,
            "serialNumber": "/99",
            "gradeCompany": "PSA",
            "gradeValue": 10,
            "title": "2024 Bowman Draft Caleb Bonemer BD-31 Sky Blue Refractor Auto",
            "displayLabel": "2024 Bowman Draft Baseball Caleb Bonemer BD-31 Sky Blue",
            "imageUrl": null,
            "attributes": ["RC", "PROSPECT"],
            "parallels": [{ "id": "p1", "name": "Sky Blue", "numberedTo": 99 }]
        }
        """#
        return try! JSONDecoder().decode(CompIQVariantHit.self, from: json.data(using: .utf8)!)
    }
}

private extension CompIQPriceByIdResponse {
    static var previewMock: CompIQPriceByIdResponse {
        let json = #"""
        {
            "success": true,
            "cardsightCardId": "preview-1",
            "summary": "Buy — Strong value at current pricing with rising trend and 8 recent comps in the last 30 days.",
            "marketTier": { "value": 42.50, "high": 67.00 },
            "buyZone": [28.00, 38.00],
            "holdZone": [38.00, 52.00],
            "sellZone": [52.00, 67.00],
            "confidence": 0.82,
            "gradeUsed": "Raw",
            "compsUsed": 8,
            "daysSinceNewestComp": 3,
            "verdict": "Buy",
            "action": "buy",
            "quickSaleValue": 35.00,
            "premiumValue": 55.00,
            "trendAnalysis": {
                "market_direction": "up",
                "change_from_older_to_recent": "+12.5%",
                "liquidity": "High"
            },
            "recentComps": [
                { "price": 45.00, "title": "2024 Bowman Draft Sky Blue Auto #BD-31", "soldDate": "2026-05-10T14:30:00Z" },
                { "price": 39.99, "title": "2024 Bowman Draft Sky Blue #BD-31 Bonemer", "soldDate": "2026-05-08T10:00:00Z" },
                { "price": 42.50, "title": "Bonemer 2024 Bowman Draft Sky Blue RC", "soldDate": "2026-05-05T18:45:00Z" }
            ],
            "explanation": [
                "Based on 8 recent eBay sold listings for the Sky Blue parallel",
                "Prices trending up 12.5% from older comps to recent sales",
                "High liquidity — cards sell within 3-5 days on average"
            ],
            "buyWindow": { "score": 78, "label": "Good Buy Window", "reasons": ["Price is below FMV", "Rising trend supports entry", "High liquidity for quick exit"] },
            "freshness": { "status": "fresh", "daysSinceNewestComp": 3 },
            "broaderTrend": { "direction": "up", "label": "Bowman Draft Rising", "note": "2024 Bowman Draft parallels up 8% across the board this month" },
            "exitStrategy": { "recommendedMethod": "eBay Auction", "expectedDaysToSell": 5, "timingRecommendation": "List within 2 weeks while trend is rising" },
            "dealScore": 75,
            "compQuality": "High",
            "dataSufficiency": "Sufficient",
            "trendIQ": {
                "composite": 1.04,
                "direction": "rising",
                "impliedPct": 4.0,
                "lastUpdated": "2026-05-26T10:50:00.000Z",
                "coverage": "no_segment",
                "components": {
                    "playerMomentum": {
                        "multiplier": 1.05,
                        "flags": ["compsMomentum_rising"],
                        "componentSignals": {
                            "compsMomentum": 1.12,
                            "ebay": 1.0,
                            "reddit": 1.0,
                            "trends": 1.03,
                            "odds": 1.0,
                            "stats": 1.0,
                            "news": 1.0,
                            "youtube": 1.0
                        },
                        "lastUpdated": "2026-05-26T10:50:00.000Z",
                        "sourceUrl": "https://fn-compiq.azurewebsites.net/api/signals"
                    },
                    "cardTrajectory": {
                        "multiplier": 1.03,
                        "pctChange": 3.2,
                        "recentMedian": 44.0,
                        "olderMedian": 42.5,
                        "recentCount": 5,
                        "olderCount": 8,
                        "windowRecentDays": 14,
                        "windowOlderDays": 30
                    },
                    "segmentTrajectory": null
                },
                "weights": {
                    "playerMomentum": 0.3,
                    "cardTrajectory": 0.7,
                    "segmentTrajectory": 0.0
                }
            }
        }
        """#
        return try! JSONDecoder().decode(CompIQPriceByIdResponse.self, from: json.data(using: .utf8)!)
    }
}

// MARK: - TrendIQ Layer Breakdown

struct TrendIQLayerBreakdownView: View {
    let trendIQ: TrendIQResponse
    @Environment(\.dismiss) private var dismiss

    private var showsCardTrajectory: Bool {
        let c = trendIQ.coverage?.lowercased() ?? ""
        return c == "full" || c == "card_only" || c == "no_segment"
    }

    private var showsSegmentTrajectory: Bool {
        trendIQ.coverage?.lowercased() == "full"
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: HobbyIQTheme.Spacing.large) {
                    compositeHeader

                    layer1Section

                    if showsCardTrajectory {
                        layer2Section
                    } else {
                        unavailableLayer(
                            title: "Card Trajectory",
                            reason: "Card-level trajectory data unavailable for this coverage level."
                        )
                    }

                    if showsSegmentTrajectory {
                        layer3Section
                    } else if showsCardTrajectory {
                        unavailableLayer(
                            title: "Segment Trajectory",
                            reason: "Segment trajectory unavailable for this card."
                        )
                    }
                }
                .padding(HobbyIQTheme.Spacing.screenPadding)
                .padding(.bottom, HobbyIQTheme.Spacing.xLarge)
            }
            .background(HobbyIQBackground())
            .navigationTitle("TrendIQ Layers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                }
            }
            .toolbarBackground(HobbyIQTheme.Colors.appBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    // MARK: - Composite Header

    private var compositeHeader: some View {
        VStack(spacing: 8) {
            if let composite = trendIQ.composite {
                // TODO: post-diagnosis decision — raw percentage for now
                Text(String(format: "%.1f%%", composite * 100))
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(compositeColor)
            }

            if let direction = trendIQ.direction {
                Text(direction.capitalized)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let coverage = trendIQ.coverage {
                Text("Coverage: \(coverage.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(
            ZStack {
                HobbyIQTheme.Colors.cardNavy
                RadialGradient(
                    colors: [compositeColor.opacity(0.12), .clear],
                    center: .center,
                    startRadius: 20,
                    endRadius: 160
                )
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                .stroke(compositeColor.opacity(0.3), lineWidth: 2.0)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }

    private var compositeColor: Color {
        switch trendIQ.direction?.lowercased() {
        case "rising": return HobbyIQTheme.Colors.successGreen
        case "falling": return HobbyIQTheme.Colors.danger
        default: return HobbyIQTheme.Colors.warning
        }
    }

    // MARK: - Layer 1: Player Momentum

    private var layer1Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 1 — Player Momentum", weight: trendIQ.weights?.playerMomentum)

            if let pm = trendIQ.components?.playerMomentum {
                if let multiplier = pm.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }

                if let signals = pm.componentSignals, !signals.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("COMPONENT SIGNALS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)

                        ForEach(signals.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            HStack {
                                Text(key)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                                Spacer()
                                Text(String(format: "%.3f", value))
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(signalColor(value))
                            }
                        }
                    }
                    .padding(12)
                    .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.medium, style: .continuous))
                }

                if let flags = pm.flags, !flags.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("FLAGS")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                            .tracking(0.8)

                        ForEach(flags, id: \.self) { flag in
                            HStack(alignment: .top, spacing: 6) {
                                Circle()
                                    .fill(HobbyIQTheme.Colors.warning)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                Text(flag)
                                    .font(.caption)
                                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                            }
                        }
                    }
                }
            } else {
                Text("Player momentum data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Layer 2: Card Trajectory

    private var layer2Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 2 — Card Trajectory", weight: trendIQ.weights?.cardTrajectory)

            if let ct = trendIQ.components?.cardTrajectory {
                if let multiplier = ct.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }
                if let pctChange = ct.pctChange {
                    dataRow(label: "Change", value: String(format: "%+.1f%%", pctChange))
                }

                HStack(spacing: 12) {
                    windowTile(
                        title: "Recent",
                        median: ct.recentMedian,
                        count: ct.recentCount,
                        days: ct.windowRecentDays
                    )
                    windowTile(
                        title: "Older",
                        median: ct.olderMedian,
                        count: ct.olderCount,
                        days: ct.windowOlderDays
                    )
                }
            } else {
                Text("Card trajectory data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Layer 3: Segment Trajectory

    private var layer3Section: some View {
        VStack(alignment: .leading, spacing: 12) {
            layerHeader(title: "Layer 3 — Segment Trajectory", weight: trendIQ.weights?.segmentTrajectory)

            if let st = trendIQ.components?.segmentTrajectory {
                if let multiplier = st.multiplier {
                    dataRow(label: "Multiplier", value: String(format: "%.3f", multiplier))
                }
                if let pctChange = st.pctChange {
                    dataRow(label: "Change", value: String(format: "%+.1f%%", pctChange))
                }
                if let poolSize = st.siblingPoolSize {
                    dataRow(label: "Sibling Pool", value: "\(poolSize) cards")
                }
                if let outcome = st.outcome {
                    dataRow(label: "Outcome", value: outcome.replacingOccurrences(of: "_", with: " "))
                }
            } else {
                Text("Segment trajectory data unavailable.")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .layerCard()
    }

    // MARK: - Helpers

    private func layerHeader(title: String, weight: Double?) -> some View {
        HStack {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Spacer()
            if let weight, weight > 0 {
                Text("Weight: \(Int(weight * 100))%")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
    }

    private func dataRow(label: String, value: String) -> some View {
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

    private func windowTile(title: String, median: Double?, count: Int?, days: Int?) -> some View {
        VStack(spacing: 6) {
            Text(title.uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .tracking(0.6)

            if let median {
                Text(median.formatted(.currency(code: "USD")))
                    .font(.system(size: 17, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }

            if let count, let days {
                Text("\(count) comps / \(days)d")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .padding(.horizontal, 8)
        .background(HobbyIQTheme.Colors.steelGray.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.2), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func unavailableLayer(title: String, reason: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Text(reason)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
        }
        .layerCard()
    }

    private func signalColor(_ value: Double) -> Color {
        if value > 1.02 { return HobbyIQTheme.Colors.successGreen }
        if value < 0.98 { return HobbyIQTheme.Colors.danger }
        return HobbyIQTheme.Colors.mutedText
    }
}

private extension View {
    func layerCard() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(HobbyIQTheme.Spacing.medium)
            .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
            .overlay(
                RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous)
                    .stroke(HobbyIQTheme.Colors.steelGray.opacity(0.4), lineWidth: 1.0)
            )
            .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.xLarge, style: .continuous))
    }
}

// MARK: - CF-PRICEHISTORY-60D legend shapes (2026-06-10)

/// Filled triangle used by the price-history legend "Auction" chip so
/// the legend swatch matches the chart's PointMark `.triangle` symbol.
private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

/// Thin dashed/dotted horizontal line used in the price-history legend
/// to label the trend (dashed) and reference (dotted) overlays. The
/// dash pattern mirrors the in-chart `StrokeStyle` so a user can read
/// the legend and visually pick out the matching line in the chart.
private struct DashedLineSwatch: View {
    let color: Color
    let dotted: Bool

    var body: some View {
        GeometryReader { geo in
            Path { p in
                p.move(to: CGPoint(x: 0, y: geo.size.height / 2))
                p.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height / 2))
            }
            .stroke(
                color,
                style: StrokeStyle(
                    lineWidth: dotted ? 1.0 : 1.5,
                    lineCap: .butt,
                    dash: dotted ? [2, 3] : [5, 4]
                )
            )
        }
    }
}
