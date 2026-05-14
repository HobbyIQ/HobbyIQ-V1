import Foundation

// MARK: - API Base URL
let baseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

// MARK: - Search / Price Models
struct CardSearchRequest: Codable {
    let query: String
}

struct MarketTier: Codable {
    let entry: Double?
    let fair: Double?
    let premium: Double?
}

struct MarketSupply: Codable {
    let activeListings: Int?
    let trend2w: Double?
    let trend4w: Double?
    let trend3m: Double?
}

struct CardSearchResponse: Codable {
    let success: Bool?
    let query: String?
    let summary: String?
    let marketTier: MarketTier?
    let buyZone: [Double]?
    let holdZone: [Double]?
    let sellZone: [Double]?
    let confidence: Double?
    let source: String?
    let supply: MarketSupply?
}

// MARK: - CompIQ Bulk Estimate Models

struct CompIQEvidenceComp: Codable {
    let salePrice: Double
    let normalizedPrice: Double
    let date: String?
    let daysAgo: Int?
    let parallel: String?
    let grade: String?
    let priority: Int
    let priorityScore: Double
    let reasonCodes: [String]
    let trace: String
}

struct CompIQEstimateResult: Codable {
    let value: Double
    let suggestedListPrice: Double?
    let minAcceptableOffer: Double?
    let quickSaleValue: Double?
    let sellFormat: String?
    let sellFormatReason: String?
    let fairValue: Double
    let lowValue: Double
    let highValue: Double
    let confidence: Double
    let confidenceScore: Double?
    let method: String
    let compCount: Int
    let targetParallel: String
    let anchorParallel: String?
    let usedNeighboringComps: Bool?
    let neighborCompReason: String?
    let driftFactor: Double?
    let todaySignalMultiplier: Double?
    let todaySignalNotes: [String]?
    let askSpreadPct: Double?
    let velocityAcceleration: Double?
    let playerEvent: String?
    let dataFreshnessWarning: String?
    let signal24hMultiplier: Double?
    let signal24hNotes: [String]?
    let signal24hMomentum: String?
    let compTrendMultiplier: Double?
    let compTrendSlopePerDay: Double?
    let compTrendPctPerWeek: Double?
    let compTrendRSquared: Double?
    let compTrendConfidence: String?
    let compTrendPredictedToday: Double?
    let multiplierUsed: Double
    let scarcityAdjustment: Double
    let trendAdjustment: Double
    let gradeAdjustment: Double
    let learningAdjustment: Double?
    let liquidityAdjustment: Double?
    let mlCorrectionFactor: Double?
    let mlSampleCount: Int?
    let trending: Bool?
    let trendDirection: String?
    let trendStrength: String?
    let trendVelocityPct: Double?
    let newestCompAge: Int?
    let forwardValue30d: Double?
    let bearValue30d: Double?
    let bullValue30d: Double?
    let projectedValue: Double?
    let momentumScore: Double?
    let outlook: String?
    let outlookNote: String?
    let investmentScore: Double?
    let investmentRating: String?
    let investmentRatingKey: String?
    let upside30d: Double?
    let downside30d: Double?
    let recommendedHoldDays: Int?
    let evidenceQualityScore: Double?
    let evidenceQualityLevel: String?
    let evidenceReasons: [String]?
    let recommendedAction: String?
    let actionEntryMax: Double?
    let actionTrimMin: Double?
    let actionStopLoss: Double?
    let actionRecheckDays: Int?
    let actionRationale: String?
    let evidenceComps: [CompIQEvidenceComp]?
    let playerSignal: String?
    let newsSignal: String?
    let gemRateSignal: String?
    let summary: String?
    let explanation: String?
    let pricingPath: [String]?
    let derivedDemandScore: Double?
    let derivedMarketHeat: Double?
    let demandSignalNote: String?
    let supplySignalNote: String?
    let marketRegimeScore: Double?
    let marketRegimeLabel: String?
    let stalenessPenalty: Double?
    let listingMarkupPct: Double?
    // Grade-aware fields (populated by priceCard)
    let gradeDetected: String?
    let parallelDetected: String?

    // Buy Window Score (1–10) — "Is now a good time to buy this card?"
    var buyWindowScore: Int? = nil
    var buyWindowLabel: String? = nil
    var buyWindowReasons: [String]? = nil

    // Confidence interval around the predicted price
    var confidenceInterval: ConfidenceInterval? = nil

    // Pricing-accuracy v2 (additive — backend may omit on older payloads)
    var compQuality: CompQualityInfo? = nil
    var graderPremium: GraderPremiumInfo? = nil
    var dataSufficiency: DataSufficiency? = nil
}

/// Price range around the predicted estimate, with a qualitative width tag.
struct ConfidenceInterval: Codable {
    var low: Double
    var high: Double
    var width: String       // "narrow" | "moderate" | "wide"
    var explanation: String
}

/// How many of the fetched sales actually contributed to the estimate.
struct CompQualityInfo: Codable {
    var totalComps: Int
    var usedComps: Int
    var excluded: Int
    var reasons: [String: Int]?
}

/// Grader-premium multiplier applied to land the raw anchor in the
/// requested grade band (e.g. PSA 10).
struct GraderPremiumInfo: Codable {
    var applied: Double
    var company: String?
    var grade: Double?
    var normalizedAnchor: Double?
}

/// Backend's verdict on whether there were enough usable comps to publish
/// a point price. When `sufficient == false`, the price lanes are nil.
struct DataSufficiency: Codable {
    var sufficient: Bool
    var level: String   // "none" | "very_thin" | "thin" | "adequate"
    var message: String
}

// MARK: - PortfolioIQ Bulk Reprice Models (/api/compiq/bulk)

struct CompIQBulkPriceMarketTier: Codable {
    let value: Double?
    let high: Double?
}

struct CompIQBulkPriceTrendAnalysis: Codable {
    let market_direction: String?
    let liquidity: String?
}

struct CompIQBulkPriceData: Codable {
    let summary: String?
    let marketTier: CompIQBulkPriceMarketTier?
    let trendAnalysis: CompIQBulkPriceTrendAnalysis?
    let source: String?
    let confidence: Double?
}

struct CompIQBulkPriceResult: Codable {
    let query: String
    let status: String
    let data: CompIQBulkPriceData?
    let error: String?
}

struct CompIQBulkPriceResponse: Codable {
    let requested: Int
    let succeeded: Int
    let failed: Int
    let results: [CompIQBulkPriceResult]
}

// MARK: - Simple Estimate (new flat endpoint)
struct CompIQPriceRequest: Codable {
    let playerName: String
    let cardYear: Int?
    let product: String
    let parallel: String?
    let grade: String?
    let isAuto: Bool?
}

