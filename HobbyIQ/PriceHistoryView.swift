//
//  PriceHistoryView.swift
//  HobbyIQ
//
//  2026-07-15: Price History surface for a single card.
//  Backed by GET /api/compiq/cards/:cardId/price-history — see the
//  request/response contract on APIService.fetchPriceHistory. Chart
//  uses Apple's Swift Charts (iOS 16+, already targeted). Every
//  network state degrades gracefully to an empty view, never a crash.
//
//  2026-07-16: extracted `PriceHistoryChartCard` so the same graph +
//  window/bucket pickers embed inline inside `CompIQPricedCardView`'s
//  Market Trend section. `PriceHistoryView` is now the standalone
//  screen wrapper (ScrollView + nav chrome); the card content lives
//  in the extracted view for reuse.
//

import SwiftUI
import Charts

// MARK: - Response models

struct PriceHistoryResponse: Codable {
    let success: Bool?
    let cardId: String?
    let window: String?
    let bucket: String?
    let totalComps: Int?
    let earliestSoldAt: String?
    let latestSoldAt: String?
    let points: [PriceHistoryBucketPoint]?
}

struct PriceHistoryBucketPoint: Codable, Hashable, Identifiable {
    let bucketStart: String
    let count: Int?
    let medianPrice: Double?
    let minPrice: Double?
    let maxPrice: Double?
    let meanPrice: Double?
    let sourceBreakdown: [String: Int]?

    var id: String { bucketStart }

    var parsedDate: Date? {
        // Wire is `YYYY-MM-DD`. Rehydrate at UTC noon so
        // month/week/quarter boundaries align without timezone drift.
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: "\(bucketStart)T12:00:00Z")
    }
}

// MARK: - Standalone screen (embeds the reusable card inside nav chrome)

struct PriceHistoryView: View {
    let cardId: String

    var body: some View {
        ScrollView {
            PriceHistoryChartCard(cardId: cardId)
                .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Price History")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
    }
}

// MARK: - Reusable inline card (pickers + chart + seasonality captions)

/// Bucketed price-history chart with window/bucket pickers, seasonality
/// captions above the chart, and a stats row underneath. Renders as a
/// standalone card — no ScrollView, no navigation chrome — so callers
/// can embed it inline (e.g. inside `CompIQPricedCardView`'s Market
/// Trend section) or wrap it with `PriceHistoryView` for a dedicated
/// screen.
struct PriceHistoryChartCard: View {
    let cardId: String

    @State private var window: PriceHistoryWindow = .oneYear
    @State private var bucket: PriceHistoryBucket = .monthly
    @State private var response: PriceHistoryResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    /// P1.1 (2026-07-16, seasonality-signals-derivation.md): dedicated
    /// `window=1y, bucket=weekly` response fetched alongside the primary
    /// chart so the momentum sparkline has enough weekly points for a
    /// least-squares fit even when the user picks a coarser primary view.
    /// Nil until first load; failure leaves it nil so the caption hides.
    @State private var weeklyResponse: PriceHistoryResponse?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            windowPicker
            bucketPicker

