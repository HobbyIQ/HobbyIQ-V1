//
//  AppSupport.swift
//  HobbyIQ
//

import Combine
import Foundation

enum RecommendationAction: String, Codable, CaseIterable, Identifiable {
    case buy = "Buy"
    case hold = "Hold"
    case trim = "Trim"
    case sell = "Sell"
    case watch = "Watch"

    var id: String { rawValue }
}

enum WatchEntityType: String, Codable, CaseIterable, Identifiable {
    case player = "Player"
    case card = "Card"
    case portfolio = "Portfolio"

    var id: String { rawValue }
}

enum AlertSeverity: String, Codable, CaseIterable, Identifiable {
    case buy = "Buy"
    case caution = "Caution"
    case risk = "Risk"
    case info = "Info"

    var id: String { rawValue }
}

enum AlertFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case buy = "Buy"
    case trimSell = "Trim/Sell"
    case risk = "Risk"
    case player = "Player"
    case card = "Card"

    var id: String { rawValue }
}

enum AppTab: Hashable {
    case home
    case search
    case watchlist
    case alerts
    case portfolio
    case more
}

enum AppRoute: Equatable {
    case alert(UUID)
    case portfolio(UUID)
    case player(String)
    case card(String)
}

struct OAuthCallback: Identifiable, Equatable {
    let id = UUID()
    let provider: String
    let action: String
    let queryItems: [String: String]
    let receivedAt: Date

    init(provider: String, action: String, queryItems: [String: String], receivedAt: Date) {
        self.provider = provider
        self.action = action
        self.queryItems = queryItems
        self.receivedAt = receivedAt
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "hobbyiq" else { return nil }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let provider = components?.host?.lowercased() ?? ""
        let action = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        guard provider.isEmpty == false, action.isEmpty == false else { return nil }

        let queryItems = components?.queryItems ?? []
        var values: [String: String] = [:]
        for item in queryItems {
            guard let value = item.value, value.isEmpty == false else { continue }
            values[item.name] = value
        }

        self.init(
            provider: provider,
            action: action,
            queryItems: values,
            receivedAt: Date()
        )
    }

    var ebayUser: String? {
        queryItems["ebayUser"]
    }

    var isEBayConnection: Bool {
        provider.lowercased() == "ebay" && action.lowercased() == "connected"
    }

    var isEBayError: Bool {
        provider.lowercased() == "ebay" && action.lowercased() == "error"
    }

    var statusMessage: String? {
        if isEBayConnection {
            return ebayUser.map { "Connected eBay account: \($0)" } ?? "Connected eBay account."
        }

        if isEBayError {
            return queryItems["message"] ?? "eBay sign-in could not be completed."
        }

        return nil
    }
}

struct RefreshMeta: Codable, Equatable {
    let lastUpdated: Date?
    let freshnessLabel: String?
    let confidence: Int?
    let note: String?

    static let unknown = RefreshMeta(
        lastUpdated: nil,
        freshnessLabel: "Awaiting sync",
        confidence: nil,
        note: nil
    )

    var relativeTimestamp: String {
        guard let lastUpdated else { return "Awaiting sync" }
        return RelativeDateTimeFormatter().localizedString(for: lastUpdated, relativeTo: Date())
    }
}

struct HomeSnapshot: Codable {
    let headline: String
    let summary: String
    let recentAlertsCount: Int
    let watchlistMoversCount: Int
    let portfolioActionCount: Int
    let syncStatus: String
    let highlights: [HighlightItem]
    let refreshMeta: RefreshMeta
}

struct HighlightItem: Codable, Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let action: RecommendationAction

    enum CodingKeys: String, CodingKey {
        case title
        case detail
        case action
    }
}

struct WatchlistItem: Codable, Identifiable, Equatable {
    let id: UUID
    let name: String
    let subtitle: String
    let type: WatchEntityType
    let action: RecommendationAction
    let alertCount: Int
    let refreshMeta: RefreshMeta
}

struct AlertItem: Codable, Identifiable, Equatable {
    let id: UUID
    let title: String
    let summary: String
    let detail: String
    let severity: AlertSeverity
    let category: WatchEntityType
    let actionLabel: String?
    let triggeredAt: Date
    let confidence: Int?
    let significance: String?
    let changeSummary: String?
    let linkedPlayerQuery: String?
    let linkedCardQuery: String?
    let linkedPositionID: UUID?
}

