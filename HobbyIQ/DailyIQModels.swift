//
//  DailyIQModels.swift
//  HobbyIQ
//

import SwiftUI
import Foundation

/// Sell signal derived client-side from DailyIQ movement + score.
/// Adjustable thresholds — see DailySellSignalThresholds below.
public enum DailySellSignal: String, Codable, Hashable {
    case hot       // movement up + dailyScore >= hotMinScore
    case window    // movement up + dailyScore >= windowMinScore but < hotMinScore
    case hold      // movement down
    case neutral   // no strong signal / missing data
}

/// TUNABLE: review after first week of real production data.
/// To adjust the sell-signal trigger points, edit these constants.
enum DailySellSignalThresholds {
    /// TUNABLE — minimum dailyScore for .hot signal when movement is "up"
    static let hotMinScore: Double = 60.0
    /// TUNABLE — minimum dailyScore for .window signal when movement is "up"
    static let windowMinScore: Double = 40.0
}

func deriveSellSignal(direction: String?, dailyScore: Double?) -> DailySellSignal {
    guard let dir = direction?.lowercased() else { return .neutral }
    if dir == "down" { return .hold }
    if dir != "up" { return .neutral }
    let score = dailyScore ?? 0
    if score >= DailySellSignalThresholds.hotMinScore { return .hot }
    if score >= DailySellSignalThresholds.windowMinScore { return .window }
    return .neutral
}

struct DailyPlayerStat: Codable, Identifiable, Hashable {
    let playerId: String
    let rank: Int
    let rankingScore: Double
    let league: String
    let playerName: String
    let team: String
    let teamName: String
    let teamAbbreviation: String
    let level: String
    let position: String
    let gameDate: String
    let opponent: String
    let atBats: Int
    let runs: Int
    let statLine: String
    let performanceNote: String
    let trend: String
    let hr: Int
    let hits: Int
    let rbi: Int
    let rbis: Int
    let walks: Int
    let strikeouts: Int
    let stolenBases: Int
    let battingAverage: String
    let ops: String
    let dailyStatsStatus: String
    let gamesPlayed: Int
    let seasonAtBats: Int
    let seasonRuns: Int
    let seasonHits: Int
    let seasonHomeRuns: Int
    let seasonRbi: Int
    let seasonWalks: Int
    let seasonStrikeouts: Int
    let seasonStolenBases: Int
    let seasonBattingAverage: String
    let onBasePercentage: String
    let sluggingPercentage: String
    let seasonOps: String
    let obp: String
    let slg: String
    let lastUpdated: String
    let era: Double?
    let pitchingInningsPitched: String?
    let pitchingEarnedRuns: Int?
    let pitchingHitsAllowed: Int?
    let pitchingWalksAllowed: Int?
    let pitchingStrikeouts: Int?
    let isProspect: Bool
    let buySignal: Bool
    let isOnWatchlist: Bool
    // New fields from production response
    let fantasyPoints: Int?
    let dailyScore: Double?
    let playerIQScore: Int?
    let playerIQDirection: String?
    let playerIQLabel: String?
    let movementDirection: String?
    let movementLabel: String?
    let movementReason: String?
    let sellSignal: DailySellSignal

    var id: String { "\(playerId)|\(playerName)|\(team)|\(position)|\(gameDate)" }
}

extension DailyPlayerStat {
    enum RoleKind {
        case hitter
        case pitcher
    }

    var identityLine: String {
        "\(team) • \(level) • \(position)"
    }

    var roleKind: RoleKind {
        let upper = position.uppercased()
        if upper.hasPrefix("SP")
            || upper.hasPrefix("RP")
            || upper.hasPrefix("P")
            || upper.contains("PITCH") {
            return .pitcher
        }
        return .hitter
    }

    var roleBadgeText: String {
        roleKind == .pitcher ? "PITCHER" : "HITTER"
    }

    var todayLine: String {
        statLine
    }

    var seasonLine: String {
        performanceNote.isEmpty ? "Season context unavailable" : performanceNote
    }

    var trendBadgeText: String {
        trend.isEmpty ? "WATCH" : trend.uppercased()
    }

