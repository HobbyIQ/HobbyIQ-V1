import Foundation

// MARK: - API Base URL
let baseURL = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

// MARK: - CompIQ Bulk Estimate Models

struct CompIQSalePoint: Codable {
    let price: Double
    let parallel: String?
    let grade: String?
    let date: String?
}

/// A comp from the same player + set but a different grade, parallel, or serial.
/// The backend normalizes the price to the target card's attributes before blending.
struct CompIQNeighborComp: Codable {
    let price: Double
    let date: String
    let parallel: String?      // neighbor's parallel (e.g. "Base" when target is a refractor)
    let grade: String?         // neighbor's grade
    let serialNumber: Int?     // neighbor's print run
}

struct CompIQCardInput: Codable {
    let playerName: String
    let cardName: String
    let cost: Double
    let parallel: String?
    let grade: String?
    let serialNumber: Int?
    let recentComps: [CompIQSalePoint]?
    /// Current count of active (unsold) eBay listings for this card.
    let activeListings: Int?
    /// Cheapest current eBay BIN ask — tells the backend where sellers are anchored TODAY.
    let lowestActiveListingPrice: Double?
    /// Average ask price across current active eBay listings.
    let avgActiveListingPrice: Double?
    /// How many times this card sold in the last 7 days (subset of the 30d comp window).
    let recentSoldCount7d: Int?
    /// Average age (days) of current active eBay listings — stale listings signal weak demand.
    let avgListingAgeDays: Int?
    /// Free-text player/card event (e.g. "MVP race", "injury", "HOF ballot", "World Series").
    /// The backend maps this to a demand multiplier.
    let playerEvent: String?

    // ── 24-hour intraday signals ───────────────────────────────────────────
    // These let the engine detect demand changes that happened in the last 24 hours.
    // A breakout performance, injury, or viral moment can move prices within the hour.

    /// How many times this card sold in the last 24 hours (from eBay sold feed).
    let recentSoldCount24h: Int?
    /// Active listing count ~24h ago — compare to activeListings to detect floor sweeps.
    let activeListings24hAgo: Int?
    /// Cheapest active BIN/offer price ~24h ago — compare to lowestActiveListingPrice for floor drift.
    let lowestAsk24hAgo: Double?
    /// Average sale price of transactions that cleared in the last 24 hours.
    let avgSoldPrice24h: Double?

    /// Comps for the same player + set but different grade/parallel/serial.
    /// The backend normalizes each to the target card and blends them in when exact comps are sparse
    /// or stale, and uses them to compute a market drift factor.
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
    // ── Primary seller output ──────────────────────────────────────────────
    let value: Double               // Fair Market Value (the anchor for all other prices)
    let suggestedListPrice: Double? // List at this — 10% above FMV, room to negotiate
    let minAcceptableOffer: Double? // Don't accept below this — floored at your cost
    let quickSaleValue: Double?     // Move it fast at this price (88% of FMV)
    let sellFormat: String?         // e.g. "eBay Auction", "eBay BIN w/ Best Offer"
    let sellFormatReason: String?   // One-line rationale for the recommended format

    // Core valuation (kept for detail/breakdown views)
    let fairValue: Double           // same as value — preserved for backward compatibility
    let lowValue: Double
    let highValue: Double

    // Confidence
    let confidence: Double          // 0–1
    let confidenceScore: Double?    // 0–100

    // Method + comp data
    let method: String
    let compCount: Int
    let targetParallel: String
    let anchorParallel: String?
    let usedNeighboringComps: Bool?
    let neighborCompReason: String?
    let driftFactor: Double?            // market drift applied to stale exact comps (1.0 = no drift)

    // Today signals — real-time corrections applied on top of comp-based FMV
    let todaySignalMultiplier: Double?  // combined today-signal multiplier (nil when 1.0)
    let todaySignalNotes: [String]?     // human-readable breakdown of each today signal
    let askSpreadPct: Double?           // (lowestAsk - lastSold) / lastSold; +ve = asks above last sale
    let velocityAcceleration: Double?   // 7d sales rate ÷ 30d baseline rate; >2.0 = accelerating
    let playerEvent: String?            // echoed back so UI can display it
    let dataFreshnessWarning: String?   // non-nil when newest comp data is stale

