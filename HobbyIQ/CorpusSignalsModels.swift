//
//  CorpusSignalsModels.swift
//  HobbyIQ
//
//  2026-07-17: response models for the ~1M-row baseball comp corpus
//  surfaces — matched-cohort player trend, grade-worthy per-holding
//  analysis, portfolio-wide grade-worthy scan, and family multipliers.
//
//  Backend routes shipped as of prod:
//    - GET /api/portfolio/player-trend/:player           (PR #517)
//    - GET /api/portfolio/holdings/:id/grade-analysis    (PR #518)
//    - GET /api/portfolio/grade-worthy-alerts            (PR #518)
//    - GET /api/portfolio/family-multipliers/:family[/:tier]  (PR #520)
//
//  Every field decodes defensively (try? decodeIfPresent) so a shape
//  drift degrades to a hidden UI block instead of a crash. iOS never
//  renders `servedFrom`, `flags`, `confidence` diagnostic strings raw —
//  they only inform copy + treatment decisions.
//

import Foundation

// MARK: - GET /api/portfolio/player-trend/:player

/// Matched-cohort player-level momentum from the daily-cron nightly cache.
/// The stratified `raw` / `graded` sub-objects arrived in PR #519; if only
/// PR #517-era prod is live, they'll be nil and callers should fall back
/// to the top-level `momentum` / `direction` / `velocityPerWeek`.
struct PlayerTrendResponse: Codable, Hashable {
    let player: String?
    let computedAt: String?
    let momentum: Double?
    let direction: String?
    let velocityPerWeek: Double?
    let cardsInPool: Int?
    let qualifyingCards: Int?
    /// `"sparse"`, `"one_card_dominant"`, `"wide_ratio_dispersion"`, etc.
    /// Drives visual treatment on the inventory-row arrow.
    let flags: [String]?
    let perCardRatios: [PlayerTrendPerCardRatio]?
    /// PR #519 (stratified). Nil when the deployed backend predates it.
    let raw: PlayerTrendStratum?
    /// PR #519 (stratified). Nil when the deployed backend predates it.
    let graded: PlayerTrendStratum?
    /// `"nightly_cache"` / `"on_demand"` — diagnostic, never rendered.
    let servedFrom: String?

    /// (momentum - 1) * 100 formatted as a signed % string. `+48.4%` /
    /// `-12.0%` / `0.0%`. Returns nil when momentum isn't populated.
    var momentumPercentString: String? {
        guard let momentum else { return nil }
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    /// True when `flags` contains the given key. Backend emits lowercase
    /// snake_case so we compare case-insensitively for safety.
    func hasFlag(_ key: String) -> Bool {
        (flags ?? []).contains { $0.lowercased() == key.lowercased() }
    }

    /// Age of the cached snapshot in hours. Used to decide when to
    /// re-fetch — session cache expires at 12h.
    var ageHours: Double? {
        guard let computedAt else { return nil }
        let parsers: [ISO8601DateFormatter] = [
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return f
            }(),
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime]
                return f
            }()
        ]
        guard let date = parsers.compactMap({ $0.date(from: computedAt) }).first else { return nil }
        return Date().timeIntervalSince(date) / 3_600.0
    }
}

/// Sub-object emitted by PR #519 splitting the trend into raw-only vs
/// graded-only. When `graded.momentum > raw.momentum`, the market is
/// rewarding grading on that player right now.
struct PlayerTrendStratum: Codable, Hashable {
    let momentum: Double?
    let direction: String?
    let velocityPerWeek: Double?

    var momentumPercentString: String? {
        guard let momentum else { return nil }
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }
}

struct PlayerTrendPerCardRatio: Codable, Hashable, Identifiable {
    let cardNumber: String?
    let year: Int?
    let ratio: Double?
    let salesLast30: Int?
    let sampleSize: Int?

    var id: String {
        "\(year ?? 0)-\(cardNumber ?? "unknown")"
    }
}

// MARK: - GET /api/portfolio/holdings/:id/grade-analysis

struct GradeAnalysisResponse: Codable, Hashable, Identifiable {
    let holdingId: String
    let player: String?
    let year: Int?
    let cardNumber: String?
    let analysis: GradeAnalysis?
    let diagnostics: GradeAnalysisDiagnostics?

    var id: String { holdingId }
}

struct GradeAnalysis: Codable, Hashable {
    let rawPrice: Double?
    let bestTier: GradeAnalysisTier?
    let allTiers: [GradeAnalysisTier]?
    /// `"grade_now"` / `"grade_worthy_but_wait"` / `"not_worth"` /
    /// `"insufficient_data"`. iOS hides the block entirely for the
    /// bottom two.
    let overallRecommendation: String?
    let reason: String?
}

struct GradeAnalysisTier: Codable, Hashable, Identifiable {
    let graderTier: String
    let gradedMedianPrice: Double?
    let gradedSampleSize: Int?
    let gradingCostAssumed: Double?
    let expectedGain: Double?
    /// Ratio (e.g. 3.74 = 374%). Never rendered raw — always via
    /// `expectedRoiPercentString`.
    let expectedRoi: Double?
    let recommendation: String?
    let reason: String?

    var id: String { graderTier }

    /// "374% ROI" for ≥1.0; "45.6% ROI" (one decimal) for <1.0. Nil when
    /// the wire value is missing.
    var expectedRoiPercentString: String? {
        guard let expectedRoi else { return nil }
        let pct = expectedRoi * 100.0
        if pct >= 100.0 {
            return "\(Int(pct.rounded()))% ROI"
        }
        return String(format: "%.1f%% ROI", pct)
    }
}

struct GradeAnalysisDiagnostics: Codable, Hashable {
    let localCorpusRows: Int?
    let playerMomentum: Double?
    let playerMomentumDirection: String?
}

// MARK: - GET /api/portfolio/grade-worthy-alerts

struct GradeWorthyAlertsResponse: Codable {
    let scannedHoldings: Int?
    let gradeWorthyCount: Int?
    /// Only `grade_now` candidates, sorted by best-tier expectedGain DESC.
    let candidates: [GradeAnalysisResponse]?
}

// MARK: - GET /api/portfolio/family-multipliers/:family[/:tier]

/// PR #520 (in CI at time of iOS build; endpoint may 401/404 on older
/// deploys). Callers treat any error as "no data" and hide the surface.
struct FamilyMultipliersResponse: Codable {
    let familyKey: String?
    let tiers: [FamilyMultiplierTier]?
}

struct FamilyMultiplierTier: Codable, Hashable, Identifiable {
    let graderTier: String
    let multiplier: Double?
    /// `"high"` / `"medium"` / `"low"` — diagnostic, informs
    /// caller-side treatment (e.g. deemphasize low-confidence rows).
    let confidence: String?
    let nGraded: Int?
    let nRaw: Int?
    let medianRawPrice: Double?
    let medianGradedPrice: Double?
    let computedAt: String?

    var id: String { graderTier }
}