    var watchActionTitle: String {
        buySignal ? "Watching" : "Watch"
    }

    var primaryStatsTitle: String {
        roleKind == .pitcher ? "Pitching Stats" : "Daily Stats"
    }

    var primaryStatsLine: String {
        roleKind == .pitcher ? pitchingStatsInlineLine : dailyStatsInlineLine
    }

    var primaryStatChips: [String] {
        roleKind == .pitcher ? pitchingStatChips : dailyStatChips
    }

    var dailyStatsInlineLine: String {
        [
            "Date \(gameDate)",
            "Opp \(opponent)",
            "AB \(atBats)",
            "R \(runs)",
            "H \(hits)",
            hr > 0 ? "HR \(hr)" : nil,
            "RBI \(rbi)",
            rbis > 0 ? "RBIS \(rbis)" : nil,
            "BB \(walks)",
            "SO \(strikeouts)",
            "SB \(stolenBases)",
        ].compactMap { $0 }.joined(separator: " • ")
    }

    var pitchingStatsInlineLine: String {
        var parts: [String] = []

        parts.append("Date \(gameDate)")
        parts.append("Opp \(opponent)")

        if let pitchingInningsPitched, pitchingInningsPitched.isEmpty == false {
            parts.append("IP \(pitchingInningsPitched)")
        }
        if let pitchingEarnedRuns {
            parts.append("ER \(pitchingEarnedRuns)")
        }
        if let era {
            parts.append(String(format: "ERA %.2f", era))
        }
        if let pitchingStrikeouts {
            parts.append("K \(pitchingStrikeouts)")
        }
        if let pitchingWalksAllowed {
            parts.append("BB \(pitchingWalksAllowed)")
        }
        if let pitchingHitsAllowed {
            parts.append("H \(pitchingHitsAllowed)")
        }

        return parts.isEmpty ? dailyStatsInlineLine : parts.joined(separator: " • ")
    }

    var dailyStatChips: [String] {
        [
            "AB \(atBats)",
            "R \(runs)",
            "H \(hits)",
            hr > 0 ? "HR \(hr)" : nil,
            "RBI \(rbi)",
            "BB \(walks)",
            "SO \(strikeouts)",
            "SB \(stolenBases)",
        ].compactMap { $0 }
    }

    var pitchingStatChips: [String] {
        [
            pitchingInningsPitched.map { "IP \($0)" },
            pitchingEarnedRuns.map { "ER \($0)" },
            era.map { String(format: "ERA %.2f", $0) },
            pitchingStrikeouts.map { "K \($0)" },
            pitchingWalksAllowed.map { "BB \($0)" },
            pitchingHitsAllowed.map { "H \($0)" },
        ].compactMap { $0 }
    }

    var seasonStatChips: [String] {
        if roleKind == .pitcher {
            return [
                era.map { String(format: "ERA %.2f", $0) },
                pitchingInningsPitched.map { "IP \($0)" },
                pitchingEarnedRuns.map { "ER \($0)" },
                pitchingHitsAllowed.map { "H \($0)" },
                pitchingWalksAllowed.map { "BB \($0)" },
                pitchingStrikeouts.map { "SO \($0)" },
                "G \(gamesPlayed)",
            ].compactMap { $0 }
        }
        return [
            "AVG \(seasonBattingAverage)",
            "OBP \(onBasePercentage)",
            "SLG \(sluggingPercentage)",
            "OPS \(seasonOps)",
            seasonHomeRuns > 0 ? "HR \(seasonHomeRuns)" : nil,
            "RBI \(seasonRbi)",
            "SB \(seasonStolenBases)",
            "R \(seasonRuns)",
            "AB \(seasonAtBats)",
            "H \(seasonHits)",
            "BB \(seasonWalks)",
            "SO \(seasonStrikeouts)",
            "G \(gamesPlayed)",
        ].compactMap { $0 }
    }

    var flagChips: [String] {
        [
            trend.isEmpty ? nil : "Trend \(trend.uppercased())",
            buySignal ? "Buy Signal" : "No Buy",
            isProspect ? "Prospect" : "Veteran",
            isOnWatchlist ? "Watchlisted" : "Not Watched"
        ].compactMap { $0 }
    }

