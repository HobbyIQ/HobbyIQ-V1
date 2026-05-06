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

struct CompIQSalePoint: Codable {
    let price: Double
    let parallel: String?
    let grade: String?
    let date: String?
}

struct CompIQNeighborComp: Codable {
    let price: Double
    let date: String
    let parallel: String?
    let grade: String?
    let serialNumber: Int?
}

struct CompIQCardInput: Codable {
    let playerName: String
    let cardName: String
    let cost: Double
    let parallel: String?
    let grade: String?
    let serialNumber: Int?
    let recentComps: [CompIQSalePoint]?
    let activeListings: Int?
    let lowestActiveListingPrice: Double?
    let avgActiveListingPrice: Double?
    let recentSoldCount7d: Int?
    let avgListingAgeDays: Int?
    let playerEvent: String?
    let recentSoldCount24h: Int?
    let activeListings24hAgo: Int?
    let lowestAsk24hAgo: Double?
    let avgSoldPrice24h: Double?
    let neighborComps: [CompIQNeighborComp]?
}

struct CompIQBulkRequest: Codable {
    let cards: [CompIQCardInput]
}

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
}

struct CompIQBulkResponse: Codable {
    let results: [CompIQEstimateResult]
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
        return CompIQEstimateResult(
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

    enum CodingKeys: String, CodingKey {
        case hits, atBats, runs, rbis, rbi, homeRuns, strikeouts, walks, battingAverage, ops
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hits          = try c.decodeIfPresent(Int.self,    forKey: .hits)          ?? 0
        atBats        = try c.decodeIfPresent(Int.self,    forKey: .atBats)        ?? 0
        runs          = try c.decodeIfPresent(Int.self,    forKey: .runs)          ?? 0
        rbis          = try c.decodeIfPresent(Int.self,    forKey: .rbis)          ?? c.decodeIfPresent(Int.self, forKey: .rbi) ?? 0
        homeRuns      = try c.decodeIfPresent(Int.self,    forKey: .homeRuns)      ?? 0
        strikeouts    = try c.decodeIfPresent(Int.self,    forKey: .strikeouts)    ?? 0
        walks         = try c.decodeIfPresent(Int.self,    forKey: .walks)         ?? 0
        battingAverage = try c.decodeIfPresent(String.self, forKey: .battingAverage) ?? ".000"
        ops           = try c.decodeIfPresent(String.self, forKey: .ops)           ?? ".000"
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

    enum CodingKeys: String, CodingKey {
        case battingAverage, homeRuns, rbis, rbi
        case obp, onBasePercentage
        case slg, sluggingPercentage
        case ops, walks, strikeouts, walkToStrikeout
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        battingAverage = try c.decodeIfPresent(String.self, forKey: .battingAverage) ?? ".000"
        homeRuns       = try c.decodeIfPresent(Int.self,    forKey: .homeRuns)       ?? 0
        rbis           = try c.decodeIfPresent(Int.self,    forKey: .rbis)           ?? c.decodeIfPresent(Int.self, forKey: .rbi) ?? 0
        obp            = try c.decodeIfPresent(String.self, forKey: .obp)            ?? c.decodeIfPresent(String.self, forKey: .onBasePercentage) ?? ".000"
        slg            = try c.decodeIfPresent(String.self, forKey: .slg)            ?? c.decodeIfPresent(String.self, forKey: .sluggingPercentage) ?? ".000"
        ops            = try c.decodeIfPresent(String.self, forKey: .ops)            ?? ".000"
        walks          = try c.decodeIfPresent(Int.self,    forKey: .walks)          ?? 0
        strikeouts     = try c.decodeIfPresent(Int.self,    forKey: .strikeouts)     ?? 0
        walkToStrikeout = try c.decodeIfPresent(String.self, forKey: .walkToStrikeout)
    }
}

struct DailyPerformer: Codable, Identifiable {
    var id: String { playerId }
    let playerId: String
    let playerName: String
    let team: String
    let league: String
    let level: String?
    let dailyStats: DailyStats
    let seasonStats: SeasonStats
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
    let addedAt: String?
    let dailyStats: DailyStats?
    let seasonStats: SeasonStats?

    var id: String { playerId }
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

// MARK: - Legacy CompIQ Models
struct CompIQRequest: Codable {
    let player: String
    let cardType: String
    let parallel: String?
    let grade: String?
    let recentComps: [Double]
}

struct CompIQResponse: Codable {
    let weightedAverage: Double?
    let min: Double?
    let max: Double?
    let trend: String?
    let confidence: String?
    let recommendation: String?
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
}

// MARK: - API Service
class APIService {
    static let shared = APIService()
    private init() {}

    // MARK: Auth

    func signIn(username: String, password: String) async throws -> AuthSignInResponse {
        let url = URL(string: baseURL + "/api/auth/signin")!
        return try await postRequest(url: url, body: ["username": username, "password": password])
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

    func bulkEstimate(cards: [CompIQCardInput]) async throws -> CompIQBulkResponse {
        let url = URL(string: baseURL + "/api/compiq/bulk-estimate")!
        return try await postRequest(url: url, body: CompIQBulkRequest(cards: cards))
    }

    func analyzeCompIQ(request: CompIQRequest) async throws -> CompIQResponse {
        let url = URL(string: baseURL + "/api/compiq/analyze")!
        return try await postRequest(url: url, body: request)
    }

    func fetchDailyBrief(fresh: Bool = false) async throws -> DailyBriefResponse {
        let urlString = baseURL + "/api/dailyiq/brief" + (fresh ? "?fresh=true" : "")
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

    func fetchDailyWatchlist(sessionId: String) async throws -> DailyWatchlistResponse {
        let url = URL(string: baseURL + "/api/dailyiq/watchlist")!
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

    func addDailyWatchPlayer(request body: DailyWatchlistUpsertRequest, sessionId: String) async throws -> APIMessageResponse {
        let url = URL(string: baseURL + "/api/dailyiq/watchlist")!
        return try await postRequest(
            url: url,
            body: body,
            extraHeaders: ["x-session-id": sessionId]
        )
    }

    func addDailyWatchPlayerBySearch(query: String, team: String?, league: String?, sessionId: String) async throws -> APIMessageResponse {
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
            return "Session expired. Please sign in again."
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