    // 24h intraday signals — detects demand changes within the last 24 hours
    let signal24hMultiplier: Double?    // 24h intraday multiplier (nil when 1.0 / neutral)
    let signal24hNotes: [String]?       // human-readable breakdown of each 24h signal
    let signal24hMomentum: String?      // "hot" | "cold" | nil (neutral)

        // Comp price trajectory — linear regression over the comp time series for this card
        // A card that sold $40 → $55 → $68 over 3 weeks has a rising slope.
        // The regression predicts today's price and nudges FMV toward it.
        let compTrendMultiplier: Double?      // anchor nudge applied (nil when no meaningful trend)
        let compTrendSlopePerDay: Double?     // $/day; positive = rising prices
        let compTrendPctPerWeek: Double?      // % change per 7 days relative to median
        let compTrendRSquared: Double?        // 0–1 fit quality (how consistent the trend is)
        let compTrendConfidence: String?      // "strong" | "moderate" | "weak" | nil
        let compTrendPredictedToday: Double?  // regression's best estimate of today's price

    // Adjustment factors
    let multiplierUsed: Double
    let scarcityAdjustment: Double
    let trendAdjustment: Double
    let gradeAdjustment: Double
    let learningAdjustment: Double?
    let liquidityAdjustment: Double?
    let mlCorrectionFactor: Double?
    let mlSampleCount: Int?

    // Trend
    let trending: Bool?
    let trendDirection: String?
    let trendStrength: String?
    let trendVelocityPct: Double?
    let newestCompAge: Int?

    // Forward projection
    let forwardValue30d: Double?
    let bearValue30d: Double?
    let bullValue30d: Double?
    let projectedValue: Double?
    let momentumScore: Double?

    // Outlook + investment
    let outlook: String?
    let outlookNote: String?
    let investmentScore: Double?
    let investmentRating: String?
    let investmentRatingKey: String?
    let upside30d: Double?
    let downside30d: Double?
    let recommendedHoldDays: Int?

    // Evidence + Action policy
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

    // Signals
    let playerSignal: String?
    let newsSignal: String?
    let gemRateSignal: String?

    // Narrative
    let summary: String?
    let explanation: String?
    let pricingPath: [String]?      // human-readable calculation steps

    // Derived demand + supply signals (computed by backend from comp data)
    let derivedDemandScore: Double?  // 0–100: inferred from sale volume, recency, velocity
    let derivedMarketHeat: Double?   // 0–100: inferred from sell-through rate vs activeListings
    let demandSignalNote: String?    // human-readable explanation of derived demand score
    let supplySignalNote: String?    // human-readable explanation of supply/market-heat score

    // Market regime synthesis — combined directional score from all signals
    let marketRegimeScore: Double?   // −65 to +65; negative = bearish, positive = bullish
    let marketRegimeLabel: String?   // "strong-bull" | "bull" | "neutral" | "bear" | "strong-bear"

    // Staleness + listing transparency
    let stalenessPenalty: Double?    // 0.97 when comps >21d old with no drift correction; nil otherwise
    let listingMarkupPct: Double?    // markup % applied above FMV for suggestedListPrice (0 = list at FMV)
}

struct CompIQBulkResponse: Codable {
    let results: [CompIQEstimateResult]
}

// MARK: - Legacy CompIQ Models (kept for backward compatibility)
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

// MARK: - API Service
class APIService {
    static let shared = APIService()
    private init() {}

    // CompIQ Bulk Estimate — primary method
    func bulkEstimate(cards: [CompIQCardInput]) async throws -> CompIQBulkResponse {
        let url = URL(string: baseURL + "/api/compiq/bulk-estimate")!
        return try await postRequest(url: url, body: CompIQBulkRequest(cards: cards))
    }

    // Legacy CompIQ
    func analyzeCompIQ(request: CompIQRequest) async throws -> CompIQResponse {
        let url = URL(string: baseURL + "/api/compiq/analyze")!
        return try await postRequest(url: url, body: request)
    }

    // PlayerIQ
    func analyzePlayerIQ(request: PlayerIQRequest) async throws -> PlayerIQResponse {
        let url = URL(string: baseURL + "/api/playeriq/analyze")!
        return try await postRequest(url: url, body: request)
    }

    // Generic POST
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
            let decoder = JSONDecoder()
            return try decoder.decode(U.self, from: data)
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
