//
//  PlayerIQModels.swift
//  HobbyIQ
//

import Foundation

struct PlayerIQMetric: Identifiable, Codable, Hashable {
    var id = UUID()
    let name: String
    let score: Int
}

struct PlayerIQMarketMetric: Identifiable, Codable, Hashable {
    var id = UUID()
    let name: String
    let value: String
}

struct PlayerIQPromptRequest: Codable {
    let query: String
}

struct PlayerIQResponse: Codable, Hashable {
    let playerName: String?
    let mlbPlayerId: Int?
    let team: String?
    let position: String?
    let league: String?
    let level: String?

    let playerIQScore: Int?
    let playerIQLabel: String?
    let playerIQDirection: String?

    let market: PlayerIQMarket?
    let performance: PlayerIQPerformance?

    let updatedAt: String?
    let dataSource: String?
    let confidence: String?
}

struct PlayerIQMarket: Codable, Hashable {
    let marketScore: Int?
    let marketDirection: String?
    let avgTrendPct: Double?
    let totalSamples: Int?
    let cardCount: Int?
    let topCardName: String?
    let confidence: String?
}

struct PlayerIQPerformance: Codable, Hashable {
    let performanceScore: Int?
    let performanceDirection: String?
    let momentumRatio: Double?
    let statLine: String?
    let statGroup: String?
    let milestone: String?
    let confidence: String?
}

// MARK: - Player Stats API Models

struct PlayerDraftInfoDTO: Codable {
    let year: String?
    let round: String?
    let pickNumber: Int?
    let team: String?
    let school: String?
    let type: String?
}

struct PlayerStatsResponse: Codable {
    let playerName: String?
    let mlbPlayerId: Int?
    let fullName: String?
    let nickName: String?
    let position: String?
    let primaryNumber: String?
    let currentTeam: String?
    let currentTeamId: Int?
    let currentLevel: String?
    let bats: String?
    let throwsHand: String?
    let height: String?
    let weight: Int?
    let currentAge: Int?
    let active: Bool?
    let birthDate: String?
    let birthCity: String?
    let birthStateProvince: String?
    let birthCountry: String?
    let mlbDebutDate: String?
    let highSchool: String?
    let college: String?
    let draft: PlayerDraftInfoDTO?
    let hitting: PlayerStatCategory?
    let pitching: PlayerStatCategory?
    let status: String?
    let source: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case playerName, mlbPlayerId, fullName, nickName, position, primaryNumber
        case currentTeam, currentTeamId, currentLevel, bats
        case throwsHand = "throws"
        case height, weight, currentAge, active
        case birthDate, birthCity, birthStateProvince, birthCountry
        case mlbDebutDate, highSchool, college, draft
        case hitting, pitching, status, source, updatedAt
    }
}

struct PlayerStatCategory: Codable {
    let yearByYear: [PlayerSeasonStats]?
    let career: PlayerSeasonStatLine?
}

struct PlayerSeasonStats: Codable, Identifiable {
    var id: String {
        "\(season ?? "")-\(team ?? "")-\(level ?? "")"
    }
    let season: String?
    let team: String?
    let league: String?
    let level: String?
    let stats: PlayerSeasonStatLine?
}

struct PlayerSeasonStatLine: Codable {
    // Shared
    let gamesPlayed: Int?

    // Hitting
    let atBats: Int?
    let hits: Int?
    let homeRuns: Int?
    let rbi: Int?
    let stolenBases: Int?
    let avg: String?
    let obp: String?
    let slg: String?
    let ops: String?
    let runs: Int?
    let doubles: Int?
    let triples: Int?
    let baseOnBalls: Int?
    let strikeOuts: Int?
    let plateAppearances: Int?

    // Pitching
    let wins: Int?
    let losses: Int?
    let era: String?
    let gamesStarted: Int?
    let saves: Int?
    let inningsPitched: String?
    let whip: String?
}