struct AlertPreferences: Codable, Equatable {
    var inAppEnabled: Bool
    var emailEnabled: Bool
    var pushEnabled: Bool
    var watchlistAlertsEnabled: Bool
    var portfolioAlertsEnabled: Bool
    var moverAlertsEnabled: Bool
    var minimumSeverity: AlertSeverity
}

struct PositionTargets: Codable, Equatable {
    var addTarget: Double?
    var trimTarget: Double?
    var sellTarget: Double?
    var protectCapital: Double?
}

struct PortfolioPosition: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var subtitle: String
    var entityType: WatchEntityType
    var quantity: Double
    var averageCost: Double
    var currentValuePerUnit: Double
    var action: RecommendationAction
    var explanation: String
    var conviction: String
    var notes: String
    var targets: PositionTargets
    var catalyst: String
    var cautionReasons: [String]
    var recentAlerts: [AlertItem]
    var refreshMeta: RefreshMeta

    var marketValue: Double { quantity * currentValuePerUnit }
    var costBasis: Double { quantity * averageCost }
    var unrealizedPnL: Double { marketValue - costBasis }
    var pnlPercent: Double {
        guard costBasis > 0 else { return 0 }
        return (unrealizedPnL / costBasis) * 100
    }
}

struct PortfolioSummary: Codable, Equatable {
    let estimatedValue: Double
    let costBasis: Double
    let unrealizedPnL: Double
    let actionCounts: [RecommendationAction: Int]
    let positions: [PortfolioPosition]
    let refreshMeta: RefreshMeta
}

struct PerformancePoint: Codable, Identifiable, Equatable {
    let id = UUID()
    let date: Date
    let value: Double

    enum CodingKeys: String, CodingKey {
        case date
        case value
    }
}

struct PerformanceSnapshot: Codable, Equatable {
    let totalReturnPercent: Double
    let benchmarkReturnPercent: Double?
    let recommendationAccuracyPercent: Double?
    let series: [PerformancePoint]
    let refreshMeta: RefreshMeta
}

struct IntegrationStatus: Codable, Identifiable, Equatable {
    let id = UUID()
    let providerName: String
    let configured: Bool
    let statusLabel: String
    let lastSync: Date?
    let note: String
    let recentRuns: [SyncRun]

    enum CodingKeys: String, CodingKey {
        case providerName
        case configured
        case statusLabel
        case lastSync
        case note
        case recentRuns
    }
}

struct SyncRun: Codable, Identifiable, Equatable {
    let id = UUID()
    let title: String
    let status: String
    let timestamp: Date
    let detail: String

    enum CodingKeys: String, CodingKey {
        case title
        case status
        case timestamp
        case detail
    }
}

@MainActor
final class AppState: ObservableObject {
    /// Shared reference for use in non-view contexts (e.g. notification delegate).
    /// Set once from HobbyIQApp on launch.
    nonisolated(unsafe) static weak var shared: AppState?

    @Published var selectedTab: AppTab = .home
    @Published var pendingRoute: AppRoute?
    @Published var pendingOAuthCallback: OAuthCallback?
    @Published var connectedEBayUser: String?
    @Published var oauthStatusMessage: String?

    func route(to route: AppRoute) {
        pendingRoute = route
        switch route {
        case .alert:
            selectedTab = .alerts
        case .portfolio:
            selectedTab = .portfolio
        case .player, .card:
            selectedTab = .search
        }
    }

    @discardableResult
    func handleIncomingURL(_ url: URL) -> Bool {
        guard let callback = OAuthCallback(url: url) else { return false }

        pendingOAuthCallback = callback

        if callback.isEBayConnection {
            connectedEBayUser = callback.ebayUser
            oauthStatusMessage = callback.statusMessage
            selectedTab = .portfolio
            EBayOAuthCoordinator.shared.handleOAuthCallback(callback)
        } else if callback.isEBayError {
            connectedEBayUser = nil
            oauthStatusMessage = callback.statusMessage
            EBayOAuthCoordinator.shared.handleOAuthCallback(callback)
        }

        return true
    }

    func consumeOAuthCallback() {
        pendingOAuthCallback = nil
    }

    func clearOAuthStatus() {
        oauthStatusMessage = nil
    }
}