struct CompIQPricingAnalytics: Codable {
    let projectedNextSale: Double?
    let rSquared: Double?
    let compsUsed: Int?
    let gradeDetected: String?
    let parallelDetected: String?
}

struct CompIQPriceMarketDNA: Codable {
    let trend: String?
    let liquidity: String?
    let trendConfidence: Double?
    let surroundingMovement: Double?
    let anchorAge: Int?
}

struct CompIQPriceZones: Codable {
    let buy: [Double]?
    let hold: [Double]?
    let sell: [Double]?
}

/// Broader-pool trend signal returned alongside the FMV.
/// Anchor (price) comes from the exact card_id; this object describes the
/// direction signal computed from ALL similar cards in the same
/// player + year + set pool, so the UI can show the user where the broader
/// market is heading even when the exact card has too few direct comps.
///
/// Server emits direction as "up" | "down" | "flat" (legacy) or
/// "rising" | "falling" | "stable" (v3 spec). Both decode cleanly because
/// the field is a free-form String.
/// `basedOn` is "broader" / "broader_pool" when the trend is backed by
/// sibling-card sales, "exact" when only exact comps were available, or
/// "insufficient" when the windows were too thin to call a direction.
struct CompIQBroaderTrend: Codable {
    let impliedTrendPct: Double?
    let direction: String?
    let recentMedian: Double?
    let olderMedian: Double?
    let recentCount: Int?
    let olderCount: Int?
    let similarCardsScanned: Int?
    let totalSamples: Int?
    let basedOn: String?

    /// True when the trend is backed by the broader sibling-card pool
    /// (matches both the legacy "broader" and the v3 "broader_pool" values).
    var isBroaderPool: Bool {
        let v = basedOn?.lowercased() ?? ""
        return v == "broader" || v == "broader_pool"
    }

    /// Human-readable label: "Rising" | "Falling" | "Stable".
    var directionLabel: String {
        switch (direction ?? "").lowercased() {
        case "up", "rising":   return "Rising"
        case "down", "falling": return "Falling"
        default:                return "Stable"
        }
    }

    /// Arrow glyph for the directional pill.
    var directionArrow: String {
        switch (direction ?? "").lowercased() {
        case "up", "rising":    return "↑"
        case "down", "falling": return "↓"
        default:                return "→"
        }
    }
}

struct CompIQPriceResponse: Codable {
    let fairMarketValue: Double?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let recommendation: String?
    let summary: String?
    let confidence: Double?
    let marketDNA: CompIQPriceMarketDNA?
    let pricingAnalytics: CompIQPricingAnalytics?
    let zones: CompIQPriceZones?
    let broaderTrend: CompIQBroaderTrend?

    // Pricing Accuracy v2 — new fields from backend (all optional)
    let compQuality: CompQualityInfo?
    let graderPremium: GraderPremiumInfo?
    let dataSufficiency: DataSufficiency?
    let buyWindowScore: Int?
    let buyWindowLabel: String?
    let buyWindowReasons: [String]?
    let confidenceInterval: ConfidenceInterval?

    /// Map to the rich CompIQEstimateResult that CompIQView uses.
    func asEstimateResult(requestedParallel: String?) -> CompIQEstimateResult {
        let fmv = fairMarketValue ?? 0
        // Use authoritative zone boundaries from server; fall back to percentages
        let buyLow   = zones?.buy?.first  ?? (fmv * 0.82)   // quick-sale floor
        let buyHigh  = zones?.buy?.last   ?? (fmv * 0.93)   // entry max (top of buy zone)
        let sellLow  = zones?.sell?.first ?? (fmv * 1.05)   // trim min (bottom of sell zone)
        let sellHigh = zones?.sell?.last  ?? (fmv * 1.25)   // premium ceiling
        let qsv = buyLow
        let pv  = sellHigh
        let conf = confidence ?? 0.5
        let comps = pricingAnalytics?.compsUsed ?? 0
        let parallel = pricingAnalytics?.parallelDetected ?? requestedParallel ?? "Base"
        let action = recommendation ?? "hold"
        let outlook: String
        switch action.lowercased() {
        case "strong-buy", "buy": outlook = "buy"
        case "sell", "reduce":    outlook = "sell"
        default:                  outlook = "hold"
        }
        var enriched = CompIQEstimateResult(
            value: fmv,
            suggestedListPrice: sellLow,
            minAcceptableOffer: qsv,
            quickSaleValue: qsv,
            sellFormat: "eBay BIN w/ Best Offer",
            sellFormatReason: nil,
            fairValue: fmv,
            lowValue: qsv,
            highValue: pv,
            confidence: conf,
            confidenceScore: conf * 100,
            method: comps > 0 ? "exact-recent-comps" : "baseline-multiplier-fallback",
            compCount: comps,
            targetParallel: parallel,
            anchorParallel: nil,
            usedNeighboringComps: nil,
            neighborCompReason: nil,
            driftFactor: nil,
            todaySignalMultiplier: nil,
            todaySignalNotes: nil,
            askSpreadPct: nil,
            velocityAcceleration: nil,
            playerEvent: nil,
            dataFreshnessWarning: nil,
            signal24hMultiplier: nil,
            signal24hNotes: nil,
            signal24hMomentum: nil,
            compTrendMultiplier: nil,
            compTrendSlopePerDay: nil,
            compTrendPctPerWeek: nil,
            compTrendRSquared: nil,
            compTrendConfidence: nil,
            compTrendPredictedToday: nil,
            multiplierUsed: 1.0,
            scarcityAdjustment: 1.0,
            trendAdjustment: 1.0,
            gradeAdjustment: 1.0,
            learningAdjustment: nil,
            liquidityAdjustment: nil,
            mlCorrectionFactor: nil,
            mlSampleCount: nil,
            trending: (marketDNA?.trend == "up" || marketDNA?.trend == "down") ? true : nil,
            trendDirection: marketDNA?.trend,
            trendStrength: nil,
            trendVelocityPct: nil,
            newestCompAge: marketDNA?.anchorAge,
            forwardValue30d: nil,
            bearValue30d: fmv * 0.85,
            bullValue30d: pv,
            projectedValue: pricingAnalytics?.projectedNextSale,
            momentumScore: nil,
            outlook: outlook,
            outlookNote: nil,
            investmentScore: nil,
            investmentRating: nil,
            investmentRatingKey: nil,
            upside30d: nil,
            downside30d: nil,
            recommendedHoldDays: nil,
            evidenceQualityScore: conf * 100,
            evidenceQualityLevel: conf >= 0.72 ? "high" : conf >= 0.45 ? "medium" : "low",
            evidenceReasons: nil,
            recommendedAction: action,
            actionEntryMax: buyHigh,
            actionTrimMin: sellLow,
            actionStopLoss: fmv * 0.75,
            actionRecheckDays: 7,
            actionRationale: summary,
            evidenceComps: nil,
            playerSignal: nil,
            newsSignal: nil,
            gemRateSignal: nil,
            summary: summary,
            explanation: summary,
            pricingPath: nil,
            derivedDemandScore: nil,
            derivedMarketHeat: nil,
            demandSignalNote: nil,
            supplySignalNote: marketDNA?.liquidity.map { "Liquidity: \($0)" },
            marketRegimeScore: nil,
            marketRegimeLabel: marketDNA?.trend.map { $0.capitalized + " market" },
            stalenessPenalty: nil,
            listingMarkupPct: 5.0,
            gradeDetected: pricingAnalytics?.gradeDetected,
            parallelDetected: pricingAnalytics?.parallelDetected
        )
        enriched.buyWindowScore = buyWindowScore
        enriched.buyWindowLabel = buyWindowLabel
        enriched.buyWindowReasons = buyWindowReasons
        enriched.confidenceInterval = confidenceInterval
        enriched.compQuality = compQuality
        enriched.graderPremium = graderPremium
        enriched.dataSufficiency = dataSufficiency
        return enriched
    }
}

