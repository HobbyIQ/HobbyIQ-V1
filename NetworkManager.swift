import Foundation

struct FullAnalysisRequest: Codable {
    // Define your request fields here, all optional for safety
    let player: String?
    let cardSet: String?
    let year: Int?
    let product: String?
    let parallel: String?
    let grade: String?
    let currentEstimatedValue: Double?
    let askingPrice: Double?
    let userIntent: String?
    let events: [String]?
}

struct FullAnalysisResponse: Codable {
    let summary: [String: AnyCodable]?
    let zones: [String: AnyCodable]?
    let insights: [String: AnyCodable]?
    let reasoning: [AnyCodable]?
    let recentComps: [AnyCodable]?
    let marketLadder: [AnyCodable]?
    let outcome: [AnyCodable]?
}

// Helper for decoding unknown JSON
struct AnyCodable: Codable {}

@MainActor
class NetworkManager: ObservableObject {
    static let shared = NetworkManager()
    // Defensive: fallback to localhost if URL is invalid
    private let baseURL: URL = {
        // Centralized, production-only
        return URL(string: "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net")!
    }()
    @Published var isLoading = false
    @Published var errorMessage: String?

    func postFullAnalysis(request: FullAnalysisRequest) async -> FullAnalysisResponse? {
        isLoading = true
        errorMessage = nil
        let endpoint = baseURL.appendingPathComponent("/api/brain/full-analysis")
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            let encoder = JSONEncoder()
            let bodyData = try encoder.encode(request)
            print("[NetworkManager] Request Body: \(String(data: bodyData, encoding: .utf8) ?? "<nil>")")
            urlRequest.httpBody = bodyData
            let (data, response) = try await URLSession.shared.data(for: urlRequest)
            guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                print("[NetworkManager] Server error: status code = \(status)")
                errorMessage = "Server error: \(status)"
                isLoading = false
                return nil
            }
            do {
                let decoder = JSONDecoder()
                let decoded = try decoder.decode(FullAnalysisResponse.self, from: data)
                isLoading = false
                return decoded
            } catch {
                print("[NetworkManager] Decoding error: \(error.localizedDescription)")
                print("[NetworkManager] Raw response: \(String(data: data, encoding: .utf8) ?? "<nil>")")
                errorMessage = "Decoding error: \(error.localizedDescription)"
                isLoading = false
                return nil
            }
        } catch {
            print("[NetworkManager] Network error: \(error.localizedDescription)")
            errorMessage = "Network error: \(error.localizedDescription)"
            isLoading = false
            return nil
        }
    }
}

// Example usage
@MainActor
func exampleFullAnalysis() async {
    let request = FullAnalysisRequest(player: "Josiah Hartshorn", cardSet: "Bowman Chrome", year: 2025, product: "Bowman", parallel: "Gold Shimmer", grade: "raw", currentEstimatedValue: 387, askingPrice: nil, userIntent: nil, events: ["promotion", "performance_hot"])
    let result = await NetworkManager.shared.postFullAnalysis(request: request)
    if let result = result {
        print("[Example] Success: \(result)")
    } else {
        print("[Example] Error: \(NetworkManager.shared.errorMessage ?? "Unknown error")")
    }
}
