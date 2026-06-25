//
//  APIConfig.swift
//  HobbyIQ
//

import Foundation

enum APIConfig {
    /// CF-IOS-CLEANUP-CHAIN Stage 3 (2026-06-25): build-config switch.
    /// RELEASE builds always hit prod. DEBUG builds honor the
    /// `HOBBYIQ_API_BASE_URL` env var (set in the Run scheme's Arguments
    /// → Environment Variables) so a developer can point at a local or
    /// staging backend without code edits; defaults to prod when unset
    /// so today's flow is byte-identical. TODO: replace the default
    /// with a real staging host once one exists.
    #if DEBUG
    static let baseURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["HOBBYIQ_API_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           raw.isEmpty == false,
           let override = URL(string: raw) {
            return override
        }
        return URL(string: "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net")!
    }()
    #else
    static let baseURL = URL(string: "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net")!
    #endif

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