// MARK: - DailyIQ Models

struct DailyBriefMarketDNA: Codable {
    let demand: String?
    let speed: String?
    let risk: String?
    let trend: String?
}

struct DailyStats: Codable {
    let hits: Int
    let atBats: Int
    let runs: Int
    let rbis: Int
    let homeRuns: Int
    let strikeouts: Int
    let walks: Int
    let battingAverage: String
    let ops: String
    // pitcher-only
    let statsType: String?       // "batting" or "pitching"
    let inningsPitched: String?
    let earnedRuns: Int?
    let pitchCount: Int?

    enum CodingKeys: String, CodingKey {
        case hits, atBats, runs, rbis, rbi, homeRuns, strikeouts, walks, battingAverage, ops
        case statsType, inningsPitched, earnedRuns, pitchCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hits           = try c.decodeIfPresent(Int.self,    forKey: .hits)           ?? 0
        atBats         = try c.decodeIfPresent(Int.self,    forKey: .atBats)         ?? 0
        runs           = try c.decodeIfPresent(Int.self,    forKey: .runs)           ?? 0
        rbis           = try c.decodeIfPresent(Int.self,    forKey: .rbis)           ?? c.decodeIfPresent(Int.self, forKey: .rbi) ?? 0
        homeRuns       = try c.decodeIfPresent(Int.self,    forKey: .homeRuns)       ?? 0
        strikeouts     = try c.decodeIfPresent(Int.self,    forKey: .strikeouts)     ?? 0
        walks          = try c.decodeIfPresent(Int.self,    forKey: .walks)          ?? 0
        battingAverage = try c.decodeIfPresent(String.self, forKey: .battingAverage) ?? ".000"
        ops            = try c.decodeIfPresent(String.self, forKey: .ops)            ?? ".000"
        statsType      = try c.decodeIfPresent(String.self, forKey: .statsType)
        inningsPitched = try c.decodeIfPresent(String.self, forKey: .inningsPitched)
        earnedRuns     = try c.decodeIfPresent(Int.self,    forKey: .earnedRuns)
        pitchCount     = try c.decodeIfPresent(Int.self,    forKey: .pitchCount)
    }
}

struct SeasonStats: Codable {
    let battingAverage: String
    let homeRuns: Int
    let rbis: Int
    let obp: String
    let slg: String
    let ops: String
    let walks: Int
    let strikeouts: Int
    let walkToStrikeout: String?
    // pitcher-only
    let statsType: String?       // "batting" or "pitching"
    let era: String?
    let wins: Int?
    let losses: Int?
    let saves: Int?
    let whip: String?
    let gamesStarted: Int?

    enum CodingKeys: String, CodingKey {
        case battingAverage, homeRuns, rbis, rbi
        case obp, onBasePercentage
        case slg, sluggingPercentage
        case ops, walks, strikeouts, walkToStrikeout
        case statsType, era, wins, losses, saves, whip, gamesStarted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        battingAverage  = try c.decodeIfPresent(String.self, forKey: .battingAverage)  ?? ".000"
        homeRuns        = try c.decodeIfPresent(Int.self,    forKey: .homeRuns)        ?? 0
        rbis            = try c.decodeIfPresent(Int.self,    forKey: .rbis)            ?? c.decodeIfPresent(Int.self, forKey: .rbi) ?? 0
        obp             = try c.decodeIfPresent(String.self, forKey: .obp)             ?? c.decodeIfPresent(String.self, forKey: .onBasePercentage) ?? ".000"
        slg             = try c.decodeIfPresent(String.self, forKey: .slg)             ?? c.decodeIfPresent(String.self, forKey: .sluggingPercentage) ?? ".000"
        ops             = try c.decodeIfPresent(String.self, forKey: .ops)             ?? ".000"
        walks           = try c.decodeIfPresent(Int.self,    forKey: .walks)           ?? 0
        strikeouts      = try c.decodeIfPresent(Int.self,    forKey: .strikeouts)      ?? 0
        walkToStrikeout = try c.decodeIfPresent(String.self, forKey: .walkToStrikeout)
        statsType       = try c.decodeIfPresent(String.self, forKey: .statsType)
        era             = try c.decodeIfPresent(String.self, forKey: .era)
        wins            = try c.decodeIfPresent(Int.self,    forKey: .wins)
        losses          = try c.decodeIfPresent(Int.self,    forKey: .losses)
        saves           = try c.decodeIfPresent(Int.self,    forKey: .saves)
        whip            = try c.decodeIfPresent(String.self, forKey: .whip)
        gamesStarted    = try c.decodeIfPresent(Int.self,    forKey: .gamesStarted)
    }
}

struct DailyPerformer: Codable, Identifiable {
    var id: String { playerId }
    let playerId: String
    let playerName: String
    let team: String
    let league: String
    let level: String?
    let position: String?
    let dailyStats: DailyStats
    let seasonStats: SeasonStats

    var isPitcher: Bool {
        guard let pos = position else { return false }
        return ["SP", "RP", "CL"].contains(pos)
    }
}

struct DailyBriefResponse: Codable {
    let date: String
    let generatedAt: String
    let mlb: [DailyPerformer]
    let milb: [DailyPerformer]
}

