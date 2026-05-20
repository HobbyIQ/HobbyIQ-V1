//  WatchlistService.swift
//  HobbyIQ — Per-user, server-backed player watchlist.
//
//  Persists to the TS backend at /api/watchlist (Cosmos container `watchlist`,
//  partitioned by /userId). All requests carry x-session-id from
//  UserDefaults "auth.sessionId". On 401 we post Notification.Name
//  "auth.sessionExpired" so the root view can present SignInView.
//
//  Optimistic mutations: add/remove/toggle apply locally first, then roll
//  back if the server rejects.

import Foundation
import Combine

/// Wire-format model for /api/watchlist entries.
struct WatchlistItem: Codable, Identifiable, Hashable {
    let id: String                // alias of watchlistItemId for SwiftUI ForEach
    let watchlistItemId: String
    let userId: String
    let playerId: String
    let playerName: String
    let sport: String
    var alertEnabled: Bool
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case watchlistItemId, userId, playerId, playerName
        case sport, alertEnabled, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let wid = try c.decode(String.self, forKey: .watchlistItemId)
        self.watchlistItemId = wid
        self.id = wid
        self.userId        = try c.decode(String.self, forKey: .userId)
        self.playerId      = try c.decode(String.self, forKey: .playerId)
        self.playerName    = try c.decode(String.self, forKey: .playerName)
        self.sport         = try c.decodeIfPresent(String.self, forKey: .sport) ?? "MLB"
        self.alertEnabled  = try c.decodeIfPresent(Bool.self, forKey: .alertEnabled) ?? true
        self.createdAt     = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(watchlistItemId, forKey: .watchlistItemId)
        try c.encode(userId, forKey: .userId)
        try c.encode(playerId, forKey: .playerId)
        try c.encode(playerName, forKey: .playerName)
        try c.encode(sport, forKey: .sport)
        try c.encode(alertEnabled, forKey: .alertEnabled)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

private struct WatchlistListResponse: Decodable {
    let success: Bool
    let items: [WatchlistItem]?
    let error: String?
}

private struct WatchlistAddRequest: Encodable {
    let playerId: String
    let playerName: String
    let sport: String
    let alertEnabled: Bool
}

private struct WatchlistAddResponse: Decodable {
    let success: Bool
    let watchlistItemId: String?
    let item: WatchlistItem?
    let error: String?
}

private struct WatchlistPatchRequest: Encodable {
    let alertEnabled: Bool
}

private struct WatchlistMutateResponse: Decodable {
    let success: Bool
    let item: WatchlistItem?
    let error: String?
}

@MainActor
final class WatchlistService: ObservableObject {
    static let shared = WatchlistService()

    @Published private(set) var items: [WatchlistItem] = []
    @Published private(set) var isLoading: Bool = false
    @Published var lastError: String?

    private static let backendBase = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
    private static let sessionKey  = "auth.sessionId"

    private init() {}

    // MARK: - Public API

