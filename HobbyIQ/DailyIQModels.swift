//
//  DailyIQModels.swift
//  HobbyIQ
//

import SwiftUI
import Foundation

struct DailyPlayerStat: Codable, Identifiable, Hashable {
    let playerName: String
    let team: String
    let level: String
    let position: String
    let statLine: String
    let performanceNote: String
    let trend: String
    let hr: Int
    let hits: Int
    let rbi: Int
    let strikeouts: Int
    let era: Double?
    let isProspect: Bool
    let buySignal: Bool

    var id: String { "\(playerName)|\(team)|\(position)|\(statLine)" }
}

struct PortfolioHighlight: Codable, Identifiable, Hashable {
    let playerName: String
    let team: String
    let level: String
    let statLine: String
    let performanceNote: String
    let cardImpact: String
    let marketSignal: String
    let action: String
    let actionRationale: String
    let inventoryImpact: String
    let confidence: Double

    var id: String { "\(playerName)|\(team)|\(level)|\(action)" }
}

struct BuyTarget: Codable, Identifiable, Hashable {
    let playerName: String
    let team: String
    let level: String
    let position: String
    let statLine: String
    let reason: String
    let marketSignal: String
    let buyScore: Int
    let urgency: String
    let suggestedMaxBuy: String
    let confidence: Double

    var id: String { "\(playerName)|\(team)|\(position)|\(buyScore)" }
}

struct DailyIQResponse: Codable, Hashable {
    let date: String
    let portfolioHighlights: [PortfolioHighlight]
    let buyTargets: [BuyTarget]
    let topMLB: [DailyPlayerStat]
    let topMiLB: [DailyPlayerStat]
    let hotPlayers: [String]
}

struct WatchPlayerResult: Codable, Identifiable, Hashable {
    let playerName: String
    let lastGameDate: String?
    let statLine: String?
    let played: Bool
    let noGameMessage: String?
    let trend: String?
    let buySignal: Bool?
    let performanceNote: String?
    let team: String?
    let position: String?
    let level: String?

    var id: String {
        "\(playerName)|\(team ?? "")|\(position ?? "")|\(lastGameDate ?? "")"
    }
}

enum TrendColor {
    static func color(for trend: String) -> Color {
        switch trend.lowercased() {
        case "hot":
            return Color(hex: 0xEF4444)
        case "up":
            return Color(hex: 0x22C55E)
        case "flat":
            return Color(hex: 0x9CA3AF)
        case "down":
            return Color(hex: 0xF59E0B)
        case "cold":
            return Color(hex: 0x3B82F6)
        default:
            return Color(hex: 0x9CA3AF)
        }
    }
}

enum ImpactColor {
    static func color(for impact: String) -> Color {
        switch impact.lowercased() {
        case "hot":
            return Color(hex: 0xEF4444)
        case "rising":
            return Color(hex: 0x22C55E)
        case "neutral":
            return Color(hex: 0x9CA3AF)
        case "cooling":
            return Color(hex: 0xF59E0B)
        default:
            return Color(hex: 0x9CA3AF)
        }
    }
}

enum UrgencyColor {
    static func color(for urgency: String) -> Color {
        switch urgency.lowercased() {
        case "act today":
            return Color(hex: 0xEF4444)
        case "watch this week":
            return Color(hex: 0xF59E0B)
        case "monitor":
            return Color(hex: 0x9CA3AF)
        default:
            return Color(hex: 0x9CA3AF)
        }
    }
}