    // MARK: - Natural-language stat summaries

    /// e.g. "2-for-4, HR, 3 RBI, SB"  or  "5.0 IP, 9 K, 1 ER"
    var headlineStatLine: String {
        roleKind == .pitcher ? pitchingHeadline : hittingHeadline
    }

    private var hittingHeadline: String {
        var parts: [String] = ["\(hits)-for-\(atBats)"]
        if hr > 0 { parts.append(hr == 1 ? "HR" : "\(hr) HR") }
        if rbi > 0 { parts.append("\(rbi) RBI") }
        if runs > 0 { parts.append("\(runs) R") }
        if stolenBases > 0 { parts.append(stolenBases == 1 ? "SB" : "\(stolenBases) SB") }
        if walks > 0 { parts.append("\(walks) BB") }
        return parts.joined(separator: ", ")
    }

    private var pitchingHeadline: String {
        var parts: [String] = []
        if let ip = pitchingInningsPitched, !ip.isEmpty { parts.append("\(ip) IP") }
        if let k = pitchingStrikeouts { parts.append("\(k) K") }
        if let er = pitchingEarnedRuns { parts.append("\(er) ER") }
        if let bb = pitchingWalksAllowed, bb > 0 { parts.append("\(bb) BB") }
        if let h = pitchingHitsAllowed { parts.append("\(h) H") }
        return parts.isEmpty ? hittingHeadline : parts.joined(separator: ", ")
    }

    /// e.g. ".312 / .891 OPS / 8 HR" or "2.45 ERA / 48 K / 38.1 IP"
    var seasonContextLine: String {
        roleKind == .pitcher ? pitchingSeasonContext : hittingSeasonContext
    }

    private var hittingSeasonContext: String {
        var parts: [String] = []
        if !seasonBattingAverage.isEmpty { parts.append(seasonBattingAverage) }
        if !seasonOps.isEmpty { parts.append("\(seasonOps) OPS") }
        if seasonHomeRuns > 0 { parts.append("\(seasonHomeRuns) HR") }
        if seasonStolenBases > 0 { parts.append("\(seasonStolenBases) SB") }
        parts.append("\(gamesPlayed) G")
        return parts.joined(separator: "  /  ")
    }

    private var pitchingSeasonContext: String {
        var parts: [String] = []
        if let e = era { parts.append(String(format: "%.2f ERA", e)) }
        if let k = pitchingStrikeouts { parts.append("\(k) K") }
        if let ip = pitchingInningsPitched, !ip.isEmpty { parts.append("\(ip) IP") }
        parts.append("\(gamesPlayed) G")
        return parts.joined(separator: "  /  ")
    }

    /// Highlight badges — only the "loud" stats that deserve colored emphasis
    var highlightBadges: [(label: String, color: StatBadgeColor)] {
        var badges: [(String, StatBadgeColor)] = []
        if roleKind == .hitter {
            if hr > 0 { badges.append(("\(hr) HR", .hot)) }
            if stolenBases > 0 { badges.append(("\(stolenBases) SB", .speed)) }
            if hits >= 3 { badges.append(("Multi-Hit", .good)) }
            if rbi >= 3 { badges.append(("\(rbi) RBI", .good)) }
        } else {
            if let k = pitchingStrikeouts, k >= 8 { badges.append(("\(k) K", .hot)) }
            if let er = pitchingEarnedRuns, er == 0 { badges.append(("Scoreless", .good)) }
        }
        return badges
    }
}

enum StatBadgeColor {
    case hot    // HR, high-K
    case speed  // SB
    case good   // multi-hit, RBI, scoreless

    var foreground: Color {
        switch self {
        case .hot: return Color(hex: 0xFEF3C7)
        case .speed: return Color(hex: 0xDBEAFE)
        case .good: return Color(hex: 0xD1FAE5)
        }
    }

    var background: Color {
        switch self {
        case .hot: return Color(hex: 0xF59E0B).opacity(0.25)
        case .speed: return Color(hex: 0x3B82F6).opacity(0.25)
        case .good: return Color(hex: 0x22C55E).opacity(0.25)
        }
    }

