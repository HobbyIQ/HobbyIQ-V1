import Foundation

// MARK: - API Base URL
let baseURL = "https://YOUR-AZURE-APP.azurewebsites.net"

// MARK: - CompIQ Models
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

    // CompIQ
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