struct DailyWatchPlayer: Codable, Identifiable {
    var id: String { playerName.lowercased() }

    let playerName: String
    let battingAverage: String?
    let homeRuns: Int?
    let rbis: Int?
    let obp: String?
    let slg: String?
    let ops: String?
    let walks: Int?
    let strikeouts: Int?
    let walkToStrikeout: String?
    let lastGameDate: String?
    let statLine: String?
    let played: Bool?
    let trend: String?
    let buySignal: Bool?
    let performanceNote: String?
    let team: String?
    let position: String?
    let level: String?
    let noGameMessage: String?
}

struct DailyWatchlistItem: Codable, Identifiable {
    let playerId: String
    let playerName: String
    let team: String?
    let league: String?
    let level: String?
    let position: String?
    let addedAt: String?
    let dailyStats: DailyStats?
    let seasonStats: SeasonStats?
    let recentForm: RecentForm?
    let tomorrowMatchup: TomorrowMatchup?

    var id: String { playerId }

    var isPitcher: Bool {
        guard let pos = position else { return false }
        return ["SP", "RP", "CL", "P"].contains(pos)
    }
}

struct RecentFormSplit: Codable {
    let games: Int
    // hitter
    let atBats: Int?
    let hits: Int?
    let homeRuns: Int?
    let rbis: Int?
    let runs: Int?
    let walks: Int?
    let strikeouts: Int?
    let battingAverage: String?
    let ops: String?
    // pitcher
    let inningsPitched: String?
    let earnedRuns: Int?
    let wins: Int?
    let losses: Int?
    let saves: Int?
    let era: String?
    let whip: String?
}

struct RecentForm: Codable {
    let last7: RecentFormSplit
    let last15: RecentFormSplit
}

struct TomorrowMatchup: Codable {
    let opponentAbbreviation: String
    let opponentName: String
    let isHome: Bool
    let gameTimeUtc: String
    let probablePitcherName: String?
    let probablePitcherEra: String?
    let probablePitcherWins: Int?
    let probablePitcherLosses: Int?
    let probablePitcherHand: String?
}

struct DailyWatchlistResponse: Codable {
    let userId: String
    let count: Int
    let watchlist: [DailyWatchlistItem]
}

struct DailyWatchlistUpsertRequest: Codable {
    let playerId: String
    let playerName: String
    let team: String?
    let league: String?
}

struct DailyWatchlistSearchRequest: Codable {
    let query: String
    let team: String?
    let league: String?
}

struct DailyWatchlistAddResponse: Codable {
    let message: String?
    let watchlistItemId: String?
    let userId: String?
    let playerId: String?
    let playerName: String?
    let league: String?
}

struct DailyWatchlistSearchAddItem: Codable {
    let watchlistItemId: String?
    let userId: String?
    let playerId: String
    let playerName: String?
    let league: String?
    let level: String?
    let teamName: String?
    let teamAbbreviation: String?
    let position: String?
}

struct DailyWatchlistSearchAddResponse: Codable {
    let message: String?
    let resolvedFrom: String?
    let item: DailyWatchlistSearchAddItem?
}

struct DailyTopWatchedPlayer: Codable, Identifiable {
    let playerId: String
    let playerName: String
    let team: String?
    let league: String?
    let watchCount: Int

    var id: String { playerId }
}

struct DailyTopWatchedResponse: Codable {
    let count: Int
    let players: [DailyTopWatchedPlayer]
}

struct DailyWatchSuggestion: Codable, Identifiable {
    let playerId: String
    let playerName: String
    let team: String?
    let league: String?

    var id: String { playerId }
}

struct DailyWatchSuggestionsResponse: Codable {
    let query: String
    let suggestions: [DailyWatchSuggestion]
}

struct APIMessageResponse: Codable {
    let message: String?
    let error: String?
}

// MARK: - PlayerIQ Models
struct PlayerIQRequest: Codable {
    let player: String
    let level: String?
    let stats: PlayerStats
}

struct PlayerStats: Codable {
    let avg: Double
    let hr: Int
    let ops: Double
}

struct PlayerIQResponse: Codable {
    let score: Double?
    let tier: String?
    let cardStrategy: String?
    let error: String?
}

// MARK: - CompIQ Estimate Models (structured pricing)
struct CompIQSubject: Codable {
    let playerName: String
    let cardYear: Int?
    let brand: String?
    let setName: String?
    let product: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let isAuto: Bool?
    let isPatch: Bool?
    let cardNumber: String?
}

struct CompIQEstimateRequest: Codable {
    let subject: CompIQSubject
    let comps: [CompIQComp]
    let context: CompIQContext
    let debug: Bool?
}

struct CompIQComp: Codable {
    let price: Double
    let date: String
    let title: String?
    let listingType: String?
    let gradeValue: Double?
    let parallel: String?
}

struct CompIQContext: Codable {
    let activeListings: Int?
    let soldCount30d: Int?
    let playerTrendScore: Double?
    let scarcityScore: Double?
}

struct PriceLanes: Codable {
    let quickSaleValue: Double?
    let fairMarketValue: Double?
    let premiumValue: Double?
}

struct CompIQMarketDNA: Codable {
    let demand: String?
    let speed: String?
    let risk: String?
    let trend: String?
}

struct CompIQConfidence: Codable {
    let pricingConfidence: Double?
    let liquidityConfidence: Double?
    let timingConfidence: Double?
}

struct CompIQExitStrategy: Codable {
    let recommendedMethod: String?
    let expectedDaysToSell: Int?
    let timingRecommendation: String?
}

struct CompIQEstimateResponse: Codable {
    let priceLanes: PriceLanes?
    let dealScore: Double?
    let verdict: String?
    let action: String?
    let marketDNA: CompIQMarketDNA?
    let confidence: CompIQConfidence?
    let exitStrategy: CompIQExitStrategy?
    let explanation: [String]?
    let explanationBullets: [String]?

    // See note on CardEstimateResponse.recentComps.
    let recentComps: [CompEstimateRecentComp]?
    let source: String?
    let daysSinceNewestComp: Int?
}

// MARK: - Auth Models
struct AuthUser: Codable {
    let userId: String?
    let email: String?
    let plan: String?
}

struct AuthSignInResponse: Codable {
    let success: Bool
    let user: AuthUser?
    let sessionId: String?
    let error: String?
}

struct AuthSignOutResponse: Codable {
    let success: Bool
    let error: String?
}

struct AuthSessionResponse: Codable {
    let success: Bool
    let user: AuthUser?
    let error: String?
}

// MARK: - PortfolioIQ Models
struct PortfolioHoldingsResponse: Codable {
    let userId: String
    let count: Int
    let holdings: [PortfolioHolding]
}