    var border: Color {
        switch self {
        case .hot: return Color(hex: 0xF59E0B).opacity(0.4)
        case .speed: return Color(hex: 0x3B82F6).opacity(0.4)
        case .good: return Color(hex: 0x22C55E).opacity(0.4)
        }
    }
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
    let byLevel: [String: [DailyPlayerStat]]?
}

struct WatchPlayerResult: Codable, Identifiable, Hashable {
    let playerId: String
    let rank: Int
    let rankingScore: Double
    let league: String
    let playerName: String
    let teamName: String
    let teamAbbreviation: String
    let lastGameDate: String?
    let gameDate: String
    let opponent: String
    let atBats: Int
    let runs: Int
    let hits: Int
    let homeRuns: Int
    let rbi: Int
    let rbis: Int
    let walks: Int
    let strikeouts: Int
    let stolenBases: Int
    let battingAverage: String
    let ops: String
    let dailyStatsStatus: String
    let gamesPlayed: Int
    let seasonAtBats: Int
    let seasonRuns: Int
    let seasonHits: Int
    let seasonHomeRuns: Int
    let seasonRbi: Int
    let seasonWalks: Int
    let seasonStrikeouts: Int
    let seasonStolenBases: Int
    let seasonBattingAverage: String
    let onBasePercentage: String
    let sluggingPercentage: String
    let seasonOps: String
    let obp: String
    let slg: String
    let statLine: String?
    let played: Bool
    let noGameMessage: String?
    let trend: String?
    let buySignal: Bool?
    let performanceNote: String?
    let team: String?
    let position: String?
    let level: String?
    let lastUpdated: String
    let era: Double?
    let pitchingInningsPitched: String?
    let pitchingEarnedRuns: Int?
    let pitchingHitsAllowed: Int?
    let pitchingWalksAllowed: Int?
    let pitchingStrikeouts: Int?
    let isOnWatchlist: Bool
    // New fields from production response
    let fantasyPoints: Int?
    let dailyScore: Double?
    let playerIQScore: Int?
    let playerIQDirection: String?
    let playerIQLabel: String?
    let movementDirection: String?
    let movementLabel: String?
    let movementReason: String?
    let sellSignal: DailySellSignal

    var id: String {
        "\(playerId)|\(playerName)|\(team ?? "")|\(position ?? "")|\(lastGameDate ?? "")"
    }
}

extension WatchPlayerResult {
    enum RoleKind {
        case hitter
        case pitcher
    }

    var identityLine: String {
        [teamName, level, position].compactMap { $0 }.joined(separator: " • ")
    }

    var roleKind: RoleKind {
        let upper = (position ?? "").uppercased()
        if upper.hasPrefix("SP")
            || upper.hasPrefix("RP")
            || upper.hasPrefix("P")
            || upper.contains("PITCH") {
            return .pitcher
        }
        return .hitter
    }

    var roleBadgeText: String {
        roleKind == .pitcher ? "PITCHER" : "HITTER"
    }

    var primaryStatsTitle: String {
        roleKind == .pitcher ? "Pitching Stats" : "Daily Stats"
    }

    var primaryStatsLine: String {
        roleKind == .pitcher ? pitchingStatsInlineLine : dailyStatsInlineLine
    }

    var primaryStatChips: [String] {
        roleKind == .pitcher ? pitchingStatChips : dailyStatChips
    }

    var dailyStatsInlineLine: String {
        [
            "Opp \(opponent)",
            "AB \(atBats)",
            "R \(runs)",
            "H \(hits)",
            homeRuns > 0 ? "HR \(homeRuns)" : nil,
            "RBI \(rbi)",
            rbis > 0 ? "RBIS \(rbis)" : nil,
            "BB \(walks)",
            "SO \(strikeouts)",
            "SB \(stolenBases)",
            dailyStatsStatus.isEmpty ? nil : dailyStatsStatus,
        ].compactMap { $0 }.joined(separator: " • ")
    }