            Group {
                if isLoading && response == nil {
                    loadingState
                } else if let errorMessage {
                    errorState(errorMessage)
                } else if let points = response?.points, points.isEmpty == false {
                    // P1.1: peak/trough/YoY captions above the chart.
                    // Every caption self-suppresses when its sample-size
                    // gate isn't met — no low-confidence prose.
                    seasonalityCaptions(points: points)
                    chartCard(points: points)
                    statsRow
                } else {
                    emptyState
                }
            }
        }
        .task(id: reloadKey) {
            await reload()
        }
        .task {
            // P1.1 (2026-07-16): fetch the weekly response once per view
            // lifetime — the momentum signal is independent of the primary
            // picker state.
            await reloadWeekly()
        }
    }

    private var reloadKey: String { "\(cardId)|\(window.rawValue)|\(bucket.rawValue)" }

    // MARK: - Reload

    private func reload() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await APIService.shared.fetchPriceHistory(
                cardId: cardId,
                window: window.rawValue,
                bucket: bucket.rawValue
            )
            await MainActor.run { response = result }
        } catch {
            await MainActor.run {
                errorMessage = "Couldn't load price history."
            }
        }
    }

    /// P1.1 (2026-07-16): background fetch of the 1y weekly bucket for
    /// momentum. Silent failure — a missing weekly response just hides
    /// the momentum glyph.
    private func reloadWeekly() async {
        do {
            let result = try await APIService.shared.fetchPriceHistory(
                cardId: cardId,
                window: PriceHistoryWindow.oneYear.rawValue,
                bucket: PriceHistoryBucket.weekly.rawValue
            )
            await MainActor.run { weeklyResponse = result }
        } catch {
            // Silent — momentum glyph is nice-to-have.
        }
    }

    // MARK: - Pickers

    private var windowPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Window")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Picker("Window", selection: $window) {
                ForEach(PriceHistoryWindow.allCases) { w in
                    Text(w.label).tag(w)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var bucketPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Bucket")
                .font(.caption.weight(.bold))
                .tracking(0.6)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Picker("Bucket", selection: $bucket) {
                ForEach(PriceHistoryBucket.allCases) { b in
                    Text(b.label).tag(b)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: - P1.1 Seasonality captions

    /// Peak / trough / YoY / momentum captions above the chart. Each
    /// caption self-suppresses per its sample-size gate. Layout:
    /// left column = peak + trough stacked; right column = YoY + momentum
    /// glyph. Whole block is skipped when no signal fires.
    @ViewBuilder
    private func seasonalityCaptions(points: [PriceHistoryBucketPoint]) -> some View {
        let peak = PriceHistorySeasonality.peakMonth(from: points)
        let trough = PriceHistorySeasonality.troughMonth(from: points)
        let adjacent = PriceHistorySeasonality.peakTroughAreAdjacent(peak: peak, trough: trough)
        let yoy = PriceHistorySeasonality.yoyChange(from: points)
        let momentum = PriceHistorySeasonality.weeklyMomentum(from: weeklyResponse?.points ?? [])

        let showPeak = peak != nil && adjacent == false
        let showTrough = trough != nil && adjacent == false
        let showYoY = yoy != nil
        let showMomentum = momentum != nil

        if showPeak || showTrough || showYoY || showMomentum {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    if let peak, showPeak {
                        Text("Historically peaks in \(PriceHistorySeasonality.monthLabel(peak))")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                    if let trough, showTrough {
                        Text("Historically softest in \(PriceHistorySeasonality.monthLabel(trough))")
                            .font(.caption)
                            .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 4) {
                    if showYoY, let label = PriceHistorySeasonality.yoyLabel(yoy) {
                        Text(label)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(PriceHistorySeasonality.yoyColor(yoy))
                    }
                    if showMomentum {
                        HStack(spacing: 4) {
                            Text(PriceHistorySeasonality.momentumGlyph(momentum))
                                .font(.caption.weight(.bold))
                                .foregroundStyle(PriceHistorySeasonality.momentumColor(momentum))
                            Text("30d")
                                .font(.caption2)
                                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Chart

    private func chartCard(points: [PriceHistoryBucketPoint]) -> some View {
        let usable = points.filter { $0.parsedDate != nil && ($0.medianPrice ?? 0) > 0 }
        let maxCount = max(1, usable.map { $0.count ?? 0 }.max() ?? 1)
        return VStack(alignment: .leading, spacing: 12) {
            Chart {
                ForEach(usable) { point in
                    if let date = point.parsedDate {
                        // Min/max shaded range per bucket
                        if let lo = point.minPrice, let hi = point.maxPrice, hi > lo {
                            AreaMark(
                                x: .value("Date", date),
                                yStart: .value("Low", lo),
                                yEnd: .value("High", hi)
                            )
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.12))
                            .interpolationMethod(.monotone)
                        }
                        // Median trend line
                        if let median = point.medianPrice {
                            LineMark(
                                x: .value("Date", date),
                                y: .value("Median", median)
                            )
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                            .interpolationMethod(.monotone)

                            PointMark(
                                x: .value("Date", date),
                                y: .value("Median", median)
                            )
                            .symbolSize(bucketDotSize(count: point.count ?? 0, maxCount: maxCount))
                            .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.2))
                    AxisTick().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.4))
                    AxisValueLabel(format: .dateTime.month(.abbreviated).year(.twoDigits))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.2))
                    AxisTick().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.4))
                    AxisValueLabel(format: .currency(code: "USD").precision(.fractionLength(0)))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .frame(height: 260)
        }
        .padding(16)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Gradients.dashboardStroke, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    /// Larger dots where more sales landed in that bucket. Scaled by
    /// relative count so a low-volume window still shows dots that
    /// vary visibly.
    private func bucketDotSize(count: Int, maxCount: Int) -> CGFloat {
        let normalized = Double(count) / Double(maxCount)
        return CGFloat(28 + (normalized * 120))
    }

    // MARK: - Stats row + states

    private var statsRow: some View {
        HStack(spacing: 4) {
            if let total = response?.totalComps, total > 0 {
                Text("Total: \(total)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            if let earliest = response?.earliestSoldAt.flatMap(Self.friendlyDate),
               let latest = response?.latestSoldAt.flatMap(Self.friendlyDate) {
                Text(" · From \(earliest) to \(latest)")
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            Spacer(minLength: 0)
        }
    }

    private static func friendlyDate(_ raw: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = formatter.date(from: raw) ?? {
            let alt = ISO8601DateFormatter()
            alt.formatOptions = [.withInternetDateTime]
            return alt.date(from: raw)
        }()
        guard let date = parsed else { return nil }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading price history…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No sales in this window.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try a wider window.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title2)
                .foregroundStyle(.orange)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .multilineTextAlignment(.center)
            Button("Retry") { Task { await reload() } }
                .buttonStyle(.bordered)
                .tint(HobbyIQTheme.Colors.electricBlue)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }
}

// MARK: - Picker enums

enum PriceHistoryWindow: String, CaseIterable, Identifiable {
    case threeMonths = "3m"
    case oneYear = "1y"
    case threeYears = "3y"
    case all = "all"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .threeMonths: return "3M"
        case .oneYear: return "1Y"
        case .threeYears: return "3Y"
        case .all: return "All"
        }
    }
}

enum PriceHistoryBucket: String, CaseIterable, Identifiable {
    case weekly, monthly, quarterly
    var id: String { rawValue }
    var label: String {
        switch self {
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .quarterly: return "Quarterly"
        }
    }
}
