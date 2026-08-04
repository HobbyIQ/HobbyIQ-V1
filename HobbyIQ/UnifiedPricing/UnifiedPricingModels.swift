//
//  UnifiedPricingModels.swift
//  HobbyIQ
//
//  CF-UNIFIED-PRICING-IOS-REBUILD Session 1 (Drew, 2026-08-04).
//
//  Canonical Swift types that mirror the backend's computeUnifiedPrice
//  contract exactly. Every iOS pricing surface (portfolio hero, Grade
//  Curve, card panel) reads these — matches the SAME numbers the web
//  reads from the same endpoints.
//
//  Backend reference: backend/src/services/compiq/unifiedPricing.service.ts
//    - UnifiedPriceResult
//    - UnifiedGradeEntry
//
//  Persistence contract: every PortfolioHolding.fairMarketValue is
//  unified.marketValue. Every .predictedPrice is unified.predictedPrice.
//  See backend/docs/ios-unified-rebuild-blueprint.md.
//

import Foundation

/// One canonical grade entry from the unified pricing pool.
/// Mirrors backend `UnifiedGradeEntry` field-for-field.
struct UnifiedGradeEntry: Codable, Identifiable, Hashable {
    /// e.g. "PSA 10", "BGS 10", "Raw"
    let grade: String
    /// e.g. "PSA" — nil for Raw
    let gradeCompany: String?
    /// e.g. 10, 9.5 — nil for Raw
    let gradeValue: Double?
    /// Raw past clearing (weighted median, no trend applied).
    let weightedMedian: Double?
    /// Plain (unweighted) median — sanity comparison only.
    let plainMedian: Double?
    /// Number of sold comps in the pool for this grade.
    let sampleCount: Int
    /// 10th percentile price. Nil when sample count < 4.
    let p10: Double?
    /// 90th percentile price. Nil when sample count < 4.
    let p90: Double?
    /// ISO timestamp of the newest observed sale.
    let newestSaleDate: String?
    /// "observed" — grade has real sales in pool.
    /// "estimated" — grade filled from cross-grade multiplier.
    /// "unavailable" — no data (rare grades on obscure cards).
    let valueSource: String
    /// 0-1 confidence score from sample count + recency.
    let confidence: Double
    /// **THE canonical current market value.** Trend-lifted median:
    /// weightedMedian × recent-vs-prior ratio. Matches the web
    /// Grade Curve "MARKET VALUE" number.
    let marketValue: Double?
    /// **THE canonical 7d forward prediction.** wMedian × ratio^1.5.
    /// Matches the web Grade Curve "PREDICTED (7D)" number.
    let predictedPrice: Double?
    /// Trend rate as % per week. Positive = uptrend.
    let trendPctPerWeek: Double?
    /// "up" | "down" | "flat" — quantized from trendPctPerWeek.
    let trendDirection: String

    var id: String { grade }

    // Identifiable stability for Set<> tracking in SwiftUI disclosure
    // state without introducing UUIDs. Grade label is unique per card.

    /// True when this grade has real observed sales — Grade Curve UI
    /// hides the sparkline area and shows an "estimated" chip when
    /// this is false.
    var isObserved: Bool { valueSource == "observed" }

    /// True when there's enough data for a trend to have computed.
    /// Predicted equal to market means the pool was too thin — the
    /// row hides the predicted %delta on this case.
    var hasTrendSignal: Bool {
        guard let predicted = predictedPrice, let market = marketValue else { return false }
        return abs(predicted - market) >= 1.0
    }
}

/// The full result from `computeUnifiedPrice(cardId, {grade})`.
/// Mirrors backend `UnifiedPriceResult` field-for-field.
struct UnifiedPriceResult: Codable, Hashable {
    /// The cardId or hobbyiqCardId the pricing ran for.
    let cardId: String
    /// Weighted median for the requested-grade lookup — nil when no
    /// grade was requested (curve-only response).
    let fmv: Double?
    /// **THE canonical current market value** for the requested grade.
    let marketValue: Double?
    /// **THE canonical 7d forward prediction** for the requested grade.
    let predictedPrice: Double?
    let trendPctPerWeek: Double?
    let trendDirection: String
    /// Per-grade breakdown — every grade with sold_comps in the pool.
    let gradeCurve: [UnifiedGradeEntry]
    /// Adaptive window in days (30/60/90/180) that produced these numbers.
    let windowDays: Int
    /// Total sold comps across ALL grades combined.
    let totalSampleCount: Int
    /// "weighted-median" | "no-basis"
    let method: String
    /// 0-1 overall confidence — from requested-grade entry or comp count.
    let confidence: Double
    /// ISO timestamp when the pricing ran.
    let computedAt: String
}

/// Trend direction cases — Grade Curve UI branches on this for
/// coloring, arrows, and confidence pill visibility.
enum UnifiedTrendDirection: String {
    case up
    case down
    case flat

    init(rawValue: String) {
        switch rawValue.lowercased() {
        case "up": self = .up
        case "down": self = .down
        default: self = .flat
        }
    }

    /// Arrow glyph rendered next to the % delta. Empty for flat so
    /// the UI doesn't over-draw an inert arrow on stable rows.
    var arrow: String {
        switch self {
        case .up: return "↑"
        case .down: return "↓"
        case .flat: return ""
        }
    }
}