struct WatchlistDTO: Codable {
    let items: [WatchlistItem]?
}

struct AlertInboxDTO: Codable {
    let items: [AlertItem]?
}

struct PortfolioDTO: Codable {
    let estimatedValue: Double?
    let costBasis: Double?
    let unrealizedPnL: Double?
    let positions: [PortfolioPosition]?
}

struct PerformanceDTO: Codable {
    let totalReturnPercent: Double?
    let benchmarkReturnPercent: Double?
    let recommendationAccuracyPercent: Double?
    let series: [PerformancePoint]?
}

struct IntegrationDTO: Codable {
    let providers: [IntegrationStatus]?
}

struct SearchRequest: Codable {
    let query: String
}

@MainActor
final class OperationalDataService {
    static let shared = OperationalDataService()

    private let apiService = APIService.shared

    private static func previousDayDailyIQDateString(referenceDate: Date = Date()) -> String {
        let previousDay = Calendar.current.date(byAdding: .day, value: -1, to: referenceDate) ?? referenceDate
        return DailyIQService.apiDateString(previousDay)
    }

    func fetchHomeSnapshot() async throws -> HomeSnapshot {
        let userId = AuthService.shared.userId ?? ""
        let reportDate = Self.previousDayDailyIQDateString()

        async let holdingsTask = apiService.fetchPortfolioHoldings(userId: userId)
        async let briefTask = apiService.fetchDailyBrief(userId: userId, date: reportDate)
        async let mlbTask = apiService.fetchDailyTopMLBPlayers(date: reportDate)
        async let milbTask = apiService.fetchDailyTopMiLBPlayers(date: reportDate)

        let holdings = (try? await holdingsTask) ?? []
        let brief = (try? await briefTask)
        let mlbPlayers = (try? await mlbTask) ?? []
        let milbPlayers = (try? await milbTask) ?? []

        let liveValue = holdings.reduce(0) { $0 + $1.currentValue }
        let liveActions = holdings.filter { $0.profitLoss < 0 || $0.status.lowercased().contains("sell") }.count
        let liveWatchCount = (brief?.hotPlayers.count ?? 0) + mlbPlayers.prefix(3).count + milbPlayers.prefix(3).count
        let briefHighlights = brief?.portfolioHighlights ?? []
        let liveHighlights = briefHighlights.prefix(3).map { highlight in
            HighlightItem(
                title: highlight.playerName,
                detail: highlight.actionRationale,
                action: RecommendationAction(rawValue: highlight.action.capitalized) ?? .watch
            )
        }

        return HomeSnapshot(
            headline: holdings.isEmpty ? "No live holdings found yet." : "Your live portfolio is active.",
            summary: "Portfolio value \(liveValue.portfolioCurrencyText) with \(holdings.count) holdings and \(liveActions) actions.",
            recentAlertsCount: liveActions,
            watchlistMoversCount: liveWatchCount,
            portfolioActionCount: liveActions,
            syncStatus: brief?.date ?? reportDate,
            highlights: Array(liveHighlights),
            refreshMeta: RefreshMeta(
                lastUpdated: Date(),
                freshnessLabel: "Live",
                confidence: nil,
                note: "Fetched from backend"
            )
        )
    }

    func fetchWatchlist() async throws -> [WatchlistItem] {
        let liveItems = try await apiService.fetchDailyWatchlist(date: Self.previousDayDailyIQDateString())
        return liveItems.map { item in
            WatchlistItem(
                id: UUID(uuidString: item.id) ?? UUID(),
                name: item.playerName,
                subtitle: [item.team, item.level, item.position]
                    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { $0.isEmpty == false }
                    .joined(separator: " • "),
                type: .player,
                action: item.buySignal == true ? .buy : .watch,
                alertCount: item.played ? 1 : 0,
                refreshMeta: RefreshMeta(
                    lastUpdated: Date(),
                    freshnessLabel: item.played ? "Live" : "Queued",
                    confidence: nil,
                    note: item.noGameMessage ?? item.performanceNote
                )
            )
        }
    }

