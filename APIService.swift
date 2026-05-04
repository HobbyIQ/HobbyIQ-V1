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

struct CompIQPriceResponse: Codable {
    let fairMarketValue: Double?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let recommendation: String?
    let summary: String?
    let confidence: Double?
    let marketDNA: CompIQPriceMarketDNA?
    let pricingAnalytics: CompIQPricingAnalytics?

    /// Map to the rich CompIQEstimateResult that CompIQView uses.
    func asEstimateResult(requestedParallel: String?) -> CompIQEstimateResult {
        let fmv = fairMarketValue ?? 0
        let qsv = quickSaleValue ?? (fmv * 0.85)
        let pv  = premiumValue ?? (fmv * 1.15)
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
            suggestedListPrice: fmv * 1.05,
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
            actionEntryMax: qsv,
            actionTrimMin: pv * 0.95,
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

// MARK: - API Service
class APIService {
    static let shared = APIService()
    private init() {}

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

    private func postRequest<T: Encodable, U: Decodable>(url: URL, body: T) async throws -> U {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
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
enum APIServiceError: Error {
    case invalidResponse(Int)
    case decoding(Error)
}
