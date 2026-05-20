//
//  APIConfig.swift
//  HobbyIQ
//

import Foundation

enum APIConfig {
    static let baseURL = URL(string: "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net")!

    static let ebayOAuthCallbackScheme = "hobbyiq"
    static let ebayOAuthCallbackHost = "ebay"
    static let ebayOAuthCallbackPath = "/connected"

    static var ebayOAuthCallbackURL: URL {
        var components = URLComponents()
        components.scheme = ebayOAuthCallbackScheme
        components.host = ebayOAuthCallbackHost
        components.path = ebayOAuthCallbackPath
        return components.url ?? URL(string: "hobbyiq://ebay/connected")!
    }

    static var ebayOAuthStartURL: URL? {
        let environment = ProcessInfo.processInfo.environment
        let candidates = [
            environment["HOBBYIQ_EBAY_OAUTH_START_URL"],
            environment["EBAY_OAUTH_START_URL"],
            "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/ebay/connect/start"
        ]

        for candidate in candidates {
            guard let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  value.isEmpty == false else { continue }
            if let url = URL(string: value) {
                return url
            }
        }

        return nil
    }
}
