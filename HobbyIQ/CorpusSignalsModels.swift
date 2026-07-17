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
    /// PR #530: backend-derived family key (e.g. `"bowman_chrome_baseball"`)
    /// so iOS can call `/family-multipliers/:family` without re-slugging
    /// the setName. Nil when the compute couldn't resolve a family.
    let familyKey: String?
    /// PR #530: tiers where the backend blended in family-level medians
    /// because the per-SKU pool was thin. Informational; iOS can caption
    /// "Estimated from family median" on those tier rows.
    let familyBlendedTiers: [String]?
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

// MARK: - GET /api/portfolio/momentum (PR #529)

/// Value-weighted portfolio-level trend. Feeds the Portfolio Momentum
/// hero on the Portfolio Home tab. `impliedPortfolioDelta` is the dollar
/// swing implied by the current momentum applied to the portfolio's
/// value — a scaled version of what an untracked user would see as
/// "unrealized gain over the last month."
struct PortfolioMomentumResponse: Codable {
    let computedAt: String?
    let scannedHoldings: Int?
    let holdingsWithTrend: Int?
    let portfolioMomentum: Double?
    let direction: String?
    let cardsUp: Int?
    let cardsFlat: Int?
    let cardsDown: Int?
    let cardsUntracked: Int?
    let topMovers: [PortfolioMoverEntry]?
    let worstMovers: [PortfolioMoverEntry]?
    let impliedPortfolioDelta: Double?

    /// "(momentum - 1) * 100" formatted with one decimal + signed prefix.
    var momentumPercentString: String? {
        guard let momentum = portfolioMomentum else { return nil }
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }
}

struct PortfolioMoverEntry: Codable, Hashable, Identifiable {
    let holdingId: String?
    let playerName: String?
    let momentum: Double?
    let direction: String?
    /// Dollar contribution to the portfolio's implied gain/loss.
    let contributionUsd: Double?

    var id: String { holdingId ?? UUID().uuidString }

    var momentumPercentString: String? {
        guard let momentum else { return nil }
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }
}

// MARK: - GET /api/dailyiq/hot-right-now (PR #529)

struct HotRightNowResponse: Codable {
    let computedAt: String?
    let count: Int?
    let players: [HotPlayer]?
}

struct HotPlayer: Codable, Hashable, Identifiable {
    let player: String?
    let momentum: Double?
    let direction: String?
    let velocityPerWeek: Double?
    let qualifyingCards: Int?
    let cardsInPool: Int?
    let flags: [String]?
    /// Diagnostic — never rendered.
    let hotScore: Double?

    var id: String { player ?? UUID().uuidString }

    var momentumPercentString: String? {
        guard let momentum else { return nil }
        let pct = (momentum - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }

    func hasFlag(_ key: String) -> Bool {
        (flags ?? []).contains { $0.lowercased() == key.lowercased() }
    }
}

// PR #526's TimingForecastResponse + sub-types removed 2026-07-17 —
// the standalone timing-forecast surface was consolidated into
// PREDICTED (7d) via backend PR #543. Backend endpoint stays live for
// potential future consumers; iOS just doesn't consume it.

// MARK: - GET /api/portfolio/cascade-alerts (PR #527)

struct CascadeAlertsResponse: Codable {
    let ownedPlayers: Int?
    let events: [CascadeEvent]?
}

struct CascadeEvent: Codable, Hashable, Identifiable {
    let player: String?
    let detectedAt: String?
    /// `"insider"` / `"emerging"` / `"confirmed"`.
    let severity: String?
    let reason: String?
    let detectionInput: CascadeDetectionInput?

    var id: String {
        "\(player ?? "?")::\(detectedAt ?? "?")"
    }