    func fetchAlerts() async throws -> [AlertItem] {
        let userId = AuthService.shared.userId ?? ""
        let reportDate = Self.previousDayDailyIQDateString()
        async let holdingsTask = apiService.fetchPortfolioHoldings(userId: userId)
        async let briefTask = apiService.fetchDailyBrief(userId: userId, date: reportDate)

        let holdings = (try? await holdingsTask) ?? []
        let brief = (try? await briefTask)

        let sellWatch = holdings
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .map { holding in
                AlertItem(
                    id: holding.id,
                    title: "\(holding.playerName) needs attention",
                    summary: holding.cardName,
                    detail: holding.actionabilityBullets.first ?? "Live backend data suggests this holding should be reviewed.",
                    severity: holding.profitLoss < 0 ? .risk : .caution,
                    category: .card,
                    actionLabel: holding.statusChipText,
                    triggeredAt: Date(),
                    confidence: holding.confidence.map { Int($0 * 100) },
                    significance: holding.summary,
                    changeSummary: holding.profitFormatted,
                    linkedPlayerQuery: holding.playerName,
                    linkedCardQuery: holding.cardName,
                    linkedPositionID: holding.id
                )
            }

        let briefHighlights = brief?.portfolioHighlights ?? []
        let dailyAlerts = briefHighlights.prefix(2).map { highlight in
            AlertItem(
                id: UUID(),
                title: highlight.playerName,
                summary: highlight.action,
                detail: highlight.actionRationale,
                severity: highlight.action.lowercased().contains("buy") ? .buy : .info,
                category: .player,
                actionLabel: highlight.action,
                triggeredAt: Date(),
                confidence: Int(highlight.confidence * 100),
                significance: highlight.inventoryImpact,
                changeSummary: highlight.cardImpact,
                linkedPlayerQuery: highlight.playerName,
                linkedCardQuery: nil,
                linkedPositionID: nil
            )
        }

        if sellWatch.isEmpty && dailyAlerts.isEmpty {
            return [
                AlertItem(
                    id: UUID(),
                    title: "Portfolio sync complete",
                    summary: holdings.isEmpty ? "No live alerts yet." : "\(holdings.count) active holdings",
                    detail: "The backend returned live data, but nothing crossed the alert threshold.",
                    severity: .info,
                    category: .portfolio,
                    actionLabel: nil,
                    triggeredAt: Date(),
                    confidence: nil,
                    significance: nil,
                    changeSummary: nil,
                    linkedPlayerQuery: nil,
                    linkedCardQuery: nil,
                    linkedPositionID: nil
                )
            ]
        }

        return Array(sellWatch + dailyAlerts)
    }

    func saveAlertPreferences(_ preferences: AlertPreferences) async throws -> AlertPreferences {
        let encoded = try JSONEncoder().encode(preferences)
        UserDefaults.standard.set(encoded, forKey: "hobbyiq.alert.preferences")
        return preferences
    }