struct PortfolioPricePoint: Codable, Identifiable {
    var id: String { at }
    let at: String
    let value: Double
    let confidence: Double?
    let compsUsed: Int?
    let source: String?
}

struct PortfolioHoldingHistoryResponse: Codable {
    let holdingId: String
    let count: Int
    let points: [PortfolioPricePoint]
}

struct PortfolioAlert: Codable, Identifiable {
    let id: String
    let level: String
    let type: String
    let createdAt: String
    let holdingId: String
    let playerName: String
    let cardTitle: String
    let message: String
}

struct PortfolioAlertsResponse: Codable {
    let count: Int
    let alerts: [PortfolioAlert]
}

struct PortfolioHealthResponse: Codable {
    let totalHoldings: Int
    let score: Int
    let concentrationRisk: Int
    let liquidityRisk: Int
    let staleDataRisk: Int
    let downsideRisk: Int
}

struct PortfolioBatchRepriceResponse: Codable {
    let requested: Int
    let repriced: Int
    let skipped: Int
}

struct PortfolioCalibrationBin: Codable {
    let bucket: String
    let count: Int
    let meanAbsolutePctError: Double
}

struct PortfolioCalibrationResponse: Codable {
    let sampleCount: Int
    let meanAbsolutePctError: Double
    let bins: [PortfolioCalibrationBin]
}

struct PortfolioWeeklyMove: Codable {
    let holdingId: String
    let playerName: String
    let cardTitle: String
    let movePct: Double
    let latestValue: Double
}

struct PortfolioWeeklySummary: Codable {
    let holdings: Int
    let alerts: Int
    let criticalAlerts: Int
    let feedbackEvents: Int
    let recommendationFollowRatePct: Double
}

struct PortfolioWeeklyBriefResponse: Codable {
    let period: String
    let generatedAt: String
    let headline: String
    let summary: PortfolioWeeklySummary
    let topWinners: [PortfolioWeeklyMove]
    let topLosers: [PortfolioWeeklyMove]
    let recommendations: [String]
}

struct RecommendationFeedbackRequest: Codable {
    let holdingId: String
    let recommendation: String
    let actionTaken: String
    let notes: String?
}

struct CompIQWhatIfRequest: Codable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Int?
    let isAuto: Bool?
    let buyPrice: Double?
    let holdDays: Int?
    let feePct: Double?
    let shippingCost: Double?
}

struct CompIQScenarioResult: Codable {
    let projectedSalePrice: Double
    let projectedNet: Double
    let pnl: Double
    let roiPct: Double
}

struct CompIQWhatIfScenarios: Codable {
    let bear: CompIQScenarioResult
    let base: CompIQScenarioResult
    let bull: CompIQScenarioResult
}

struct CompIQWhatIfResponse: Codable {
    let success: Bool
    let scenarios: CompIQWhatIfScenarios
}

// MARK: - Grade Premium Models

struct CompIQGradePremiumRequest: Codable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let isAuto: Bool?
}

struct CompIQGradePremiumResponse: Codable {
    let success: Bool
    let playerName: String
    let rawFmv: Double
    let psa10Fmv: Double
    let premiumDollars: Double
    let premiumPct: Double
    let worthGrading: Bool
    let verdict: String
}

// MARK: - Sell Window Models

struct CompIQSellWindowRequest: Codable {
    let playerName: String
    let cardYear: Int?
    let isRookie: Bool?
    let sport: String?
}

struct CompIQSellWindowEntry: Codable {
    let startMonth: Int
    let endMonth: Int
    let label: String
    let reason: String
}

struct CompIQSellWindowResponse: Codable {
    let success: Bool
    let playerName: String
    let inWindowNow: Bool
    let activeWindow: CompIQSellWindowEntry?
    let nextWindow: CompIQSellWindowEntry?
    let monthsUntilNext: Int
    let allWindows: [CompIQSellWindowEntry]
    let verdict: String
}

// MARK: - eBay Models

struct EbayConnectionStatus: Codable {
    let success: Bool
    let connected: Bool
    let ebayUserId: String?
    let connectedAt: String?
    let accessTokenExpiresAt: Double?
    let refreshTokenExpiresAt: Double?
}

struct EbayConnectStartResponse: Codable {
    let success: Bool
    let authUrl: String
}

struct EbayPolicy: Codable, Identifiable {
    let policyId: String
    let name: String
    var id: String { policyId }
}

struct EbayPoliciesResponse: Codable {
    let success: Bool
    let paymentPolicies: [EbayPolicy]
    let fulfillmentPolicies: [EbayPolicy]
    let returnPolicies: [EbayPolicy]
}

struct EbayListingRequest: Codable {
    let holdingId: String
    let playerName: String
    let cardTitle: String
    let cardYear: Int
    let brand: String
    let setName: String
    let product: String
    let sport: String?
    let cardNumber: String?
    let parallel: String?
    let serialNumber: String?
    let printRun: Int?
    let isAuto: Bool
    let isPatch: Bool
    let isRookie: Bool
    let variation: String?
    // Graded
    let grade: String?
    let gradingCompany: String?
    let certNumber: String?
    // Raw
    let conditionNotes: String?
    let conditionEstimate: String?
    // Listing params
    let quantity: Int
    let listingPrice: Double
    let bestOfferEnabled: Bool
    let bestOfferMinPrice: Double?
    let imageFrontUrl: String?
    let imageBackUrl: String?
    let description: String?
    // Policy overrides
    let paymentPolicyId: String?
    let returnPolicyId: String?
    let fulfillmentPolicyId: String?
    let categoryId: String?
}

struct EbayPreviewAspect: Codable {
    let key: String
    let values: [String]
}

struct EbayListingPreview: Codable {
    let title: String
    let description: String
    let price: Double
    let bestOfferEnabled: Bool
    let quantity: Int
    let categoryId: String
    let marketplaceId: String
}

struct EbayPreviewResponse: Codable {
    let success: Bool
    let preview: EbayListingPreview
}

struct EbayPublishResponse: Codable {
    let success: Bool
    let offerId: String?
    let listingId: String?
    let listingUrl: String?
    let inventoryItemKey: String?
    let error: String?
}

struct EbayOfferStatusResponse: Codable {
    let success: Bool
    let offerId: String
    let status: String
    let listingId: String?
    let listingUrl: String?
    let price: Double?
    let quantity: Int?
    let categoryId: String?
    let marketplaceId: String?
}

struct CardPhotoUploadRequest: Codable {
    let imageBase64: String
    let mimeType: String
    let side: String
}

