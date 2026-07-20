//
//  PriceSeriesView.swift
//  HobbyIQ
//
//  2026-07-20 (backend PR #623): historical price series for a
//  single card + parallel + grade. Line for the daily/weekly
//  median with a translucent min-max envelope. Pro Seller /
//  Investor tier gated — Free / Collector see a paywall CTA
//  instead of the chart.
//
//  Endpoint: GET /api/compiq/cards/:cardId/price-series?parallel&gradeCompany&gradeValue&window&bucket
//

import SwiftUI
import Charts

// MARK: - Wire models

struct PriceSeriesResponse: Decodable {
    let cardId: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let windowDays: Int?
    let bucket: String?
    let pointCount: Int?
    let points: [PriceSeriesPoint]?
}

struct PriceSeriesPoint: Decodable, Hashable, Identifiable {
    let day: String
    let median: Double?
    let min: Double?
    let max: Double?
    let count: Int?

    var id: String { day }

    var parsedDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let d = formatter.date(from: "\(day)T12:00:00Z") { return d }
        // Fallback for plain YYYY-MM-DD
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        df.timeZone = TimeZone(identifier: "UTC")
        return df.date(from: day)
    }
}

// MARK: - Filter enums

enum PriceSeriesWindow: String, CaseIterable, Identifiable {
    case thirtyDay = "30d"
    case ninetyDay = "90d"
    case oneEightyDay = "180d"
    case threeSixtyFiveDay = "365d"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .thirtyDay: return "30d"
        case .ninetyDay: return "90d"
        case .oneEightyDay: return "180d"
        case .threeSixtyFiveDay: return "1y"
        }
    }
}

enum PriceSeriesBucket: String, CaseIterable, Identifiable {
    case day
    case week
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

// MARK: - View

/// Pro-tier price-series chart. Callers pass card identity via the
/// initializer; the view fetches its own data + gates the display
/// behind `GatedFeature.trendIQComposite` (the closest existing
/// key with Investor+ semantics — matches the spec's "Pro Seller /
/// Investor tiers" requirement).
struct PriceSeriesView: View {
    let cardId: String
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?

    @EnvironmentObject private var sessionViewModel: AppSessionViewModel

    @State private var window: PriceSeriesWindow = .ninetyDay
    @State private var bucket: PriceSeriesBucket = .day
    @State private var response: PriceSeriesResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showUpgradePaywall = false

    init(
        cardId: String,
        parallel: String? = nil,
        gradeCompany: String? = nil,
        gradeValue: Double? = nil
    ) {
        self.cardId = cardId
        self.parallel = parallel
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
    }

    private var hasProAccess: Bool {
        sessionViewModel.subscriptionManager.has(GatedFeature.trendIQComposite)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if hasProAccess {
                    filterRow
                    chart
                    footnote
                } else {
                    paywallCard
                }
            }
            .padding(HobbyIQTheme.Spacing.screenPadding)
        }
        .navigationTitle("Price history")
        .navigationBarTitleDisplayMode(.inline)
        .themedNavigationSurface()
        .task(id: reloadKey) {
            guard hasProAccess else { return }
            await reload()
        }
        .sheet(isPresented: $showUpgradePaywall) {
            PaywallView(sessionViewModel: sessionViewModel)
        }
    }

    private var reloadKey: String {
        "\(cardId)|\(parallel ?? "-")|\(gradeCompany ?? "-")|\(gradeValue ?? 0)|\(window.rawValue)|\(bucket.rawValue)"
    }

    // MARK: - Filter row

    private var filterRow: some View {
        HStack(spacing: 8) {
            Picker("Window", selection: $window) {
                ForEach(PriceSeriesWindow.allCases) { w in
                    Text(w.label).tag(w)
                }
            }
            .pickerStyle(.segmented)

            Menu {
                Picker("Bucket", selection: $bucket) {
                    ForEach(PriceSeriesBucket.allCases) { b in
                        Text(b.label).tag(b)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(bucket.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(HobbyIQTheme.Colors.cardNavy.opacity(0.7))
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1)
                )
                .clipShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Chart

    @ViewBuilder
    private var chart: some View {
        if isLoading && response == nil {
            loadingState
        } else if let errorMessage {
            errorState(errorMessage)
        } else if let points = response?.points, points.isEmpty == false {
            let dated = points.compactMap { p -> (Date, Double, Double, Double)? in
                guard let date = p.parsedDate,
                      let med = p.median,
                      let lo = p.min,
                      let hi = p.max else { return nil }
                return (date, med, lo, hi)
            }
            Chart {
                ForEach(dated, id: \.0) { entry in
                    // Envelope area (min → max)
                    AreaMark(
                        x: .value("Day", entry.0),
                        yStart: .value("Min", entry.2),
                        yEnd: .value("Max", entry.3)
                    )
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue.opacity(0.18))
                    // Median line
                    LineMark(
                        x: .value("Day", entry.0),
                        y: .value("Median", entry.1)
                    )
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                    .interpolationMethod(.monotone)
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
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.2))
                    AxisTick().foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.4))
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                }
            }
            .frame(height: 280)
        } else if response != nil {
            emptyState
        }
    }

    private var footnote: some View {
        Text("Solid line: median. Shaded band: daily min–max range. Data windowed to the selection above; empty days are omitted.")
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
    }

    // MARK: - Paywall CTA

    private var paywallCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                    .foregroundStyle(HobbyIQTheme.Colors.electricBlue)
                Text("PRICE HISTORY")
                    .font(.caption.weight(.bold))
                    .tracking(0.6)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                Spacer(minLength: 0)
            }
            Text("Historical price charts")
                .font(.title3.weight(.bold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Every sale for this card, bucketed daily or weekly, with the min–max range around the median. Available on Investor and Pro Seller tiers.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                showUpgradePaywall = true
            } label: {
                Text("Upgrade")
            }
            .buttonStyle(.appPrimary)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.3), lineWidth: 1.2)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView().tint(HobbyIQTheme.Colors.electricBlue)
            Text("Loading price series\u{2026}")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "chart.xyaxis.line")
                .font(.title2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.6))
            Text("No sales in this window.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text("Try a wider window or a coarser bucket.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(HobbyIQTheme.Colors.danger.opacity(0.8))
            Text("Couldn't load price history.")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            Text(message)
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    // MARK: - Reload

    private func reload() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            response = try await APIService.shared.fetchPriceSeries(
                cardId: cardId,
                parallel: parallel,
                gradeCompany: gradeCompany,
                gradeValue: gradeValue,
                window: window.rawValue,
                bucket: bucket.rawValue
            )
        } catch {
            errorMessage = "The server didn't respond in time."
        }
    }
}
