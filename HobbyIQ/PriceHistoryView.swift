//
//  PriceHistoryView.swift
//  HobbyIQ
//
//  2026-07-15: dedicated Price History screen for a single card.
//  Backed by GET /api/compiq/cards/:cardId/price-history — see the
//  request/response contract on APIService.fetchPriceHistory. Chart
//  uses Apple's Swift Charts (iOS 16+, already targeted). Every
//  network state degrades gracefully to an empty view, never a crash.
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

// MARK: - Screen

struct PriceHistoryView: View {
    let cardId: String

    @State private var window: PriceHistoryWindow = .oneYear
    @State private var bucket: PriceHistoryBucket = .monthly
    @State private var response: PriceHistoryResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                windowPicker
                bucketPicker

                Group {
                    if isLoading && response == nil {
                        loadingState
                    } else if let errorMessage {
                        errorState(errorMessage)
                    } else if let points = response?.points, points.isEmpty == false {
                        chartCard(points: points)
                        statsRow
                    } else {
                        emptyState
                    }
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .background { HobbyIQBackground() }
        .navigationTitle("Price History")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: reloadKey) {
            await reload()
        }
    }

    private var reloadKey: String { "\(window.rawValue)|\(bucket.rawValue)" }

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
