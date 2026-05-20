//
//  DashboardService.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class DashboardService: ObservableObject {
    static let shared = DashboardService()

    @Published private(set) var snapshot: DashboardSnapshot?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private let baseURL: URL? = APIConfig.baseURL
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

    func load(userId: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            snapshot = try await fetchDashboard(userId: userId)
            errorMessage = nil
        } catch {
            snapshot = nil
            errorMessage = userFacingMessage(for: error, fallback: "The dashboard is unavailable right now.")
        }
    }

    func fetchDashboard(userId: String) async throws -> DashboardSnapshot {
        let resolvedUserId = resolvedUserId(from: userId)

        async let holdingsTask = APIService.shared.fetchPortfolioHoldings(userId: resolvedUserId)
        async let briefTask = APIService.shared.fetchDailyBrief(userId: resolvedUserId)

        let holdings = (try? await holdingsTask) ?? []
        let brief = try? await briefTask

        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalPL = totalValue - totalCost
        let roi = totalCost > 0 ? (totalPL / totalCost) * 100 : 0

        let portfolioHighlights = (brief?.portfolioHighlights ?? []).prefix(5).map { h in
            DashboardPortfolioHighlight(
                playerName: h.playerName,
                team: h.team,
                statLine: h.statLine,
                cardImpact: h.cardImpact,
                action: h.action,
                actionRationale: h.actionRationale,
                inventoryImpact: h.inventoryImpact
            )
        }

        let buyTargets = (brief?.buyTargets ?? []).prefix(3).map { b in
            DashboardPortfolioHighlight(
                playerName: b.playerName,
                team: b.team,
                statLine: b.statLine,
                cardImpact: "",
                action: "Buy",
                actionRationale: b.reason,
                inventoryImpact: ""
            )
        }

        let hotPlayers = brief?.hotPlayers ?? []

        let watchFeed = (brief?.topMLB ?? []).prefix(5).map { p in
            WatchFeedPlayer(playerName: p.playerName, team: p.teamName, statLine: p.statLine, trend: p.trend)
        }

        let dateString = brief?.date ?? DailyIQService.apiDateString(Date())

        return DashboardSnapshot(
            userId: resolvedUserId,
            date: dateString,
            portfolio: DashboardPortfolio(
                totalCost: totalCost,
                totalCurrentValue: totalValue,
                totalProfitLoss: totalPL,
                roi: roi,
                activeCount: holdings.count,
                monthProfit: 0,
                yearProfit: 0
            ),
            metrics: nil,
            highlights: DashboardHighlights(
                portfolioHighlights: portfolioHighlights,
                buyTargets: buyTargets,
                hotPlayers: hotPlayers
            ),
            watchFeed: watchFeed,
            notifications: DashboardNotifications(unreadCount: 0, recent: [])
        )
    }

    func addCard(
        userId: String,
        playerName: String,
        cardName: String,
        cost: Double,
        currentValue: Double
    ) async throws -> AddCardResponse {
        let resolvedUserId = resolvedUserId(from: userId)
        let payload = AddCardRequest(
            userId: resolvedUserId,
            playerName: playerName,
            cardName: cardName,
            cost: cost,
            currentValue: currentValue,
            status: "active",
            year: nil,
            setName: nil,
            parallel: nil,
            grade: nil,
            purchaseDate: nil,
            purchasePlatform: nil,
            quantity: nil,
            notes: nil
        )

        return try await request(
            path: "/api/portfolio/holdings",
            method: "POST",
            body: AnyEncodable(payload)
        )
    }

    private func request<Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String,
        body: AnyEncodable? = nil
    ) async throws -> Response {
        let urlRequest = try makeRequest(path: path, queryItems: queryItems, method: method, body: body)
        let (data, response) = try await session.data(for: urlRequest)
        return try decode(data: data, response: response)
    }

    private func makeRequest(
        path: String,
        queryItems: [URLQueryItem],
        method: String,
        body: AnyEncodable?
    ) throws -> URLRequest {
        guard let baseURL else {
            throw APIError.invalidURL
        }

        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }

        components.path = path.hasPrefix("/") ? path : "/\(path)"
        if queryItems.isEmpty == false {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = AuthService.shared.session?.token, token.isEmpty == false {
            request.setValue(token, forHTTPHeaderField: "x-session-id")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body {
            do {
                request.httpBody = try encoder.encode(body)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            } catch {
                throw APIError.encodingError(error)
            }
        }

        return request
    }

    private func decode<Response: Decodable>(data: Data, response: URLResponse) throws -> Response {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        guard (200...299).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw APIError.httpError(statusCode: http.statusCode, message: message)
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    private func resolvedUserId(from userId: String) -> String {
        let trimmed = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, let fallback = AuthService.shared.userId, fallback.isEmpty == false {
            return fallback
        }
        return trimmed
    }

    private func userFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }
}

private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void

    init(_ wrapped: some Encodable) {
        self.encodeClosure = { encoder in
            try wrapped.encode(to: encoder)
        }
    }

    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}
