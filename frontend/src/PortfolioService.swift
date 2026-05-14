//  PortfolioService.swift
//  HobbyIQ — Per-user, server-backed PortfolioIQ holdings sync.
//
//  Wraps APIService.fetch/add/update/remove + the new GET /api/portfolio
//  summary endpoint, exposes them as an ObservableObject the SwiftUI views
//  can bind to, and provides a one-shot SwiftData → server seed so users
//  upgrading from local-only inventory don't lose anything when the
//  multi-device sync feature lights up.
//
//  Persists session via UserDefaults "auth.sessionId" (matches the rest of
//  the app). On HTTP 401 from any endpoint, posts
//  Notification.Name("auth.sessionExpired") so the root view can present
//  SignInView.

import Foundation

struct PortfolioSummary: Codable, Equatable {
    let totalValue: Double
    let totalCost: Double
    let totalGainLoss: Double
    let totalGainLossPct: Double
    let cardCount: Int

    static let zero = PortfolioSummary(
        totalValue: 0, totalCost: 0, totalGainLoss: 0,
        totalGainLossPct: 0, cardCount: 0
    )
}

private struct PortfolioFetchResponse: Codable {
    let success: Bool?
    let userId: String?
    let items: [PortfolioHolding]?
    let summary: PortfolioSummary?
    let error: String?
}

@MainActor
final class PortfolioService: ObservableObject {
    static let shared = PortfolioService()

    @Published private(set) var items: [PortfolioHolding] = []
    @Published private(set) var summary: PortfolioSummary = .zero
    @Published private(set) var isLoading: Bool = false
    @Published var lastError: String?

    private static let backendBase = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
    private static let sessionKey  = "auth.sessionId"
    private static let syncedKey   = "portfolio.synced"

    private let api = APIService.shared

    private init() {}

    // MARK: - Public API