struct CardPhotoUploadResponse: Codable {
    let success: Bool
    let url: String?
    let path: String?
    let mimeType: String?
    let size: Int?
    let error: String?
}

struct PortfolioLedgerTotals: Codable {
    let realizedProfitLoss: Double
    let grossProceeds: Double
    let netProceeds: Double
    let costBasisSold: Double
}

struct PortfolioLedgerEntry: Codable, Identifiable {
    let id: String
    let userId: String
    let holdingId: String
    let playerName: String
    let cardTitle: String
    let quantitySold: Int
    let unitSalePrice: Double
    let grossProceeds: Double
    let fees: Double
    let tax: Double
    let shipping: Double
    let netProceeds: Double
    let costBasisSold: Double
    let realizedProfitLoss: Double
    let realizedProfitLossPct: Double
    let soldAt: String
    let notes: String?
}

struct PortfolioLedgerResponse: Codable {
    let userId: String
    let count: Int
    let totals: PortfolioLedgerTotals
    let entries: [PortfolioLedgerEntry]
}

struct PortfolioSellRequest: Codable {
    let quantity: Int
    let salePrice: Double
    let fees: Double?
    let tax: Double?
    let shipping: Double?
    let soldAt: String?
    let notes: String?
}

struct PortfolioSellResponse: Codable {
    let message: String
    let sold: PortfolioLedgerEntry
    let holdingRemoved: Bool
    let remainingQuantity: Int
}

struct PSACertLookupCard: Codable {
    let year: String?
    let brand: String?
    let category: String?
    let cardNumber: String?
    let subject: String?
    let variety: String?
    let grade: String?
    let gradeDescription: String?
    let specId: Int?
    let itemStatus: String?
    let totalPopulation: Int?
    let populationHigher: Int?
}

struct PSACertLookupResponse: Codable {
    let success: Bool
    let source: String?
    let certNumber: String?
    let certificationType: String?
    let card: PSACertLookupCard?
    let error: String?
    let code: String?
}

// MARK: - API Service
// MARK: - Card Estimate (flat — matches /api/compiq/estimate)
struct CardEstimateRequest: Codable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Int?
}

struct CardEstimateDNA: Codable {
    let trend: String?
    let liquidity: String?
    let speed: String?
    let marketCondition: String?
}

struct CardEstimatePricingAnalytics: Codable {
    let compsUsed: Int?
    let rSquared: Double?
    let parallelDetected: String?
    let projectedNextSale: Double?
}

/// One sold comp returned by either the backend /api/compiq/estimate
/// endpoint OR the MCP /api/compiq/predict endpoint. Their payload shapes
/// differ slightly (`title`+`soldDate` vs `grade`+`date`) so the decoder
/// accepts either set of keys.
/// Populated for ALL responses, but especially useful when the prediction
/// is insufficient — the iOS UI then shows this list so the user can see
/// exactly what Card Hedge has on file.
struct CompEstimateRecentComp: Codable, Identifiable {
    let price: Double?
    let title: String?
    let soldDate: String?

    var id: String { "\(title ?? "?")-\(soldDate ?? "?")-\(price ?? 0)" }

    private enum CodingKeys: String, CodingKey {
        case price, title, soldDate, date, grade, source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.price = try c.decodeIfPresent(Double.self, forKey: .price)
        // Backend uses `title`; MCP uses `grade` (+ optional `source`).
        let backendTitle = try c.decodeIfPresent(String.self, forKey: .title)
        let mcpGrade = try c.decodeIfPresent(String.self, forKey: .grade)
        let mcpSource = try c.decodeIfPresent(String.self, forKey: .source)
        if let backendTitle, !backendTitle.isEmpty {
            self.title = backendTitle
        } else {
            let parts = [mcpGrade, mcpSource].compactMap { $0 }.filter { !$0.isEmpty }
            self.title = parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        // Backend uses `soldDate`; MCP uses `date`.
        self.soldDate =
            (try c.decodeIfPresent(String.self, forKey: .soldDate))
            ?? (try c.decodeIfPresent(String.self, forKey: .date))
    }

    // Synthesizes Encodable so this struct can be embedded in request bodies
    // if needed later. We only encode the canonical (backend) shape.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(price, forKey: .price)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(soldDate, forKey: .soldDate)
    }
}

struct CardEstimateResponse: Codable {
    let fairMarketValue: Double?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let verdict: String?
    let recommendation: String?
    let action: String?
    let marketDNA: CardEstimateDNA?
    let exitStrategy: CompIQExitStrategy?
    let explanation: [String]?
    let pricingAnalytics: CardEstimatePricingAnalytics?

    // Pricing Accuracy v2 — flat callers need these so they can honor the
    // insufficient-data contract instead of caching $0 as the canonical price.
    let compQuality: CompQualityInfo?
    let graderPremium: GraderPremiumInfo?
    let dataSufficiency: DataSufficiency?
    let buyWindowScore: Int?
    let buyWindowLabel: String?
    let buyWindowReasons: [String]?
    let confidenceInterval: ConfidenceInterval?

    // Pricing Accuracy v3 — when fairMarketValue is nil (insufficient or
    // variant-mismatch) the backend now returns the full list of comps it
    // found so the iOS UI can show them instead of a generic "Insufficient
    // Data" screen.
    let recentComps: [CompEstimateRecentComp]?
    let source: String?
    let daysSinceNewestComp: Int?
}

// MARK: - API Service
class APIService {
    static let shared = APIService()
    private init() {}

    // MARK: Auth

    func signIn(email: String, password: String) async throws -> AuthSignInResponse {
        let url = URL(string: baseURL + "/api/auth/signin")!
        return try await postRequest(url: url, body: ["email": email, "username": email, "password": password])
    }

    func signOut(sessionId: String) async throws -> AuthSignOutResponse {
        let url = URL(string: baseURL + "/api/auth/signout")!
        return try await postRequest(url: url, body: ["sessionId": sessionId], extraHeaders: ["x-session-id": sessionId])
    }

    func fetchSession(sessionId: String) async throws -> AuthSessionResponse {
        let url = URL(string: baseURL + "/api/auth/session")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(AuthSessionResponse.self, from: data)
    }

    func searchCards(query: String) async throws -> CardSearchResponse {
        let url = URL(string: baseURL + "/api/compiq/search")!
        return try await postRequest(url: url, body: CardSearchRequest(query: query))
    }

    func priceCard(query: String) async throws -> CardSearchResponse {
        let url = URL(string: baseURL + "/api/compiq/price")!
        return try await postRequest(url: url, body: CardSearchRequest(query: query))
    }

