//
//  DashboardModels.swift
//  HobbyIQ
//

import Foundation

struct DashboardSnapshot: Codable {
    let userId: String
    let date: String
    let portfolio: DashboardPortfolio
    let metrics: DashboardMetrics?
    let highlights: DashboardHighlights
    let watchFeed: [WatchFeedPlayer]
    let notifications: DashboardNotifications
}

struct DashboardPortfolio: Codable {
    let totalCost: Double
    let totalCurrentValue: Double
    let totalProfitLoss: Double
    let roi: Double
    let activeCount: Int
    let monthProfit: Double
    let yearProfit: Double
}

struct DashboardMetrics: Codable {
    let marketValue: Double
    let roi: Double
    let sevenDayChangeDollars: Double
    let valueIncreasePct: Double
    let cardsTracked: Int
    let iqScore: Double
    let iqGame: DashboardIQGame?
    let marketValueSeries: [Double]
    let sevenDayChangeSeries: [Double]
    let valueIncreasePctSeries: [Double]
    let iqScoreSeries: [Double]
}

struct DashboardIQGame: Codable {
    let rank: Int
    let totalPlayers: Int
    let percentile: Double
    let tier: String
    let badge: String
    let scoreBreakdown: DashboardIQScoreBreakdown
    let topInvestments: [DashboardIQInvestment]
    let leaderboard: [DashboardIQLeaderboardEntry]
}

struct DashboardIQScoreBreakdown: Codable {
    let unrealizedRoiScore: Double
    let realizedPerformanceScore: Double
    let consistencyScore: Double
    let convictionScore: Double
    let riskControlScore: Double
}

struct DashboardIQInvestment: Codable, Identifiable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String?
}

struct DashboardIQLeaderboardEntry: Codable, Identifiable {
    let userId: String
    let score: Double
    let roi: Double
    let cardsTracked: Int
    let tier: String

    var id: String { userId }
}

struct DashboardHighlights: Codable {
    let portfolioHighlights: [DashboardPortfolioHighlight]
    let buyTargets: [DashboardPortfolioHighlight]?
    let hotPlayers: [String]
}

struct DashboardPortfolioHighlight: Codable, Identifiable {
    let playerName: String
    let team: String
    let statLine: String
    let cardImpact: String
    let action: String
    let actionRationale: String
    let inventoryImpact: String

    var id: String { playerName }
}

struct WatchFeedPlayer: Codable, Identifiable {
    let playerName: String
    let team: String?
    let statLine: String?
    let trend: String?

    var id: String { playerName }
}

struct DashboardNotifications: Codable {
    let unreadCount: Int
    let recent: [DashboardNotificationItem]
}

struct DashboardNotificationItem: Codable, Identifiable {
    let rawId: String?
    let type: String
    let status: String
    let createdAt: String
    let data: DashboardNotificationData?

    var id: String {
        rawId ?? "\(type)|\(status)|\(createdAt)"
    }

    private enum CodingKeys: String, CodingKey {
        case rawId = "id"
        case type
        case status
        case createdAt
        case data
    }
}

struct DashboardNotificationData: Codable {
    let playerName: String?
    let cardName: String?
    let message: String?
    let action: String?
}

typealias AddCardRequest = AddInventoryCardRequest

struct AddCardResponse: Codable {
    let success: Bool?
    let message: String?
    let userId: String?
    let cardId: String?
    let card: InventoryCard?
    let inventoryCard: InventoryCard?
}

typealias DailyIQSummaryResponse = DailyIQResponse
typealias DailyIQSummaryHighlight = PortfolioHighlight
typealias DailyIQSummaryBuyTarget = BuyTarget
