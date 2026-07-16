//
//  PriceHistorySeasonality.swift
//  HobbyIQ
//
//  P1.1 (2026-07-16, seasonality-signals-derivation.md): on-device
//  derivations from the /api/compiq/cards/:cardId/price-history response.
//
//  Every derivation is a pure function of the response; no state, no I/O.
//  Callers request `window=3y, bucket=monthly` for peak/trough/YoY and
//  `window=1y, bucket=weekly` for momentum. Every signal returns nil when
//  the sample-size gate isn't met — callers hide the caption in that case
//  rather than surface a low-confidence signal.
//

import Foundation
import SwiftUI

enum PriceHistorySeasonality {

    // MARK: - Peak / trough month

    /// Calendar month whose median-of-medians across years is highest.
    /// Returns nil when the response has fewer than 12 usable monthly
    /// points. Callers render the returned month via `monthLabel(_:)`.
    static func peakMonth(from points: [PriceHistoryBucketPoint]) -> Int? {
        return extremumMonth(from: points, pick: { $0.max(by: { $0.value < $1.value }) })
    }

    /// Calendar month whose median-of-medians across years is lowest.
    static func troughMonth(from points: [PriceHistoryBucketPoint]) -> Int? {
        return extremumMonth(from: points, pick: { $0.min(by: { $0.value < $1.value }) })
    }

    /// True when the peak and trough are adjacent months (Dec/Jan wraps).
    /// The spec suppresses BOTH captions in that case because the resolution
    /// is too coarse to trust: "peaks in June, softest in May" reads as noise.
    static func peakTroughAreAdjacent(peak: Int?, trough: Int?) -> Bool {
        guard let peak, let trough else { return false }
        let diff = abs(peak - trough)
        return diff == 1 || diff == 11
    }