    func estimateCard(request: CompIQEstimateRequest) async throws -> CompIQEstimateResponse {
        let url = URL(string: baseURL + "/api/compiq/estimate")!
        return try await postRequest(url: url, body: request)
    }

    // MARK: - Card Estimate (flat fields — matches /api/compiq/estimate directly)
    func estimateCardDirect(request: CardEstimateRequest) async throws -> CardEstimateResponse {
        let url = URL(string: baseURL + "/api/compiq/estimate")!
        return try await postRequest(url: url, body: request)
    }

    func priceCardEstimate(request: CompIQPriceRequest) async throws -> CompIQPriceResponse {
        let url = URL(string: baseURL + "/api/compiq/estimate")!
        return try await postRequest(url: url, body: request)
    }

    /// PortfolioIQ bulk repricing endpoint.
    func bulkPriceCards(queries: [String]) async throws -> CompIQBulkPriceResponse {
        let url = URL(string: baseURL + "/api/compiq/bulk")!
        return try await postRequest(url: url, body: ["queries": queries])
    }

    func fetchDailyBrief(date: Date? = nil, fresh: Bool = false) async throws -> DailyBriefResponse {
        var queryItems: [URLQueryItem] = []
        if let date {
            queryItems.append(URLQueryItem(name: "date", value: formatDayString(date)))
        }
        if fresh {
            queryItems.append(URLQueryItem(name: "fresh", value: "true"))
        }

        var components = URLComponents(string: baseURL + "/api/dailyiq/brief")!
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        let urlString = components.string ?? (baseURL + "/api/dailyiq/brief")
        let url = URL(string: urlString)!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Fresh requests wait longer — they run live eBay lookups for all 4 cards
        request.timeoutInterval = fresh ? 60 : 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(DailyBriefResponse.self, from: data)
    }

    func fetchDailyWatchlist(sessionId: String, date: Date? = nil) async throws -> DailyWatchlistResponse {
        var components = URLComponents(string: baseURL + "/api/dailyiq/watchlist")!
        if let date {
            components.queryItems = [URLQueryItem(name: "date", value: formatDayString(date))]
        }
        let url = components.url!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(DailyWatchlistResponse.self, from: data)
    }

