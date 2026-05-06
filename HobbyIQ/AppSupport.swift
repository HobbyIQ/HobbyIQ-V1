//
//  AppSupport.swift
//  HobbyIQ
//

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
    @Published var selectedTab: AppTab = .home
    @Published var pendingRoute: AppRoute?

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

    private let apiClient = APIClient.shared

    func fetchHomeSnapshot() async throws -> HomeSnapshot {
        try await simulatedNetworkDelay()
        return PreviewFixtures.homeSnapshot
    }

    func fetchWatchlist() async throws -> [WatchlistItem] {
        try await simulatedNetworkDelay()

        if APIConfig.preferLiveData {
            do {
                let response: WatchlistDTO = try await apiClient.get(path: "/api/watchlist")
                return response.items ?? PreviewFixtures.watchlistItems
            } catch {
                guard APIConfig.fallbackToMockData else { throw error }
            }
        }

        return PreviewFixtures.watchlistItems
    }

    func fetchAlerts() async throws -> [AlertItem] {
        try await simulatedNetworkDelay()

        if APIConfig.preferLiveData {
            do {
                let response: AlertInboxDTO = try await apiClient.get(path: "/api/alerts")
                return response.items ?? PreviewFixtures.alertItems
            } catch {
                guard APIConfig.fallbackToMockData else { throw error }
            }
        }

        return PreviewFixtures.alertItems
    }

    func saveAlertPreferences(_ preferences: AlertPreferences) async throws -> AlertPreferences {
        try await simulatedNetworkDelay()
        return preferences
    }

    func fetchPortfolio() async throws -> PortfolioSummary {
        try await simulatedNetworkDelay()
        return PreviewFixtures.portfolioSummary
    }

    func fetchPerformance() async throws -> PerformanceSnapshot {
        try await simulatedNetworkDelay()
        return PreviewFixtures.performanceSnapshot
    }

    func fetchIntegrations() async throws -> [IntegrationStatus] {
        try await simulatedNetworkDelay()
        return PreviewFixtures.integrationStatuses
    }

    func requestManualSync(providerName: String) async throws -> IntegrationStatus {
        try await simulatedNetworkDelay()
        let fallback = PreviewFixtures.integrationStatuses.first {
            $0.providerName == providerName
        } ?? PreviewFixtures.integrationStatuses[0]

        return IntegrationStatus(
            providerName: fallback.providerName,
            configured: fallback.configured,
            statusLabel: "Sync queued",
            lastSync: Date(),
            note: "Manual sync started. Freshness should update after the provider run completes.",
            recentRuns: [
                SyncRun(
                    title: "Manual sync",
                    status: "Queued",
                    timestamp: Date(),
                    detail: "Triggered from iPhone"
                )
            ] + fallback.recentRuns
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