    var pitchingStatsInlineLine: String {
        var parts: [String] = []

        if let pitchingInningsPitched, pitchingInningsPitched.isEmpty == false {
            parts.append("IP \(pitchingInningsPitched)")
        }
        if let pitchingEarnedRuns {
            parts.append("ER \(pitchingEarnedRuns)")
        }
        if let pitchingStrikeouts {
            parts.append("K \(pitchingStrikeouts)")
        }
        if let pitchingWalksAllowed {
            parts.append("BB \(pitchingWalksAllowed)")
        }
        if let pitchingHitsAllowed {
            parts.append("H \(pitchingHitsAllowed)")
        }

        return parts.isEmpty ? dailyStatsInlineLine : parts.joined(separator: " • ")
    }

    var dailyStatChips: [String] {
        [
            "AB \(atBats)",
            "R \(runs)",
            "H \(hits)",
            homeRuns > 0 ? "HR \(homeRuns)" : nil,
            "RBI \(rbi)",
            "BB \(walks)",
            "SO \(strikeouts)",
            "SB \(stolenBases)",
            dailyStatsStatus.isEmpty ? nil : dailyStatsStatus,
        ].compactMap { $0 }
    }

    var pitchingStatChips: [String] {
        [
            pitchingInningsPitched.map { "IP \($0)" },
            pitchingEarnedRuns.map { "ER \($0)" },
            era.map { String(format: "ERA %.2f", $0) },
            pitchingStrikeouts.map { "K \($0)" },
            pitchingWalksAllowed.map { "BB \($0)" },
            pitchingHitsAllowed.map { "H \($0)" },
            dailyStatsStatus.isEmpty ? nil : dailyStatsStatus,
        ].compactMap { $0 }
    }

    var seasonStatChips: [String] {
        if roleKind == .pitcher {
            return [
                era.map { String(format: "ERA %.2f", $0) },
                pitchingInningsPitched.map { "IP \($0)" },
                pitchingEarnedRuns.map { "ER \($0)" },
                pitchingHitsAllowed.map { "H \($0)" },
                pitchingWalksAllowed.map { "BB \($0)" },
                pitchingStrikeouts.map { "SO \($0)" },
                "G \(gamesPlayed)",
            ].compactMap { $0 }
        }
        return [
            "AVG \(seasonBattingAverage)",
            "OBP \(onBasePercentage)",
            "SLG \(sluggingPercentage)",
            "OPS \(seasonOps)",
            seasonHomeRuns > 0 ? "HR \(seasonHomeRuns)" : nil,
            "RBI \(seasonRbi)",
            "SB \(seasonStolenBases)",
            "R \(seasonRuns)",
            "AB \(seasonAtBats)",
            "H \(seasonHits)",
            "BB \(seasonWalks)",
            "SO \(seasonStrikeouts)",
            "G \(gamesPlayed)",
        ].compactMap { $0 }
    }

    var flagChips: [String] {
        [
            trend.map { "Trend \($0.uppercased())" },
            buySignal == true ? "Buy Signal" : "No Buy",
            isOnWatchlist ? "Watchlisted" : "Not Watched"
        ].compactMap { $0 }
    }

    // MARK: - Natural-language summaries

    var headlineStatLine: String {
        roleKind == .pitcher ? pitchingHeadline : hittingHeadline
    }

    private var hittingHeadline: String {
        var parts: [String] = ["\(hits)-for-\(atBats)"]
        if homeRuns > 0 { parts.append(homeRuns == 1 ? "HR" : "\(homeRuns) HR") }
        if rbi > 0 { parts.append("\(rbi) RBI") }
        if runs > 0 { parts.append("\(runs) R") }
        if stolenBases > 0 { parts.append(stolenBases == 1 ? "SB" : "\(stolenBases) SB") }
        if walks > 0 { parts.append("\(walks) BB") }
        return parts.joined(separator: ", ")
    }

    private var pitchingHeadline: String {
        var parts: [String] = []
        if let ip = pitchingInningsPitched, !ip.isEmpty { parts.append("\(ip) IP") }
        if let k = pitchingStrikeouts { parts.append("\(k) K") }
        if let er = pitchingEarnedRuns { parts.append("\(er) ER") }
        if let bb = pitchingWalksAllowed, bb > 0 { parts.append("\(bb) BB") }
        if let h = pitchingHitsAllowed { parts.append("\(h) H") }
        return parts.isEmpty ? hittingHeadline : parts.joined(separator: ", ")
    }

