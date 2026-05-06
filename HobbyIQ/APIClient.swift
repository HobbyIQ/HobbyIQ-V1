//
//  APIClient.swift
//  HobbyIQ
//

import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, message: String?)
    case decodingError(Error)
    case encodingError(Error)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The request URL is invalid."
        case .invalidResponse:
            return "The server returned an invalid response."
        case let .httpError(statusCode, message):
            if let message, message.isEmpty == false {
                return "Request failed with status \(statusCode): \(message)"
            }
            return "Request failed with status \(statusCode)."
        case let .decodingError(error):
            return "Failed to decode the server response: \(error.localizedDescription)"
        case let .encodingError(error):
            return "Failed to encode the request body: \(error.localizedDescription)"
        case let .networkError(error):
            return "Network request failed: \(error.localizedDescription)"
        }
    }
}

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
}

struct APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        session: URLSession = .shared,
        encoder: JSONEncoder = JSONEncoder(),
        decoder: JSONDecoder = JSONDecoder()
    ) {
        self.session = session
        self.encoder = encoder
        self.decoder = decoder
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    func get<Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = []
    ) async throws -> Response {
        try await request(
            path: path,
            method: .get,
            queryItems: queryItems,
            requestBody: Optional<EmptyRequestBody>.none
        )
    }

    func post<Request: Encodable, Response: Decodable>(
        path: String,
        body: Request
    ) async throws -> Response {
        try await request(
            path: path,
            method: .post,
            requestBody: body
        )
    }

    private func request<Request: Encodable, Response: Decodable>(
        path: String,
        method: HTTPMethod,
        queryItems: [URLQueryItem] = [],
        requestBody: Request?
    ) async throws -> Response {
        let request = try makeURLRequest(
            path: path,
            method: method,
            queryItems: queryItems,
            requestBody: requestBody
        )

        do {
            let (data, response) = try await session.data(for: request)
            return try decodeResponse(data: data, response: response)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.networkError(error)
        }
    }

    private func makeURLRequest<Request: Encodable>(
        path: String,
        method: HTTPMethod,
        queryItems: [URLQueryItem],
        requestBody: Request?
    ) throws -> URLRequest {
        guard var components = URLComponents(
            url: APIConfig.baseURL.appending(path: normalizedPath(path)),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.invalidURL
        }

        if queryItems.isEmpty == false {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let requestBody {
            do {
                request.httpBody = try encoder.encode(requestBody)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            } catch {
                throw APIError.encodingError(error)
            }
        }

        return request
    }

    private func decodeResponse<Response: Decodable>(
        data: Data,
        response: URLResponse
    ) throws -> Response {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard 200 ..< 300 ~= httpResponse.statusCode else {
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: message)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    private func normalizedPath(_ path: String) -> String {
        path.hasPrefix("/") ? path : "/" + path
    }
}

private struct EmptyRequestBody: Encodable {}
