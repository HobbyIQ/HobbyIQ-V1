//
//  CollectionValueCard.swift
//  HobbyIQ
//
//  CF-PHASE-5-COLLECTION-VALUE (2026-06-18): the iOS collection-value
//  card. Renders the headline + range + HISTORICAL 30d change + 30d
//  sparkline + top-5 holdings + framing footnote from
//  GET /api/portfolio/value-history.
//
//  This is the SECOND displayed portfolio total in the app:
//    - InventoryIQ hero  → observed-only honest total (Story B contract)
//    - Collection card   → observed + estimated (includes model estimates)
//
//  The two are intentionally different surfaces — the gap between them
//  IS signal under sparse comp coverage. The "Est." prefix + range +
//  framing.note on this card prime the user that this number is wider
//  than the hero's.
//

import Combine
import SwiftUI

// MARK: - View Model

@MainActor
final class CollectionValueViewModel: ObservableObject {
    @Published private(set) var response: PortfolioValueHistoryResponse?
    @Published private(set) var isLoading: Bool = false
    @Published var errorMessage: String?

    private let service: APIService

    init(service: APIService? = nil) {
        self.service = service ?? APIService.shared
    }

    func load() async {
        guard response == nil else { return }
        await refresh()
    }

    func refresh() async {
        isLoading = true
        errorMessage = nil
        do {
            response = try await service.fetchCollectionValueHistory()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Card

struct CollectionValueCard: View {
    @ObservedObject var viewModel: CollectionValueViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HIQSectionHeader("Collection value")

            if let response = viewModel.response {
                loadedContent(response: response)
            } else if viewModel.isLoading {
                loadingState
            } else if let errorMessage = viewModel.errorMessage {
                errorState(message: errorMessage)
            } else {
                // First render before .task fires — keep it quiet.
                loadingState
            }
        }
    }

    // MARK: Loaded content

    @ViewBuilder
    private func loadedContent(response: PortfolioValueHistoryResponse) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            headlineBlock(response: response)
            changeLine(change: response.change30d)
            sparkline(points: response.historySeries)
            topHoldings(rows: response.topHoldings)
            footnote(framing: response.framing)
        }
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Headline (Est. $X · $L–$H)

