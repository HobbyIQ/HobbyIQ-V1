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
