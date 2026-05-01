import Foundation

// MARK: - API Base URL
let baseURL = "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net"

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

    // Search cards by free-text query
    func searchCards(query: String) async throws -> CardSearchResponse {
        let url = URL(string: baseURL + "/api/compiq/search")!
        return try await postRequest(url: url, body: CardSearchRequest(query: query))
    }

    // Price a card by free-text query
    func priceCard(query: String) async throws -> CardSearchResponse {
        let url = URL(string: baseURL + "/api/compiq/price")!
        return try await postRequest(url: url, body: CardSearchRequest(query: query))
    }

    // Full structured estimate (for Add Card flow)
    func estimateCard(request: CompIQEstimateRequest) async throws -> CompIQEstimateResponse {
        let url = URL(string: baseURL + "/api/compiq/estimate")!
        return try await postRequest(url: url, body: request)
    }

    // Generic POST
    private func postRequest<T: Codable, U: Codable>(url: URL, body: T) async throws -> U {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
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