    var seasonContextLine: String {
        roleKind == .pitcher ? pitchingSeasonContext : hittingSeasonContext
    }

    private var hittingSeasonContext: String {
        var parts: [String] = []
        if !seasonBattingAverage.isEmpty { parts.append(seasonBattingAverage) }
        if !seasonOps.isEmpty { parts.append("\(seasonOps) OPS") }
        if seasonHomeRuns > 0 { parts.append("\(seasonHomeRuns) HR") }
        if seasonStolenBases > 0 { parts.append("\(seasonStolenBases) SB") }
        parts.append("\(gamesPlayed) G")
        return parts.joined(separator: "  /  ")
    }

    private var pitchingSeasonContext: String {
        var parts: [String] = []
        if let e = era { parts.append(String(format: "%.2f ERA", e)) }
        if let k = pitchingStrikeouts { parts.append("\(k) K") }
        if let ip = pitchingInningsPitched, !ip.isEmpty { parts.append("\(ip) IP") }
        parts.append("\(gamesPlayed) G")
        return parts.joined(separator: "  /  ")
    }

    var highlightBadges: [(label: String, color: StatBadgeColor)] {
        var badges: [(String, StatBadgeColor)] = []
        if roleKind == .hitter {
            if homeRuns > 0 { badges.append(("\(homeRuns) HR", .hot)) }
            if stolenBases > 0 { badges.append(("\(stolenBases) SB", .speed)) }
            if hits >= 3 { badges.append(("Multi-Hit", .good)) }
            if rbi >= 3 { badges.append(("\(rbi) RBI", .good)) }
        } else {
            if let k = pitchingStrikeouts, k >= 8 { badges.append(("\(k) K", .hot)) }
            if let er = pitchingEarnedRuns, er == 0 { badges.append(("Scoreless", .good)) }
        }
        return badges
    }
}

struct DailyWatchlistEntry: Identifiable, Hashable {
    let id: UUID
    let playerId: String
    let playerName: String
    let teamLeague: String
    let teamName: String
    let teamAbbreviation: String
    let league: String
    let level: String
    let position: String
    let playerRank: Int
    let rankingScore: Double
    let lastGameDate: String?
    let gameDate: String
    let opponent: String
    let played: Bool
    let noGameMessage: String?
    let trend: String
    let buySignal: Bool
    let isOnWatchlist: Bool
    let dailyStats: String
    let dailyStatChips: [String]
    let seasonStats: String
    let seasonStatChips: [String]
    let flagChips: [String]
    let lastUpdated: String
    let dailyStatsStatus: String
    let pitchingInningsPitched: String?
    let pitchingEarnedRuns: Int?
    let pitchingHitsAllowed: Int?
    let pitchingWalksAllowed: Int?
    let pitchingStrikeouts: Int?
    let era: Double?
    let headlineStatLine: String
    let seasonContextLine: String