    func fetchPortfolio() async throws -> PortfolioSummary {
        let userId = AuthService.shared.userId ?? ""
        let holdings = try await apiService.fetchPortfolioHoldings(userId: userId)

        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalPL = totalValue - totalCost
        let _ = totalCost > 0 ? (totalPL / totalCost) * 100 : 0
        let positions = holdings.map { card in
            PortfolioPosition(
                id: card.id,
                name: card.playerName,
                subtitle: [card.cardName, card.parallel]
                    .filter { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
                    .joined(separator: " • "),
                entityType: .card,
                quantity: card.quantity ?? 1,
                averageCost: card.cost,
                currentValuePerUnit: card.currentValue,
                action: card.profitLoss < 0 ? .watch : .hold,
                explanation: card.summary ?? card.actionabilityBullets.first ?? "Live portfolio position.",
                conviction: card.freshnessChipText,
                notes: card.notes ?? "",
                targets: PositionTargets(addTarget: nil, trimTarget: nil, sellTarget: nil, protectCapital: nil),
                catalyst: card.dailyTrendBadgeText ?? "Live signal",
                cautionReasons: card.actionabilityBullets,
                recentAlerts: [],
                refreshMeta: RefreshMeta(lastUpdated: Date(), freshnessLabel: card.freshnessChipText, confidence: nil, note: card.summary)
            )
        }

        return PortfolioSummary(
            estimatedValue: totalValue,
            costBasis: totalCost,
            unrealizedPnL: totalPL,
            actionCounts: [
                .buy: holdings.filter { $0.profitLoss > 0 }.count,
                .hold: holdings.filter { $0.status.lowercased().contains("hold") }.count,
                .trim: holdings.filter { $0.profitLoss < 0 }.count,
                .sell: holdings.filter { $0.status.lowercased().contains("sell") }.count,
                .watch: holdings.filter { $0.status.lowercased().contains("watch") }.count
            ],
            positions: positions,
            refreshMeta: RefreshMeta(lastUpdated: Date(), freshnessLabel: "Live", confidence: nil, note: "Backend portfolio summary")
        )
    }

    func fetchPerformance() async throws -> PerformanceSnapshot {
        let portfolio = try await fetchPortfolio()
        let base = portfolio.estimatedValue
        let series = (0..<7).map { index -> PerformancePoint in
            let delta = Double(index - 3) * 0.028
            return PerformancePoint(
                date: Calendar.current.date(byAdding: .day, value: index - 6, to: .now) ?? .now,
                value: base * (1 + delta)
            )
        }

        return PerformanceSnapshot(
            totalReturnPercent: portfolio.estimatedValue > 0 ? (portfolio.unrealizedPnL / portfolio.costBasis) * 100 : 0,
            benchmarkReturnPercent: nil,
            recommendationAccuracyPercent: nil,
            series: series,
            refreshMeta: RefreshMeta(lastUpdated: Date(), freshnessLabel: "Live", confidence: nil, note: "Derived from live portfolio data")
        )
    }

    func fetchIntegrations() async throws -> [IntegrationStatus] {
        let health = try await apiService.fetchHealth(servicePath: "/api/health")
        let names = ["CompIQ", "PlayerIQ", "DailyIQ", "PortfolioIQ"]

        return names.map { name in
            IntegrationStatus(
                providerName: name,
                configured: health.status == "ok",
                statusLabel: health.status?.capitalized ?? "Unknown",
                lastSync: Date(),
                note: health.message ?? "Live backend health check.",
                recentRuns: [
                    SyncRun(
                        title: "\(name) health",
                        status: health.status?.capitalized ?? "Unknown",
                        timestamp: Date(),
                        detail: health.message ?? "Live health check completed."
                    )
                ]
            )
        }
    }

    func requestManualSync(providerName: String) async throws -> IntegrationStatus {
        let health = try await apiService.fetchHealth(servicePath: "/api/health")
        return IntegrationStatus(
            providerName: providerName,
            configured: health.status == "ok",
            statusLabel: "Sync queued",
            lastSync: Date(),
            note: health.message ?? "Manual sync queued against live backend.",
            recentRuns: [
                SyncRun(
                    title: "Manual sync",
                    status: "Queued",
                    timestamp: Date(),
                    detail: "Triggered from iPhone"
                )
            ]
        )
    }

    func simulatedNetworkDelay() async throws {
        try await Task.sleep(for: .milliseconds(250))
    }
}

enum PreviewFixtures {
    static let refreshMeta = RefreshMeta(
        lastUpdated: Calendar.current.date(byAdding: .minute, value: -14, to: Date()),
        freshnessLabel: "Fresh",
        confidence: 82,
        note: "Snapshot confidence is based on last sync quality and market coverage."
    )

    static let homeSnapshot = HomeSnapshot(
        headline: "Action first, noise second",
        summary: "Three portfolio actions, two fresh watchlist breaks, and one trim alert are worth checking now.",
        recentAlertsCount: 4,
        watchlistMoversCount: 3,
        portfolioActionCount: 5,
        syncStatus: "eBay and PSA synced 14m ago",
        highlights: [
            HighlightItem(title: "Bonemer supply tightening", detail: "Blue Wave listings are down 12% over two weeks.", action: .buy),
            HighlightItem(title: "Roman Anthony trim zone", detail: "Premium copies are pushing into richer inventory depth.", action: .trim),
            HighlightItem(title: "Portfolio risk concentration", detail: "Your top three bats now represent 58% of modeled value.", action: .watch)
        ],
        refreshMeta: refreshMeta
    )

