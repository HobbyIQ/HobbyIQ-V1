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
        if hasNoGameToday { return noGameMessage ?? "No game today" }
        return roleKind == .pitcher ? pitchingStatsInlineLine : dailyStatsInlineLine
    }

    var primaryStatChips: [String] {
        if hasNoGameToday { return [] }
        return roleKind == .pitcher ? pitchingStatChips : dailyStatChips
    }

    /// True when today's response carries no actual gameplay (off-day, no-game,
    /// or fresh-add zero-row). Lets the watchlist row show a clean "No game
    /// today" message instead of a meaningless "AB 0 • R 0 • H 0 • …" string.
    var hasNoGameToday: Bool {
        let status = dailyStatsStatus.lowercased()
        if status.contains("no-game") || status.contains("no game") { return true }
        if played == false { return true }
        // All counted stats zero AND opponent missing → backend off-day shape.
        let countedZero = atBats == 0 && runs == 0 && hits == 0 && homeRuns == 0
            && rbi == 0 && rbis == 0 && walks == 0 && strikeouts == 0 && stolenBases == 0
        return countedZero && opponent.isEmpty
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

// MARK: - Player Search Result (shared by watchlist/search and dailyiq/search)

struct PlayerSearchResult: Codable, Identifiable, Hashable {
    var id: String { "\(mlbPersonId)_\(playerName)" }
    let mlbPersonId: Int
    let playerName: String
    let position: String?
    let positionName: String?
    let teamId: Int?
    let teamName: String?
    let jersey: String?
    let active: Bool?
}

// MARK: - Watchlist Search / Top / Suggest

struct WatchlistSearchResponse: Codable {
    let query: String?
    let count: Int?
    let results: [PlayerSearchResult]?
}

struct WatchlistTopResponse: Codable {
    let entries: [WatchPlayerResult]?
    let count: Int?

    // Backend dailyiq.routes.ts `/watchlist/top` emits `players`, not `entries`.
    private enum CodingKeys: String, CodingKey {
        case entries = "players"
        case count
    }
}

// Mirrors the backend dailyiq.routes.ts `/watchlist/suggest` item shape
// (playerId, playerName, league, level, teamName, teamAbbreviation, position).
// `playerName` is required because every UI surface labels by it; everything
// else is optional to tolerate partial records.
struct WatchlistSuggestion: Codable, Identifiable, Hashable {
    let playerId: String?
    let playerName: String
    let league: String?
    let level: String?
    let teamName: String?
    let teamAbbreviation: String?
    let position: String?

    var id: String { playerId ?? playerName }
}

struct WatchlistSuggestResponse: Codable {
    let suggestions: [WatchlistSuggestion]?
}

// MARK: - DailyIQ Search

struct DailyIQSearchResponse: Codable {
    let query: String?
    let count: Int?
    let results: [PlayerSearchResult]?
}

// MARK: - Dashboard Player Stats (gated dailyIQBriefs / investor+)

struct DashboardPlayerStatsResponse: Codable {
    let dashboardDate: String?
    let lastUpdated: String?
    let mlbTopPlayers: [DailyPlayerStat]?
    let milbTopPlayers: [DailyPlayerStat]?
    let watchlistPlayers: [DailyPlayerStat]?
}

// MARK: - Full Brief (gated dailyIQBriefs / investor+)

struct DailyBriefMeta: Codable, Hashable {
    let generatedAt: String?
    let dataFreshness: String?
    let coverageNote: String?
}

struct DailyBriefMover: Codable, Identifiable, Hashable {
    var id: String { "\(playerName)_\(direction ?? "")_\(team ?? "")" }
    let playerName: String
    let team: String?
    let level: String?
    let direction: String?
    let pctChange: Double?
    let reason: String?
}

struct DailyIQFullBriefResponse: Codable {
    let date: String?
    let portfolioHighlights: [PortfolioHighlight]?
    let buyTargets: [BuyTarget]?
    let topMLB: [DailyPlayerStat]?
    let topMiLB: [DailyPlayerStat]?
    let hotPlayers: [String]?
    let risers: [DailyBriefMover]?
    let fallers: [DailyBriefMover]?
    let breakouts: [DailyBriefMover]?
    let watchlist: [WatchPlayerResult]?
    let meta: DailyBriefMeta?

    enum CodingKeys: String, CodingKey {
        case date, portfolioHighlights, buyTargets, topMLB, topMiLB, hotPlayers
        case risers, fallers, breakouts, watchlist
        case meta = "_meta"
    }
}

// MARK: - CF-DAILYIQ-MARKET-PLAYERS (2026-07-01) — matched-cohort momentum lists

/// Response envelope for GET /api/dailyiq/market/players. Backend cache
/// TTL is 26h so iOS can safely cache the response for ~1h without
/// re-fetching. `generatedAt == nil` means the background job hasn't
/// populated yet — render the empty state; do NOT retry aggressively.
/// Investor-tier gated via the same `dailyIQBriefs` entitlement as the
/// full brief.
struct DailyIQMarketSignalsResponse: Codable {
    let success: Bool?
    /// ISO8601 timestamp of the last job cycle. `nil` before the first
    /// populated cycle — pair with the empty-state UI.
    let generatedAt: String?
    /// Optional server-supplied empty-state copy. iOS falls back to a
    /// canned string when this is absent.
    let note: String?
    let trending: [DailyIQMarketPlayerEntry]?
    let fading: [DailyIQMarketPlayerEntry]?
    let topVolume30d: [DailyIQMarketVolumeEntry]?
    let supplyDryLeadingUp: [DailyIQMarketSupplyEntry]?

    /// CF-BOWMAN-2YR-LISTS (2026-07-02, PR #247): Bowman-set subset of
    /// the matched-cohort universe restricted to the last two years.
    /// Fills after the matched-cohort widening cycle (PR #248) warms.
    /// Nil/empty before the first populated cycle — treat like the
    /// other list fields (empty → "Populating on next cycle").
    let bowman2yrTopVolume30d: [DailyIQMarketVolumeEntry]?
    let bowman2yrTopMomentum: [DailyIQMarketPlayerEntry]?
}

/// Shared shape for `trending` + `fading`. `medianRatio` is a raw ratio
/// centered on 1.0 (>1 = up, <1 = down). Convert to a signed percent
/// via `(medianRatio - 1) * 100` at render time.
struct DailyIQMarketPlayerEntry: Codable, Identifiable, Hashable {
    let player: String
    let medianRatio: Double?
    let cohortSize: Int?
    let latestWeekActiveCards: Int?
    let latestWeekStart: String?
    let computedAtMs: Double?

    var id: String { player }
}

/// 30-day trailing volume list. Sales count is the raw integer from
/// the matched-cohort snapshot.
struct DailyIQMarketVolumeEntry: Codable, Identifiable, Hashable {
    let player: String
    let totalSales30d: Int?

    var id: String { player }
}

/// Leading indicator: rising median price + falling listings.
/// `volumeRatio < 1.0` means supply is drying up (fewer listings vs
/// prior window). Distinct from `trending` which is lagging.
struct DailyIQMarketSupplyEntry: Codable, Identifiable, Hashable {
    let player: String
    let medianRatio: Double?
    let volumeRatio: Double?
    let cohortSize: Int?
    let latestWeekActiveCards: Int?

    var id: String { player }
}

// MARK: - CF-DAILYIQ-MY-PLAYERS (2026-07-01) — personal matched-cohort momentum

/// Response envelope for GET /api/dailyiq/market/my-players. Rows are
/// pre-sorted DESC by holdingCount so the user's most-invested players
/// lead. Investor-tier gated via `dailyIQBriefs`. Empty myPlayers → the
/// user has no priced holdings yet, or backend job hasn't matched them
/// to a cohort yet.
struct DailyIQMyPlayersResponse: Codable {
    let success: Bool?
    let generatedAt: String?
    let myPlayers: [DailyIQMyPlayerEntry]?
}

/// One player the user has holdings for. `matchedCohort` is nil until
/// the backend job cycles through this player (first-day production
/// state); the fallback `momentumRatio` / `supplyTrend` fields still
/// let iOS render a soft trend badge in that window.
struct DailyIQMyPlayerEntry: Codable, Identifiable, Hashable {
    let player: String
    let holdingCount: Int?
    /// Pre-sorted DESC by ratio (best-trending owned card leads).
    let ownedCardsInCohort: [DailyIQOwnedCardInCohort]?
    let matchedCohort: DailyIQMatchedCohort?
    /// One of `demand_growth`, `supply_dry`, `supply_flood`,
    /// `demand_crash`, `flat`. Used for a small qualitative chip when
    /// numeric ratios aren't yet available.
    let supplyTrend: String?
    /// Fallback momentum signal — used when matchedCohort is nil.
    let momentumRatio: Double?
    let volumeRatio: Double?
    let totalSales30d: Int?
    let providerName: String?
    let capturedAtMs: Double?

    var id: String { player }
}

/// Per-owned-card cohort membership. Ratio > 1.0 = the user's specific
/// card is up week-over-week within the matched cohort. `cardId` maps
/// to a local InventoryCard when the user still holds it — iOS can
/// resolve display titles via `LocalPortfolioProvider.shared`.
struct DailyIQOwnedCardInCohort: Codable, Identifiable, Hashable {
    let cardId: String
    let ratio: Double?
    let quantity: Int?
    let latestWeekMedianPrice: Double?
    let priorWindowMedianPrice: Double?
    let latestWeekSaleCount: Int?
    let priorWindowSaleCount: Int?

    var id: String { cardId }
}

/// Aggregated matched-cohort statistics powering the player-level "+36%"
/// badge on the myPlayers row. Nil until backend job cycles through the
/// player.
struct DailyIQMatchedCohort: Codable, Hashable {
    let medianRatio: Double?
    let meanRatio: Double?
    let cohortSize: Int?
    let latestWeekActiveCards: Int?
    let latestWeekStart: String?
    let priorWindowWeeksCount: Int?
    let computedAtMs: Double?
}
