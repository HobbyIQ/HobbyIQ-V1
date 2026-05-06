//
//  APIService.swift
//  HobbyIQ
//

import Foundation

enum APIServiceError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, body: String)
    case decodingFailed(Error)
    case networkFailed(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The live API URL is invalid."
        case .invalidResponse:
            return "The server sent an invalid response."
        case let .httpError(statusCode, body):
            return "The server returned status \(statusCode). \(body)"
        case let .decodingFailed(error):
            return "Could not read the live response. \(error.localizedDescription)"
        case let .networkFailed(error):
            return "The network request failed. \(error.localizedDescription)"
        }
    }
}

struct APIService {
    static let shared = APIService()

    private let baseURLString = "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net"
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 10
            configuration.timeoutIntervalForResource = 10
            self.session = URLSession(configuration: configuration)
        }
    }

    func analyzeComp(query: String) async throws -> CompIQResponse {
        let request = CompIQAnalyzeRequest(
            query: query,
            player: query,
            cardType: "Baseball Card",
            parallel: "Unknown",
            grade: "Raw",
            recentComps: [100, 120, 140]
        )
        return try await post(path: "/api/compiq/analyze", body: request, responseType: CompIQResponse.self)
    }

    func analyzePlayer(query: String) async throws -> PlayerIQResponse {
        let request = PlayerIQAnalyzeRequest(
            query: query,
            player: query,
            level: "Unknown",
            stats: PlayerStatsPayload(avg: 0.250, hr: 10, ops: 0.750)
        )
        let response: PlayerIQAPIResponse = try await post(
            path: "/api/playeriq/analyze",
            body: request,
            responseType: PlayerIQAPIResponse.self
        )
        return response.asPlayerIQResponse()
    }

    func healthCheck() async throws -> HealthStatusResponse {
        try await get(path: "/api/health", responseType: HealthStatusResponse.self)
    }

    func statusCheck() async throws -> HealthStatusResponse {
        try await get(path: "/api/status", responseType: HealthStatusResponse.self)
    }

    private func get<Response: Decodable>(path: String, responseType: Response.Type) async throws -> Response {
        let request = try makeRequest(path: path, method: "GET", bodyData: nil)
        return try await perform(request, responseType: responseType)
    }

    private func post<Request: Encodable, Response: Decodable>(
        path: String,
        body: Request,
        responseType: Response.Type
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        if let bodyText = String(data: bodyData, encoding: .utf8) {
            print("Request Body:", bodyText)
        }
        let request = try makeRequest(path: path, method: "POST", bodyData: bodyData)
        return try await perform(request, responseType: responseType)
    }

    private func makeRequest(path: String, method: String, bodyData: Data?) throws -> URLRequest {
        guard let baseURL = URL(string: baseURLString) else {
            throw APIServiceError.invalidURL
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/" + path
        let url = baseURL.appending(path: normalizedPath)

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        print("Request URL:", url.absoluteString)
        return request
    }

    private func perform<Response: Decodable>(_ request: URLRequest, responseType: Response.Type) async throws -> Response {
        do {
            let (data, response) = try await session.data(for: request)
            let rawResponse = String(data: data, encoding: .utf8) ?? ""
            print("Raw Response:", rawResponse)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIServiceError.invalidResponse
            }

            guard 200..<300 ~= httpResponse.statusCode else {
                throw APIServiceError.httpError(statusCode: httpResponse.statusCode, body: rawResponse)
            }

            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                print("Decode Error:", error.localizedDescription)
                throw APIServiceError.decodingFailed(error)
            }
        } catch let error as APIServiceError {
            throw error
        } catch {
            throw APIServiceError.networkFailed(error)
        }
    }
}

struct CompIQAnalyzeRequest: Codable {
    let query: String
    let player: String
    let cardType: String
    let parallel: String
    let grade: String
    let recentComps: [Int]
}

struct PlayerIQAnalyzeRequest: Codable {
    let query: String
    let player: String
    let level: String
    let stats: PlayerStatsPayload
}

struct PlayerStatsPayload: Codable {
    let avg: Double
    let hr: Int
    let ops: Double
}

struct HealthStatusResponse: Codable {
    let status: String?
    let message: String?
}