    /// Priority for the banner's "top event" pick: insider > emerging > confirmed.
    var severityRank: Int {
        switch severity?.lowercased() {
        case "insider": return 3
        case "emerging": return 2
        case "confirmed": return 1
        default: return 0
        }
    }
}

struct CascadeDetectionInput: Codable, Hashable {
    let rawMomentum: Double?
    let gradedMomentum: Double?
    let momentumRatio: Double?
    let gradedDirection: String?
    let rawQualifyingCards: Int?
    let gradedQualifyingCards: Int?
    let playerTrendComputedAt: String?
}

// MARK: - GET /api/portfolio/i-called-it (PR #533)

struct ICalledItResponse: Codable {
    let count: Int?
    let moments: [FlexMoment]?
}

struct FlexMoment: Codable, Hashable, Identifiable {
    let holdingId: String?
    let player: String?
    let cardTitle: String?
    let eventType: String?
    let originalPrice: Double?
    let currentMarketValue: Double?
    let gainPct: Double?
    let gainUsd: Double?
    let eventDate: String?
    let shareablePayload: FlexShareablePayload?

    var id: String { holdingId ?? UUID().uuidString }
}

struct FlexShareablePayload: Codable, Hashable {
    let headline: String?
    let subline: String?
    let cta: String?
    let cardTitleShort: String?
}

// MARK: - GET /api/portfolio/yearbook (PR #533)

struct YearbookResponse: Codable {
    let period: String?
    let generatedAt: String?
    let totalRealizedGainUsd: Double?
    let totalUnrealizedGainUsd: Double?
    let totalCostBasis: Double?
    let totalCurrentValue: Double?
    let cardsBought: Int?
    let cardsSold: Int?
    let cardsHeld: Int?
    let topPerformers: [YearbookPerformer]?
    let biggestMisses: [YearbookPerformer]?
    let whatIfHeldAll: YearbookCounterfactual?
}

struct YearbookPerformer: Codable, Hashable, Identifiable {
    let player: String?
    let gainPct: Double?
    let gainUsd: Double?

    var id: String { player ?? UUID().uuidString }
}

struct YearbookCounterfactual: Codable, Hashable {
    let counterfactualCurrentValue: Double?
    let opportunityCostUsd: Double?
    let note: String?
}

// MARK: - GET /api/portfolio/parallel-ladder/:playerYearSet (PR #538)

/// Observed parallel-tier multiplier ladder for a (player, year, cardSet)
/// bucket. Feeds the card-detail Parallel Ladder block. Suppressed
/// backend-side when Base has < 5 sales — `suppressedReason` explains why.
struct ParallelLadderResponse: Codable {
    let bucket: ParallelLadderBucket?
}

struct ParallelLadderBucket: Codable, Hashable {
    let player: String?
    let year: Int?
    let cardSet: String?
    let baseMedianPrice: Double?
    let ladder: [ParallelLadderRung]?
    /// `"high"` / `"medium"` / `"low"` / `"insufficient"`.
    let confidence: String?
    /// `"no_sales"` / `"base_thin"` / nil when populated.
    let suppressedReason: String?
}

struct ParallelLadderRung: Codable, Hashable, Identifiable {
    let variant: String
    let medianPrice: Double?
    /// Ratio vs Base median. Base always 1.0, non-Base > 1.0.
    let multiplier: Double?
    let n: Int?
    /// "Gold /50" → 50. Nil when unnumbered.
    let printRun: Int?

    var id: String { variant }
}

// MARK: - GET /api/portfolio/attribution-health (PR #538)

struct AttributionHealthResponse: Codable {
    let scannedHoldings: Int?
    let suspectCount: Int?
    let suspects: [AttributionHealthSuspect]?
}

struct AttributionHealthSuspect: Codable, Hashable, Identifiable {
    let holdingId: String
    let player: String?
    let cardTitle: String?
    let cardId: String?
    /// 0..1 — largest_cluster / total. < 0.85 → surface as low_confidence.
    let attributionScore: Double?
    let confidence: String?
    let reason: String?
    let otherCandidates: [AttributionOtherCandidate]?