    static let watchlistItems: [WatchlistItem] = [
        WatchlistItem(id: UUID(), name: "Caleb Bonemer", subtitle: "Player market thesis intact", type: .player, action: .buy, alertCount: 2, refreshMeta: refreshMeta),
        WatchlistItem(id: UUID(), name: "2025 Bowman Chrome Blue Wave Auto", subtitle: "Card supply improving", type: .card, action: .buy, alertCount: 1, refreshMeta: refreshMeta),
        WatchlistItem(id: UUID(), name: "Roman Anthony", subtitle: "Trim into strength if another spike lands", type: .player, action: .trim, alertCount: 3, refreshMeta: refreshMeta)
    ]

    static let alertItems: [AlertItem] = [
        AlertItem(
            id: UUID(),
            title: "Caleb Bonemer buy window opened",
            summary: "Supply tightened while demand stayed firm across premium parallels.",
            detail: "Blue Wave and Refractor copies both saw lighter active listings over the last two weeks, while price support held. The setup remains constructive for disciplined adds under target.",
            severity: .buy,
            category: .player,
            actionLabel: "Add under $290",
            triggeredAt: Calendar.current.date(byAdding: .minute, value: -18, to: Date()) ?? Date(),
            confidence: 84,
            significance: "High",
            changeSummary: "Listings down 12%, fair value unchanged, liquidity stable.",
            linkedPlayerQuery: "Caleb Bonemer",
            linkedCardQuery: "2025 Bowman Chrome Blue Wave Auto",
            linkedPositionID: nil
        ),
        AlertItem(
            id: UUID(),
            title: "Roman Anthony entering trim zone",
            summary: "Fresh inventory is rising into a fully priced market.",
            detail: "The market still trusts the thesis, but more premium listings are hitting eBay and the risk-reward is shifting. Consider trimming if the next catalyst spikes price without tightening supply.",
            severity: .caution,
            category: .card,
            actionLabel: "Trim into strength",
            triggeredAt: Calendar.current.date(byAdding: .hour, value: -2, to: Date()) ?? Date(),
            confidence: 78,
            significance: "Medium",
            changeSummary: "Listings up 7%, confidence steady, demand broad but less scarce.",
            linkedPlayerQuery: "Roman Anthony",
            linkedCardQuery: "Roman Anthony PSA 10",
            linkedPositionID: nil
        ),
        AlertItem(
            id: UUID(),
            title: "Portfolio concentration risk",
            summary: "Exposure to bat-only profiles is drifting above your preferred band.",
            detail: "Your current mix now leans too heavily into hit-power bets without enough diversification across safer liquidity anchors. Rebalance before the next cold stretch compounds the risk.",
            severity: .risk,
            category: .portfolio,
            actionLabel: "Review position sizing",
            triggeredAt: Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date(),
            confidence: 75,
            significance: "High",
            changeSummary: "Top three positions now represent 58% of modeled value.",
            linkedPlayerQuery: nil,
            linkedCardQuery: nil,
            linkedPositionID: nil
        )
    ]

    static let alertPreferences = AlertPreferences(
        inAppEnabled: true,
        emailEnabled: false,
        pushEnabled: true,
        watchlistAlertsEnabled: true,
        portfolioAlertsEnabled: true,
        moverAlertsEnabled: true,
        minimumSeverity: .caution
    )