    /// Human-facing month name for the peak/trough captions.
    static func monthLabel(_ month: Int) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        let symbols = formatter.standaloneMonthSymbols ?? []
        guard (1...12).contains(month), symbols.count >= 12 else { return "" }
        return symbols[month - 1]
    }

    private static func extremumMonth(
        from points: [PriceHistoryBucketPoint],
        pick: ([(month: Int, value: Double)]) -> (month: Int, value: Double)?
    ) -> Int? {
        // Gate: 12+ monthly points before we trust the derivation.
        guard points.count >= 12 else { return nil }

        var perMonth: [Int: [Double]] = [:]
        for point in points {
            guard let date = point.parsedDate, let median = point.medianPrice, median > 0 else { continue }
            let month = Self.calendar.component(.month, from: date)
            perMonth[month, default: []].append(median)
        }

        let monthMedians: [(month: Int, value: Double)] = perMonth.compactMap { entry in
            let (month, values) = entry
            guard let m = Self.median(values) else { return nil }
            return (month, m)
        }
        guard monthMedians.isEmpty == false else { return nil }
        return pick(monthMedians)?.month
    }

    // MARK: - YoY

    /// Signed percentage change: recent-3-month median vs the same 3
    /// calendar months from the prior year. Returns nil when the prior-year
    /// window has zero points (which is common on newer catalog cards).
    static func yoyChange(from points: [PriceHistoryBucketPoint]) -> Double? {
        // Only monthly buckets make sense here — weekly/quarterly would
        // require different windowing. Caller is responsible for passing
        // the monthly response.
        guard points.count >= 4 else { return nil }

        let sorted = points.compactMap { point -> (Date, Double)? in
            guard let date = point.parsedDate, let median = point.medianPrice, median > 0 else { return nil }
            return (date, median)
        }.sorted(by: { $0.0 < $1.0 })

        guard sorted.count >= 4 else { return nil }

        // Recent 3 points (up to the tail).
        let recentSlice = Array(sorted.suffix(3))
        let recentMedians = recentSlice.map { $0.1 }
        guard let recent = Self.median(recentMedians) else { return nil }

        // Prior-year window: 12..15 months earlier than the most recent
        // point. Widened by 1 month at each edge so a partial catalog
        // return (e.g. 11.9-month lag) still lands inside the window.
        guard let latest = sorted.last?.0 else { return nil }
        guard let windowEnd = Self.calendar.date(byAdding: .month, value: -11, to: latest),
              let windowStart = Self.calendar.date(byAdding: .month, value: -15, to: latest) else {
            return nil
        }
        let priorSlice = sorted.filter { $0.0 >= windowStart && $0.0 <= windowEnd }
        guard priorSlice.isEmpty == false else { return nil }
        guard let prior = Self.median(priorSlice.map { $0.1 }) else { return nil }
        guard prior > 0 else { return nil }

        return (recent / prior) - 1.0
    }

    // MARK: - Momentum (weekly slope)

    /// Least-squares slope over the last 12 weekly medians, normalized to
    /// mean price so the return is a % per week. Sample-size gate: 6+
    /// usable weekly points. Callers glyph the return via `momentumGlyph(_:)`.
    static func weeklyMomentum(from points: [PriceHistoryBucketPoint]) -> Double? {
        let sorted = points
            .compactMap { point -> Double? in
                guard let median = point.medianPrice, median > 0, point.parsedDate != nil else { return nil }
                return median
            }
        let tail = Array(sorted.suffix(12))
        guard tail.count >= 6 else { return nil }

        let xs = (0..<tail.count).map(Double.init)
        let ys = tail
        let n = Double(tail.count)
        let sumX = xs.reduce(0, +)
        let sumY = ys.reduce(0, +)
        let sumXY = zip(xs, ys).map(*).reduce(0, +)
        let sumX2 = xs.map { $0 * $0 }.reduce(0, +)

        let denom = (n * sumX2) - (sumX * sumX)
        guard denom != 0 else { return nil }
        let slope = ((n * sumXY) - (sumX * sumY)) / denom
        let meanY = sumY / n
        guard meanY > 0 else { return nil }
        return slope / meanY
    }

    /// ▲ / ▼ / ─ per the ±2% threshold in the spec.
    static func momentumGlyph(_ slope: Double?) -> String {
        guard let slope else { return "" }
        if slope >= 0.02 { return "\u{25B2}" }
        if slope <= -0.02 { return "\u{25BC}" }
        return "\u{2500}"
    }

    /// Color for the momentum glyph — green on up, red on down, muted gray
    /// when flat / unavailable.
    static func momentumColor(_ slope: Double?) -> Color {
        guard let slope else { return .gray }
        if slope >= 0.02 { return .green }
        if slope <= -0.02 { return .red }
        return .gray
    }

    // MARK: - YoY formatting

    /// "▲ 18% YoY" / "▼ 12% YoY" / "─ Flat YoY". Rounds < 2% to the flat
    /// bucket per the spec — 1% market noise isn't a signal.
    static func yoyLabel(_ change: Double?) -> String? {
        guard let change else { return nil }
        let magnitude = abs(change) * 100.0
        if magnitude < 2.0 { return "\u{2500} Flat YoY" }
        let glyph = change >= 0 ? "\u{25B2}" : "\u{25BC}"
        return "\(glyph) \(Int(magnitude.rounded()))% YoY"
    }

    /// Green when up, red when down, muted gray when flat.
    static func yoyColor(_ change: Double?) -> Color {
        guard let change else { return .gray }
        let magnitude = abs(change) * 100.0
        if magnitude < 2.0 { return .gray }
        return change >= 0 ? .green : .red
    }

    // MARK: - Internal helpers

    private static let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        return cal
    }()

    private static func median(_ values: [Double]) -> Double? {
        guard values.isEmpty == false else { return nil }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 0 {
            return (sorted[mid - 1] + sorted[mid]) / 2.0
        }
        return sorted[mid]
    }
}