    func fetchDailyTopWatched(limit: Int = 10) async throws -> DailyTopWatchedResponse {
        let boundedLimit = min(max(limit, 1), 50)
        let url = URL(string: baseURL + "/api/dailyiq/watchlist/top?limit=\(boundedLimit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(DailyTopWatchedResponse.self, from: data)
    }

    func fetchDailyWatchSuggestions(query: String, limit: Int = 8) async throws -> DailyWatchSuggestionsResponse {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let boundedLimit = min(max(limit, 1), 20)
        let encodedQuery = normalizedQuery.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? normalizedQuery
        let url = URL(string: baseURL + "/api/dailyiq/watchlist/suggest?q=\(encodedQuery)&limit=\(boundedLimit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(DailyWatchSuggestionsResponse.self, from: data)
    }

    func addDailyWatchPlayer(request body: DailyWatchlistUpsertRequest, sessionId: String) async throws -> DailyWatchlistAddResponse {
        let url = URL(string: baseURL + "/api/dailyiq/watchlist")!
        return try await postRequest(
            url: url,
            body: body,
            extraHeaders: ["x-session-id": sessionId]
        )
    }

    func addDailyWatchPlayerBySearch(query: String, team: String?, league: String?, sessionId: String) async throws -> DailyWatchlistSearchAddResponse {
        let url = URL(string: baseURL + "/api/dailyiq/watchlist/search")!
        return try await postRequest(
            url: url,
            body: DailyWatchlistSearchRequest(query: query, team: team, league: league),
            extraHeaders: ["x-session-id": sessionId]
        )
    }

    func fetchPortfolioHoldings(sessionId: String) async throws -> PortfolioHoldingsResponse {
        let url = URL(string: baseURL + "/api/portfolio/holdings")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(PortfolioHoldingsResponse.self, from: data)
    }

    func addPortfolioHolding(_ holding: PortfolioHolding, sessionId: String) async throws -> APIMessageResponse {
        let url = URL(string: baseURL + "/api/portfolio/holdings")!
        return try await postRequest(
            url: url,
            body: holding,
            extraHeaders: ["x-session-id": sessionId]
        )
    }

    func updatePortfolioHolding(_ holding: PortfolioHolding, sessionId: String) async throws -> APIMessageResponse {
        let holdingId = holding.id.uuidString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? holding.id.uuidString
        let url = URL(string: baseURL + "/api/portfolio/holdings/\(holdingId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(holding)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(APIMessageResponse.self, from: data)
    }

    func removePortfolioHolding(holdingId: UUID, sessionId: String) async throws -> APIMessageResponse {
        let encodedHoldingId = holdingId.uuidString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? holdingId.uuidString
        let url = URL(string: baseURL + "/api/portfolio/holdings/\(encodedHoldingId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(APIMessageResponse.self, from: data)
    }

    func sellPortfolioHolding(holdingId: UUID, request body: PortfolioSellRequest, sessionId: String) async throws -> PortfolioSellResponse {
        let encodedHoldingId = holdingId.uuidString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? holdingId.uuidString
        let url = URL(string: baseURL + "/api/portfolio/holdings/\(encodedHoldingId)/sell")!
        return try await postRequest(
            url: url,
            body: body,
            extraHeaders: ["x-session-id": sessionId]
        )
    }

    func fetchPortfolioLedger(sessionId: String) async throws -> PortfolioLedgerResponse {
        let url = URL(string: baseURL + "/api/portfolio/ledger")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(PortfolioLedgerResponse.self, from: data)
    }

    func fetchPortfolioAlerts(sessionId: String, limit: Int = 30) async throws -> PortfolioAlertsResponse {
        let boundedLimit = min(max(limit, 1), 100)
        let url = URL(string: baseURL + "/api/portfolio/alerts?limit=\(boundedLimit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(PortfolioAlertsResponse.self, from: data)
    }

    func fetchPortfolioHealth(sessionId: String) async throws -> PortfolioHealthResponse {
        let url = URL(string: baseURL + "/api/portfolio/health/score")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(PortfolioHealthResponse.self, from: data)
    }

    func fetchHoldingPriceHistory(holdingId: UUID, sessionId: String) async throws -> PortfolioHoldingHistoryResponse {
        let encodedHoldingId = holdingId.uuidString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? holdingId.uuidString
        let url = URL(string: baseURL + "/api/portfolio/holdings/\(encodedHoldingId)/history")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }

        return try JSONDecoder().decode(PortfolioHoldingHistoryResponse.self, from: data)
    }

    func runPortfolioBatchReprice(sessionId: String) async throws -> PortfolioBatchRepriceResponse {
        let url = URL(string: baseURL + "/api/portfolio/reprice/batch")!
        return try await postRequest(url: url, body: [String: String](), extraHeaders: ["x-session-id": sessionId])
    }

    func fetchPortfolioCalibration(sessionId: String) async throws -> PortfolioCalibrationResponse {
        let url = URL(string: baseURL + "/api/portfolio/analytics/calibration")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(PortfolioCalibrationResponse.self, from: data)
    }

    func fetchPortfolioWeeklyBrief(sessionId: String) async throws -> PortfolioWeeklyBriefResponse {
        let url = URL(string: baseURL + "/api/portfolio/insights/weekly-brief")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(PortfolioWeeklyBriefResponse.self, from: data)
    }

    func submitRecommendationFeedback(request body: RecommendationFeedbackRequest, sessionId: String) async throws -> APIMessageResponse {
        let url = URL(string: baseURL + "/api/portfolio/feedback/recommendation")!
        return try await postRequest(url: url, body: body, extraHeaders: ["x-session-id": sessionId])
    }

    func runCompIQWhatIf(request body: CompIQWhatIfRequest) async throws -> CompIQWhatIfResponse {
        let url = URL(string: baseURL + "/api/compiq/what-if")!
        return try await postRequest(url: url, body: body)
    }

    func fetchGradePremium(request body: CompIQGradePremiumRequest) async throws -> CompIQGradePremiumResponse {
        let url = URL(string: baseURL + "/api/compiq/grade-premium")!
        return try await postRequest(url: url, body: body)
    }

    func fetchSellWindow(request body: CompIQSellWindowRequest) async throws -> CompIQSellWindowResponse {
        let url = URL(string: baseURL + "/api/compiq/sell-window")!
        return try await postRequest(url: url, body: body)
    }

    // MARK: — eBay

    func ebayConnectionStatus(sessionId: String) async throws -> EbayConnectionStatus {
        var req = URLRequest(url: URL(string: baseURL + "/api/ebay/status")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    func ebayConnectStart(sessionId: String) async throws -> EbayConnectStartResponse {
        var req = URLRequest(url: URL(string: baseURL + "/api/ebay/connect/start")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    func ebayReconnectStart(sessionId: String) async throws -> EbayConnectStartResponse {
        var req = URLRequest(url: URL(string: baseURL + "/api/ebay/connect/restart")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    func ebayDisconnect(sessionId: String) async throws -> APIMessageResponse {
        let url = URL(string: baseURL + "/api/ebay/disconnect")!
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIServiceError.invalidResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(APIMessageResponse.self, from: data)
    }

    func ebayGetPolicies(sessionId: String) async throws -> EbayPoliciesResponse {
        var req = URLRequest(url: URL(string: baseURL + "/api/ebay/policies")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    func ebayPreviewListing(body: EbayListingRequest, sessionId: String) async throws -> EbayPreviewResponse {
        let url = URL(string: baseURL + "/api/ebay/listings/preview")!
        return try await postRequest(url: url, body: body, extraHeaders: ["x-session-id": sessionId])
    }

    func ebayPublishListing(body: EbayListingRequest, sessionId: String) async throws -> EbayPublishResponse {
        let url = URL(string: baseURL + "/api/ebay/listings/publish")!
        return try await postRequest(url: url, body: body, extraHeaders: ["x-session-id": sessionId])
    }

    func ebayReviseListing(offerId: String, body: EbayListingRequest, sessionId: String) async throws -> EbayPublishResponse {
        let url = URL(string: baseURL + "/api/ebay/listings/\(offerId)/revise")!
        return try await putRequest(url: url, body: body, sessionId: sessionId)
    }

    func ebayEndListing(offerId: String, sessionId: String) async throws -> APIMessageResponse {
        let url = URL(string: baseURL + "/api/ebay/listings/\(offerId)/end")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIServiceError.invalidResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(APIMessageResponse.self, from: data)
    }

    func ebayListingStatus(offerId: String, sessionId: String) async throws -> EbayOfferStatusResponse {
        var req = URLRequest(url: URL(string: baseURL + "/api/ebay/listings/\(offerId)/status")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    func uploadCardPhoto(sessionId: String, imageBase64: String, side: String) async throws -> CardPhotoUploadResponse {
        let url = URL(string: baseURL + "/api/uploads/card-photo")!
        let body = CardPhotoUploadRequest(imageBase64: imageBase64, mimeType: "image/jpeg", side: side)
        return try await postRequest(url: url, body: body, extraHeaders: ["x-session-id": sessionId])
    }

    func fetchPSACertLookup(certNumber: String, sessionId: String) async throws -> PSACertLookupResponse {
        let encodedCert = certNumber.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? certNumber
        var req = URLRequest(url: URL(string: baseURL + "/api/psa/cert/\(encodedCert)")!)
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        return try await getRequest(req)
    }

    // MARK: — Private GET/PUT helpers

    private func getRequest<T: Decodable>(_ request: URLRequest) async throws -> T {
        var req = request
        if req.httpMethod == nil { req.httpMethod = "GET" }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIServiceError.invalidResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func putRequest<B: Encodable, T: Decodable>(url: URL, body: B, sessionId: String? = nil) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let s = sessionId { req.setValue(s, forHTTPHeaderField: "x-session-id") }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw APIServiceError.invalidResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func removeDailyWatchPlayer(playerId: String, sessionId: String) async throws -> APIMessageResponse {
        let encodedPlayerId = playerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? playerId
        let url = URL(string: baseURL + "/api/dailyiq/watchlist/\(encodedPlayerId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        return try JSONDecoder().decode(APIMessageResponse.self, from: data)
    }

    private func formatDayString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func postRequest<T: Encodable, U: Decodable>(url: URL, body: T, extraHeaders: [String: String] = [:]) async throws -> U {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        for (key, value) in extraHeaders {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw APIServiceError.invalidResponse(status)
        }
        do {
            return try JSONDecoder().decode(U.self, from: data)
        } catch {
            throw APIServiceError.decoding(error)
        }
    }
}

// MARK: - APIService Errors
enum APIServiceError: Error, LocalizedError {
    case invalidResponse(Int)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse(401):
            return "Invalid credentials. Please check your email and password."
        case .invalidResponse(403):
            return "Access denied."
        case .invalidResponse(404):
            return "Not found."
        case .invalidResponse(let status):
            return "Request failed (status \(status))."
        case .decoding(let err):
            return "Couldn't read server response: \(err.localizedDescription)"
        }
    }
}