    static let portfolioPositions: [PortfolioPosition] = [
        PortfolioPosition(
            id: UUID(),
            name: "Caleb Bonemer",
            subtitle: "2025 Bowman Chrome Blue Wave Auto",
            entityType: .card,
            quantity: 2,
            averageCost: 240,
            currentValuePerUnit: 285,
            action: .buy,
            explanation: "Supply is tightening while demand remains disciplined enough to support adds under target.",
            conviction: "High",
            notes: "Best add candidate if the next batch of listings stays thin.",
            targets: PositionTargets(addTarget: 290, trimTarget: 390, sellTarget: 460, protectCapital: 230),
            catalyst: "Upper-level power confirmation",
            cautionReasons: ["Defensive home is still unsettled.", "Short-term hobby heat can overshoot fundamentals."],
            recentAlerts: [alertItems[0]],
            refreshMeta: refreshMeta
        ),
        PortfolioPosition(
            id: UUID(),
            name: "Roman Anthony",
            subtitle: "2024 Bowman Chrome PSA 10",
            entityType: .card,
            quantity: 1,
            averageCost: 520,
            currentValuePerUnit: 655,
            action: .trim,
            explanation: "Great asset, but fresh inventory is building into a market that already prices in a lot of the good story.",
            conviction: "High",
            notes: "Trim if another call-up spike creates a richer exit.",
            targets: PositionTargets(addTarget: nil, trimTarget: 680, sellTarget: 745, protectCapital: 500),
            catalyst: "MLB call-up timing",
            cautionReasons: ["Premium cards can re-rate quickly if hype cools.", "Supply is starting to expand."],
            recentAlerts: [alertItems[1]],
            refreshMeta: refreshMeta
        ),
        PortfolioPosition(
            id: UUID(),
            name: "Blake Burke",
            subtitle: "2024 Bowman Chrome Purple Auto",
            entityType: .card,
            quantity: 3,
            averageCost: 112,
            currentValuePerUnit: 106,
            action: .watch,
            explanation: "The profile still has real bat upside, but the market needs another catalyst before rewarding fresh aggression.",
            conviction: "Medium",
            notes: "Do not add unless the pricing cools or performance jumps.",
            targets: PositionTargets(addTarget: 95, trimTarget: 148, sellTarget: 176, protectCapital: 98),
            catalyst: "Power surge against upper-level pitching",
            cautionReasons: ["Bat-only profile narrows long-term outcomes.", "Listing depth is no longer shrinking."],
            recentAlerts: [],
            refreshMeta: refreshMeta
        )
    ]

    static let portfolioSummary = PortfolioSummary(
        estimatedValue: portfolioPositions.reduce(0) { $0 + $1.marketValue },
        costBasis: portfolioPositions.reduce(0) { $0 + $1.costBasis },
        unrealizedPnL: portfolioPositions.reduce(0) { $0 + $1.unrealizedPnL },
        actionCounts: [
            .buy: 1,
            .hold: 0,
            .trim: 1,
            .sell: 0,
            .watch: 1
        ],
        positions: portfolioPositions,
        refreshMeta: refreshMeta
    )

    static let performanceSnapshot = PerformanceSnapshot(
        totalReturnPercent: 18.4,
        benchmarkReturnPercent: 10.1,
        recommendationAccuracyPercent: 72.0,
        series: [
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -6, to: Date()) ?? Date(), value: 14820),
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -5, to: Date()) ?? Date(), value: 15110),
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -4, to: Date()) ?? Date(), value: 15320),
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -3, to: Date()) ?? Date(), value: 15640),
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -2, to: Date()) ?? Date(), value: 15950),
            PerformancePoint(date: Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date(), value: 16140),
            PerformancePoint(date: Date(), value: 16425)
        ],
        refreshMeta: refreshMeta
    )

    static let integrationStatuses: [IntegrationStatus] = [
        IntegrationStatus(
            providerName: "eBay",
            configured: true,
            statusLabel: "Healthy",
            lastSync: Calendar.current.date(byAdding: .minute, value: -14, to: Date()),
            note: "Listing depth, sold comps, and supply snapshots are flowing normally.",
            recentRuns: [
                SyncRun(title: "Scheduled sync", status: "Completed", timestamp: Calendar.current.date(byAdding: .minute, value: -14, to: Date()) ?? Date(), detail: "1,240 listings reconciled"),
                SyncRun(title: "Watchlist refresh", status: "Completed", timestamp: Calendar.current.date(byAdding: .hour, value: -2, to: Date()) ?? Date(), detail: "8 tracked entities refreshed")
            ]
        ),
        IntegrationStatus(
            providerName: "PSA",
            configured: true,
            statusLabel: "Healthy",
            lastSync: Calendar.current.date(byAdding: .hour, value: -1, to: Date()),
            note: "Population, cert lookups, and grade context are current.",
            recentRuns: [
                SyncRun(title: "Population refresh", status: "Completed", timestamp: Calendar.current.date(byAdding: .hour, value: -1, to: Date()) ?? Date(), detail: "Population deltas updated"),
                SyncRun(title: "Cert verification", status: "Completed", timestamp: Calendar.current.date(byAdding: .hour, value: -5, to: Date()) ?? Date(), detail: "4 positions verified")
            ]
        ),
        IntegrationStatus(
            providerName: "Learning Engine",
            configured: false,
            statusLabel: "Awaiting production key",
            lastSync: nil,
            note: "The learning layer is scaffolded in the backend but this beta build is not exposing manual controls yet.",
            recentRuns: []
        )
    ]
}