    /// Pull holdings + summary from the server. Existing items are preserved
    /// during the request and only replaced after a successful decode, so a
    /// transient network error never wipes the UI.
    func fetchPortfolio() async {
        if isLoading { return }
        guard let sid = sessionId() else {
            lastError = "Not signed in"
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let url = URL(string: Self.backendBase + "/api/portfolio")!
            var req = URLRequest(url: url)
            req.httpMethod = "GET"
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            req.setValue(sid, forHTTPHeaderField: "x-session-id")
            req.timeoutInterval = 20
            let (data, resp) = try await URLSession.shared.data(for: req)
            try Self.assertOK(resp)
            let decoded = try JSONDecoder().decode(PortfolioFetchResponse.self, from: data)
            if let next = decoded.items {
                items = next
            }
            if let s = decoded.summary {
                summary = s
            } else {
                summary = Self.computeSummary(items: items)
            }
            lastError = nil
        } catch let err as AuthError where err == .sessionExpired {
            // root view handles re-auth — keep last items visible
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refresh() async {
        await fetchPortfolio()
    }

    /// Add a holding both locally (optimistic) and on the server.
    @discardableResult
    func addHolding(_ holding: PortfolioHolding) async -> Bool {
        guard let sid = sessionId() else { return false }
        items.insert(holding, at: 0)
        recomputeSummary()
        do {
            _ = try await api.addPortfolioHolding(holding, sessionId: sid)
            await fetchPortfolio()
            return true
        } catch {
            items.removeAll { $0.id == holding.id }
            recomputeSummary()
            handle(error: error)
            return false
        }
    }

    /// Update a holding optimistically with server reconciliation.
    @discardableResult
    func updateHolding(_ holding: PortfolioHolding) async -> Bool {
        guard let sid = sessionId() else { return false }
        guard let idx = items.firstIndex(where: { $0.id == holding.id }) else {
            return false
        }
        let previous = items[idx]
        items[idx] = holding
        recomputeSummary()
        do {
            _ = try await api.updatePortfolioHolding(holding, sessionId: sid)
            return true
        } catch {
            items[idx] = previous
            recomputeSummary()
            handle(error: error)
            return false
        }
    }

    /// Remove a holding optimistically with rollback on failure.
    @discardableResult
    func removeHolding(holdingId: UUID) async -> Bool {
        guard let sid = sessionId() else { return false }
        guard let idx = items.firstIndex(where: { $0.id == holdingId }) else {
            return false
        }
        let removed = items.remove(at: idx)
        recomputeSummary()
        do {
            _ = try await api.removePortfolioHolding(holdingId: holdingId, sessionId: sid)
            return true
        } catch {
            items.insert(removed, at: idx)
            recomputeSummary()
            handle(error: error)
            return false
        }
    }

    // MARK: - One-shot SwiftData → server seed

    /// Migration helper: the FIRST time the user with this device opens the
    /// PortfolioIQ tab after the multi-device sync feature ships, push every
    /// SwiftData-backed holding up to the server so nothing is lost. After a
    /// successful upload we flip UserDefaults `portfolio.synced` so this is
    /// never repeated.
    ///
    /// Caller is expected to pass the current PortfolioIQViewModel.holdings
    /// (which is itself derived from SwiftData CardItems via the existing
    /// view-model code).
    @discardableResult
    func syncFromSwiftData(holdings: [PortfolioHolding]) async -> Bool {
        if UserDefaults.standard.bool(forKey: Self.syncedKey) {
            return true
        }
        guard let sid = sessionId() else { return false }
        guard !holdings.isEmpty else {
            UserDefaults.standard.set(true, forKey: Self.syncedKey)
            return true
        }

        // Pull server state first to avoid duplicating rows the user already
        // has on another device.
        await fetchPortfolio()
        let existing = Set(items.map { $0.id })
        let toUpload = holdings.filter { !existing.contains($0.id) }

        var uploaded = 0
        for holding in toUpload {
            do {
                _ = try await api.addPortfolioHolding(holding, sessionId: sid)
                uploaded += 1
            } catch {
                handle(error: error)
                // Stop on session expiry; otherwise keep going so a single
                // bad row doesn't block the whole migration.
                if case AuthError.sessionExpired = error { return false }
            }
        }
        UserDefaults.standard.set(true, forKey: Self.syncedKey)
        await fetchPortfolio()
        print("[PortfolioService] one-shot sync uploaded \(uploaded)/\(toUpload.count) holdings")
        return true
    }

    /// Resets the one-shot guard so a future call to syncFromSwiftData runs
    /// again. Useful after sign-out → sign-in as a different user.
    func resetSyncFlag() {
        UserDefaults.standard.removeObject(forKey: Self.syncedKey)
    }

    // MARK: - Helpers

    private enum AuthError: Error, Equatable { case sessionExpired }

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

    private func sessionId() -> String? {
        guard
            let sid = UserDefaults.standard.string(forKey: Self.sessionKey),
            !sid.isEmpty
        else { return nil }
        return sid
    }

    private func handle(error: Error) {
        // APIService throws URLError with .userAuthenticationRequired or a
        // generic .badServerResponse on 401 depending on the helper used.
        if let urlErr = error as? URLError,
           urlErr.code == .userAuthenticationRequired
        {
            NotificationCenter.default.post(
                name: Notification.Name("auth.sessionExpired"),
                object: nil
            )
            return
        }
        lastError = error.localizedDescription
    }

    private func recomputeSummary() {
        summary = Self.computeSummary(items: items)
    }

    private static func computeSummary(items: [PortfolioHolding]) -> PortfolioSummary {
        var totalValue: Double = 0
        var totalCost: Double = 0
        var cardCount: Int = 0
        for h in items {
            // Match server-side rule: only "active inventory" counts toward
            // the dashboard summary; sold / archived / watchlist are out.
            switch h.cardStatus {
            case .sold, .archived, .watchlist, .tradePending:
                continue
            default:
                break
            }
            let qty = max(1, h.quantity)
            totalValue += h.currentValue * Double(qty)
            // totalCostBasis is the *row total* (already includes qty).
            totalCost  += h.totalCostBasis > 0
                ? h.totalCostBasis
                : h.purchasePrice * Double(qty)
            cardCount  += qty
        }
        let totalGainLoss = totalValue - totalCost
        let totalGainLossPct = totalCost > 0
            ? (totalGainLoss / totalCost) * 100
            : 0
        return PortfolioSummary(
            totalValue: round2(totalValue),
            totalCost: round2(totalCost),
            totalGainLoss: round2(totalGainLoss),
            totalGainLossPct: round2(totalGainLossPct),
            cardCount: cardCount
        )
    }

    private static func round2(_ v: Double) -> Double {
        (v * 100).rounded() / 100
    }
}