    /// Pull the latest watchlist from the server. Existing in-memory items
    /// are preserved while the request is in flight; on success they are
    /// replaced with the server's authoritative list. On error the previous
    /// list is kept so refresh never wipes the UI.
    func fetchWatchlist() async {
        if isLoading { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let req = try makeRequest(path: "/api/watchlist", method: "GET")
            let (data, resp) = try await URLSession.shared.data(for: req)
            try Self.assertOK(resp)
            let decoded = try JSONDecoder().decode(WatchlistListResponse.self, from: data)
            if decoded.success, let next = decoded.items {
                items = next.sorted { $0.createdAt > $1.createdAt }
                lastError = nil
            } else {
                lastError = decoded.error ?? "Failed to load watchlist"
            }
        } catch let err as AuthError where err == .sessionExpired {
            // root view handles re-auth — leave items alone
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Force a re-fetch without clearing the current items first.
    func refresh() async {
        await fetchWatchlist()
    }

    /// Add a player to the watchlist. Optimistic — appends a placeholder row
    /// immediately then reconciles with the server response. Returns true
    /// when the server accepts the add.
    @discardableResult
    func addToWatchlist(
        playerId: String,
        playerName: String,
        sport: String = "MLB",
        alertEnabled: Bool = true
    ) async -> Bool {
        // Idempotent guard: if already present, just flip alert flag locally.
        if let idx = items.firstIndex(where: { $0.playerId == playerId }) {
            if items[idx].alertEnabled != alertEnabled {
                await toggleAlert(itemId: items[idx].watchlistItemId, enabled: alertEnabled)
            }
            return true
        }

        let placeholder = makeOptimisticItem(
            playerId: playerId,
            playerName: playerName,
            sport: sport,
            alertEnabled: alertEnabled
        )
        items.insert(placeholder, at: 0)

        do {
            var req = try makeRequest(path: "/api/watchlist", method: "POST")
            req.httpBody = try JSONEncoder().encode(WatchlistAddRequest(
                playerId: playerId,
                playerName: playerName,
                sport: sport,
                alertEnabled: alertEnabled
            ))
            let (data, resp) = try await URLSession.shared.data(for: req)
            try Self.assertOK(resp)
            let decoded = try JSONDecoder().decode(WatchlistAddResponse.self, from: data)
            guard decoded.success, let saved = decoded.item else {
                items.removeAll { $0.id == placeholder.id }
                lastError = decoded.error ?? "Could not add to watchlist"
                return false
            }
            // Replace the placeholder with the real server-issued row.
            if let idx = items.firstIndex(where: { $0.id == placeholder.id }) {
                items[idx] = saved
            } else {
                items.insert(saved, at: 0)
            }
            lastError = nil
            return true
        } catch let err as AuthError where err == .sessionExpired {
            items.removeAll { $0.id == placeholder.id }
            return false
        } catch {
            items.removeAll { $0.id == placeholder.id }
            lastError = error.localizedDescription
            return false
        }
    }

    /// Remove a watchlist item. Optimistic — removes locally first; rolls
    /// back if the server rejects.
    @discardableResult
    func removeFromWatchlist(itemId: String) async -> Bool {
        guard let idx = items.firstIndex(where: { $0.watchlistItemId == itemId }) else {
            return false
        }
        let removed = items.remove(at: idx)
        do {
            let req = try makeRequest(path: "/api/watchlist/\(itemId)", method: "DELETE")
            let (_, resp) = try await URLSession.shared.data(for: req)
            try Self.assertOK(resp)
            lastError = nil
            return true
        } catch let err as AuthError where err == .sessionExpired {
            items.insert(removed, at: idx)
            return false
        } catch {
            items.insert(removed, at: idx)
            lastError = error.localizedDescription
            return false
        }
    }

    /// Toggle the alertEnabled flag for a single watchlist row. Optimistic
    /// with rollback on server error.
    func toggleAlert(itemId: String, enabled: Bool) async {
        guard let idx = items.firstIndex(where: { $0.watchlistItemId == itemId }) else {
            return
        }
        let previous = items[idx].alertEnabled
        items[idx].alertEnabled = enabled
        do {
            var req = try makeRequest(path: "/api/watchlist/\(itemId)", method: "PATCH")
            req.httpBody = try JSONEncoder().encode(WatchlistPatchRequest(alertEnabled: enabled))
            let (data, resp) = try await URLSession.shared.data(for: req)
            try Self.assertOK(resp)
            let decoded = try JSONDecoder().decode(WatchlistMutateResponse.self, from: data)
            if decoded.success, let updated = decoded.item {
                items[idx] = updated
            } else if !decoded.success {
                items[idx].alertEnabled = previous
                lastError = decoded.error ?? "Could not update alert"
            }
        } catch let err as AuthError where err == .sessionExpired {
            items[idx].alertEnabled = previous
        } catch {
            items[idx].alertEnabled = previous
            lastError = error.localizedDescription
        }
    }

    /// Local fast-path used by views that need to know whether a player is
    /// already watched without round-tripping the server.
    func isWatching(playerId: String) -> Bool {
        items.contains(where: { $0.playerId == playerId })
    }

    // MARK: - Helpers

    private enum AuthError: Error { case sessionExpired }

    private static func assertOK(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        if http.statusCode == 401 {
            NotificationCenter.default.post(
                name: Notification.Name("auth.sessionExpired"),
                object: nil
            )
            throw AuthError.sessionExpired
        }
        if !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        guard let url = URL(string: Self.backendBase + path) else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let sid = UserDefaults.standard.string(forKey: Self.sessionKey), !sid.isEmpty {
            req.setValue(sid, forHTTPHeaderField: "x-session-id")
        }
        req.timeoutInterval = 20
        return req
    }

    private func makeOptimisticItem(
        playerId: String,
        playerName: String,
        sport: String,
        alertEnabled: Bool
    ) -> WatchlistItem {
        let userId = UserDefaults.standard.string(forKey: "auth.userId") ?? ""
        let placeholderJSON: [String: Any] = [
            "watchlistItemId": "pending_\(UUID().uuidString)",
            "userId": userId,
            "playerId": playerId,
            "playerName": playerName,
            "sport": sport,
            "alertEnabled": alertEnabled,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        // Force-decode through the same path so the placeholder shape is
        // identical to a real server row.
        let data = try! JSONSerialization.data(withJSONObject: placeholderJSON)
        return try! JSONDecoder().decode(WatchlistItem.self, from: data)
    }
}