    private func headlineBlock(response: PortfolioValueHistoryResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(estPrefix(framing: response.framing))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.2)
                Text(response.totalDisplayable.portfolioCurrencyText)
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                    .minimumScaleFactor(0.7)
            }

            if response.rangeHigh > response.rangeLow {
                Text(rangeText(low: response.rangeLow, high: response.rangeHigh))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }

            Text(cardCountSubtitle(response: response))
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.85))
        }
    }

    private func estPrefix(framing: PortfolioValueFraming) -> String {
        framing.isEstimate ? "EST." : "TOTAL"
    }

    private func rangeText(low: Double, high: Double) -> String {
        "\(low.portfolioCurrencyText) – \(high.portfolioCurrencyText)"
    }

    private func cardCountSubtitle(response: PortfolioValueHistoryResponse) -> String {
        // Mirrors the inventory hero's transparency on what's included.
        // Card includes estimated in `totalDisplayable`; pending excluded.
        var parts: [String] = ["\(response.totalCards) cards"]
        if response.observedCount > 0 {
            parts.append("\(response.observedCount) observed")
        }
        if response.estimatedCount > 0 {
            parts.append("\(response.estimatedCount) estimated")
        }
        if response.pendingCount > 0 {
            parts.append("\(response.pendingCount) pending")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: 30d change line

    @ViewBuilder
    private func changeLine(change: PortfolioValueChange30d?) -> some View {
        if let change, shouldShowChange(change) {
            HStack(spacing: 6) {
                Image(systemName: change.absolute >= 0 ? "arrow.up.right" : "arrow.down.right")
                    .font(.caption2.weight(.bold))
                Text(change.absolute.portfolioSignedCurrencyText)
                    .font(.subheadline.weight(.semibold))
                if let percent = change.percent {
                    Text("·")
                        .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    Text(percent.portfolioSignedPercentText)
                        .font(.subheadline.weight(.semibold))
                }
                Text(changeWindowLabel(change: change))
                    .font(.caption)
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            }
            .foregroundStyle(change.absolute >= 0 ? .green : .red)
        }
    }

    private func shouldShowChange(_ change: PortfolioValueChange30d) -> Bool {
        // Suppress the "no real measurement yet" case (single snapshot or
        // baseline == latest with zero delta). Backend forces rangeWeak in
        // those edges; a 0 delta plus nil percent plus rangeWeak means
        // there's nothing to render that wouldn't read as a measurement.
        if change.rangeWeak && change.absolute == 0 && change.percent == nil {
            return false
        }
        return true
    }

    private func changeWindowLabel(change: PortfolioValueChange30d) -> String {
        // "30d" when we have a full window; "since {short date}" when the
        // history doesn't reach back 30 days. The backend's rangeWeak flag
        // does the gating.
        if change.rangeWeak {
            return "since \(shortDate(change.asOfDate))"
        }
        return "30d"
    }

    // MARK: Sparkline

    @ViewBuilder
    private func sparkline(points: [PortfolioValueHistoryPoint]) -> some View {
        if points.count >= 2 {
            CollectionValueSparkline(points: points)
                .frame(height: 64)
                .padding(.top, 4)
        } else {
            sparseHistoryNote(points: points)
        }
    }

    private func sparseHistoryNote(points: [PortfolioValueHistoryPoint]) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.caption.weight(.semibold))
                .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            Text(points.isEmpty
                 ? "Building value history — your trend chart will appear here as daily snapshots accrue."
                 : "Trend chart fills in as more daily snapshots accrue.")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .padding(.vertical, 4)
    }

    // MARK: Top holdings

    @ViewBuilder
    private func topHoldings(rows: [PortfolioValueTopHolding]) -> some View {
        if rows.isEmpty == false {
            VStack(alignment: .leading, spacing: 8) {
                Text("Top holdings")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(HobbyIQTheme.Colors.mutedText)
                    .tracking(1.0)

                VStack(spacing: 6) {
                    ForEach(rows) { row in
                        topHoldingRow(row)
                    }
                }
            }
            .padding(.top, 4)
        }
    }

    private func topHoldingRow(_ row: PortfolioValueTopHolding) -> some View {
        HStack(spacing: 8) {
            Text(row.name)
                .font(.caption.weight(.medium))
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
                .lineLimit(1)
            sourcePill(source: row.source)
            Spacer(minLength: 8)
            Text(row.estValue.portfolioCurrencyText)
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
        }
    }

    private func sourcePill(source: String) -> some View {
        // Visual contract:
        //   observed  → filled electric-blue chip (comp-anchored)
        //   estimated → hairline electric-blue chip (model estimate)
        // Forward-compat: unknown source values fall through to hairline.
        let observed = source == "observed"
        return Text(source.uppercased())
            .font(.system(size: 9, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(observed ? HobbyIQTheme.Colors.pureWhite : HobbyIQTheme.Colors.electricBlue)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                Capsule(style: .continuous)
                    .fill(observed ? HobbyIQTheme.Colors.electricBlue : Color.clear)
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(HobbyIQTheme.Colors.electricBlue.opacity(0.6), lineWidth: 1)
            )
    }

    // MARK: Footnote

    private func footnote(framing: PortfolioValueFraming) -> some View {
        Text(framing.note)
            .font(.caption2)
            .foregroundStyle(HobbyIQTheme.Colors.mutedText.opacity(0.7))
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
    }

    // MARK: Loading / Error states

    private var loadingState: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.mini).tint(HobbyIQTheme.Colors.mutedText)
            Text("Loading collection value…")
                .font(.caption)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    private func errorState(message: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Collection value unavailable")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(HobbyIQTheme.Colors.pureWhite)
            }
            Text(message)
                .font(.caption2)
                .foregroundStyle(HobbyIQTheme.Colors.mutedText)
            Button("Retry") {
                Task { await viewModel.refresh() }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(HobbyIQTheme.Colors.electricBlue)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HobbyIQTheme.Spacing.medium)
        .background(HobbyIQTheme.Colors.cardNavy)
        .overlay(
            RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: HobbyIQTheme.Radius.large, style: .continuous))
    }

    // MARK: Helpers

    private func shortDate(_ ymd: String) -> String {
        // Parse YYYY-MM-DD UTC and reformat as Mon D (e.g. "May 19").
        // Falls back to the raw string so we never crash on a malformed
        // date — the backend writes UTC ISO-style; this is just display.
        let inFmt = DateFormatter()
        inFmt.dateFormat = "yyyy-MM-dd"
        inFmt.timeZone = TimeZone(identifier: "UTC")
        inFmt.locale = Locale(identifier: "en_US_POSIX")
        guard let date = inFmt.date(from: ymd) else { return ymd }
        let outFmt = DateFormatter()
        outFmt.dateFormat = "MMM d"
        outFmt.locale = .current
        return outFmt.string(from: date)
    }
}

// MARK: - Sparkline

/// Lightweight line + filled-area sparkline for the historySeries.
/// Modeled on `PositionPerformanceChartView` (PerformanceView.swift:84):
/// path-based, normalized min/max, electric-blue stroke. No axes / labels
/// — the headline carries the absolute number; the line just shows shape.
struct CollectionValueSparkline: View {
    let points: [PortfolioValueHistoryPoint]

    var body: some View {
        GeometryReader { geo in
            let values = points.map(\.total)
            let minValue = values.min() ?? 0
            let maxValue = values.max() ?? 1
            let range = max(maxValue - minValue, 1)
            let width = geo.size.width
            let height = geo.size.height

            ZStack {
                // Filled area underneath the line for visual weight.
                Path { path in
                    for (index, point) in points.enumerated() {
                        let x = width * CGFloat(index) / CGFloat(max(points.count - 1, 1))
                        let normalizedY = (point.total - minValue) / range
                        let y = height * (1 - CGFloat(normalizedY))
                        if index == 0 {
                            path.move(to: CGPoint(x: x, y: y))
                        } else {
                            path.addLine(to: CGPoint(x: x, y: y))
                        }
                    }
                    path.addLine(to: CGPoint(x: width, y: height))
                    path.addLine(to: CGPoint(x: 0, y: height))
                    path.closeSubpath()
                }
                .fill(
                    LinearGradient(
                        colors: [HobbyIQTheme.Colors.electricBlue.opacity(0.25),
                                 HobbyIQTheme.Colors.electricBlue.opacity(0.0)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )

                // Stroke line on top.
                Path { path in
                    for (index, point) in points.enumerated() {
                        let x = width * CGFloat(index) / CGFloat(max(points.count - 1, 1))
                        let normalizedY = (point.total - minValue) / range
                        let y = height * (1 - CGFloat(normalizedY))
                        if index == 0 {
                            path.move(to: CGPoint(x: x, y: y))
                        } else {
                            path.addLine(to: CGPoint(x: x, y: y))
                        }
                    }
                }
                .stroke(
                    HobbyIQTheme.Colors.electricBlue,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
                )
            }
        }
    }
}