    var id: String { holdingId }
}

struct AttributionOtherCandidate: Codable, Hashable {
    let cardId: String?
    let confidence: String?
}

// MARK: - GET /api/portfolio/sell-now-radar (PR #539)

struct SellNowRadarResponse: Codable {
    let count: Int?
    let candidates: [SellRadarCandidate]?
}

struct SellRadarCandidate: Codable, Hashable, Identifiable {
    let holdingId: String
    let player: String?
    let cardTitle: String?
    let graderTier: String?
    let currentMarketValue: Double?
    let purchasePrice: Double?
    let unrealizedGainUsd: Double?
    let velocityPerWeek: Double?
    let velocityBaseline: Double?
    let velocityMultiple: Double?
    let playerMomentum: Double?
    /// `"up"` / `"flat"` / `"down"`.
    let playerDirection: String?
    let reason: String?
    /// 0..1 diagnostic — used to sort. Not rendered.
    let urgencyScore: Double?

    var id: String { holdingId }

    var playerMomentumPercentString: String? {
        guard let m = playerMomentum else { return nil }
        let pct = (m - 1.0) * 100.0
        let sign = pct > 0 ? "+" : (pct < 0 ? "\u{2212}" : "")
        return "\(sign)\(String(format: "%.1f", abs(pct)))%"
    }
}

// MARK: - GET /api/portfolio/notable-sales (PR #539)

struct NotableSalesResponse: Codable {
    let count: Int?
    let sales: [NotableSale]?
}

struct NotableSale: Codable, Hashable, Identifiable {
    let cardId: String?
    let player: String?
    let year: Int?
    let cardSet: String?
    let variant: String?
    let number: String?
    let grade: String?
    let grader: String?
    let price: Double?
    let saleDate: String?
    let imageUrl: String?
    let listingUrl: String?
    /// `"eBay"` / `"Goldin"` / `"Heritage"` / `"Fanatics Collect"` /
    /// `"Private"` (backend-derived from the listing URL's domain).
    let sourceLabel: String?

    var id: String {
        cardId ?? "\(saleDate ?? "?")::\(price ?? 0)"
    }
}

// MARK: - GET /api/portfolio/sub-raw-discovery (PR #531/#541/#542)

struct SubRawDiscoveryResponse: Codable {
    let count: Int?
    let candidates: [SubRawCandidate]?
}

struct SubRawCandidate: Codable, Hashable, Identifiable {
    let cardId: String
    let player: String?
    let year: Int?
    let cardSet: String?
    let variant: String?
    let number: String?
    let medianRawPrice: Double?
    let familyKey: String?
    let familyPsa10Multiplier: Double?
    /// `"high"` / `"medium"` / `"low"`.
    let familyPsa10Confidence: String?
    let expectedPsa10Price: Double?
    let gradingCostAssumed: Double?
    let expectedGain: Double?
    /// (expectedPsa10Price − rawPrice − gradingCost) / rawPrice.
    let expectedGainMultiple: Double?
    let rawComps: Int?
    let imageUrl: String?

    var id: String { cardId }

    /// "3.8×" per the spec — never render bare decimal.
    var multipleString: String? {
        guard let m = expectedGainMultiple, m > 0 else { return nil }
        return String(format: "%.1f\u{00D7}", m)
    }
}

// MARK: - GET /api/portfolio/missing-parallels (PR #531)

/// Wraps the full-portfolio scan response — `bundles` is one entry per
/// (player, year, cardSet) the user has ≥1 card in.
struct MissingParallelsResponse: Codable {
    let count: Int?
    let bundles: [MissingParallelsBundle]?
}

/// Single-bucket read (`GET /missing-parallels/:playerYearSet`).
struct MissingParallelsBucketResponse: Codable {
    let bucket: MissingParallelsBundle?
}

struct MissingParallelsBundle: Codable, Hashable, Identifiable {
    let player: String?
    let year: Int?
    let cardSet: String?
    let ownedVariants: [String]?
    let missingParallels: [MissingParallelEntry]?

    var id: String {
        "\(player ?? "?")::\(year ?? 0)::\(cardSet ?? "?")"
    }
}

struct MissingParallelEntry: Codable, Hashable, Identifiable {
    let cardId: String
    let variant: String?
    let number: String?
    let recentSales: Int?
    let medianPrice: Double?
    let imageUrl: String?

    var id: String { cardId }
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