    init(
        id: UUID = UUID(),
        playerId: String = UUID().uuidString,
        playerName: String,
        teamLeague: String,
        teamName: String = "",
        teamAbbreviation: String = "",
        league: String = "",
        level: String = "",
        position: String = "",
        playerRank: Int = 0,
        rankingScore: Double = 0,
        lastGameDate: String? = nil,
        gameDate: String = "",
        opponent: String = "",
        played: Bool = true,
        noGameMessage: String? = nil,
        buySignal: Bool = false,
        isOnWatchlist: Bool = false,
        dailyStats: String,
        dailyStatChips: [String] = [],
        seasonStats: String,
        seasonStatChips: [String] = [],
        trend: String,
        flagChips: [String] = [],
        lastUpdated: String = "",
        dailyStatsStatus: String = "",
        pitchingInningsPitched: String? = nil,
        pitchingEarnedRuns: Int? = nil,
        pitchingHitsAllowed: Int? = nil,
        pitchingWalksAllowed: Int? = nil,
        pitchingStrikeouts: Int? = nil,
        era: Double? = nil,
        headlineStatLine: String = "",
        seasonContextLine: String = ""
    ) {
        self.id = id
        self.playerId = playerId
        self.playerName = playerName
        self.teamLeague = teamLeague
        self.teamName = teamName
        self.teamAbbreviation = teamAbbreviation
        self.league = league
        self.level = level
        self.position = position
        self.playerRank = playerRank
        self.rankingScore = rankingScore
        self.lastGameDate = lastGameDate
        self.gameDate = gameDate
        self.opponent = opponent
        self.played = played
        self.noGameMessage = noGameMessage
        self.buySignal = buySignal
        self.isOnWatchlist = isOnWatchlist
        self.dailyStats = dailyStats
        self.dailyStatChips = dailyStatChips
        self.seasonStats = seasonStats
        self.seasonStatChips = seasonStatChips
        self.trend = trend
        self.flagChips = flagChips
        self.lastUpdated = lastUpdated
        self.dailyStatsStatus = dailyStatsStatus
        self.pitchingInningsPitched = pitchingInningsPitched
        self.pitchingEarnedRuns = pitchingEarnedRuns
        self.pitchingHitsAllowed = pitchingHitsAllowed
        self.pitchingWalksAllowed = pitchingWalksAllowed
        self.pitchingStrikeouts = pitchingStrikeouts
        self.era = era
        self.headlineStatLine = headlineStatLine
        self.seasonContextLine = seasonContextLine
    }
}

extension DailyWatchlistEntry {
    enum RoleKind {
        case hitter
        case pitcher
    }

    var roleKind: RoleKind {
        let upper = position.uppercased()
        if upper.hasPrefix("SP")
            || upper.hasPrefix("RP")
            || upper.hasPrefix("P")
            || upper.contains("PITCH") {
            return .pitcher
        }
        return .hitter
    }

    var pitcherAwareStatsTitle: String {
        roleKind == .pitcher ? "Pitching Stats" : "Daily Stats"
    }

    var pitcherAwareStatChips: [String] {
        if roleKind == .pitcher {
            return [
                pitchingInningsPitched.map { "IP \($0)" },
                pitchingEarnedRuns.map { "ER \($0)" },
                era.map { String(format: "ERA %.2f", $0) },
                pitchingStrikeouts.map { "K \($0)" },
                pitchingWalksAllowed.map { "BB \($0)" },
                pitchingHitsAllowed.map { "H \($0)" }
            ].compactMap { $0 }
        }

        return dailyStatChips
    }

    init(result: WatchPlayerResult) {
        self.init(
            playerId: result.playerId,
            playerName: result.playerName,
            teamLeague: [result.teamName, result.level].compactMap { $0 }.joined(separator: " • "),
            teamName: result.teamName,
            teamAbbreviation: result.teamAbbreviation,
            league: result.league,
            level: result.level ?? "",
            position: result.position ?? "",
            playerRank: result.rank,
            rankingScore: result.rankingScore,
            lastGameDate: result.lastGameDate,
            gameDate: result.gameDate,
            opponent: result.opponent,
            played: result.played,
            noGameMessage: result.noGameMessage,
            buySignal: result.buySignal ?? false,
            isOnWatchlist: result.isOnWatchlist,
            dailyStats: result.primaryStatsLine,
            dailyStatChips: result.primaryStatChips,
            seasonStats: result.performanceNote ?? "Season stats unavailable",
            seasonStatChips: result.seasonStatChips,
            trend: result.trend ?? "WATCH",
            flagChips: result.flagChips,
            lastUpdated: result.lastUpdated,
            dailyStatsStatus: result.dailyStatsStatus,
            pitchingInningsPitched: result.pitchingInningsPitched,
            pitchingEarnedRuns: result.pitchingEarnedRuns,
            pitchingHitsAllowed: result.pitchingHitsAllowed,
            pitchingWalksAllowed: result.pitchingWalksAllowed,
            pitchingStrikeouts: result.pitchingStrikeouts,
            era: result.era,
            headlineStatLine: result.headlineStatLine,
            seasonContextLine: result.seasonContextLine
        )
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
