//
//  PlayerIQModels.swift
//  HobbyIQ
//

import Foundation

struct PlayerIQResponse {
    let playerName: String
    let organization: String
    let position: String
    let level: String
    let summary: String
    let overallScore: Int
    let tier: String
    let investmentTake: String
    let talentBreakdown: [PlayerIQMetric]
    let marketBreakdown: [PlayerIQMarketMetric]
    let riskFactors: [String]
    let followUpPrompts: [String]

    static let mock = PlayerIQResponse(
        playerName: "Caleb Bonemer",
        organization: "Chicago White Sox",
        position: "SS / 3B",
        level: "High-A",
        summary: "Bonemer profiles as a high-upside bat-first infield prospect with improving impact quality and a card market that still has room to re-rate if the hit tool holds.",
        overallScore: 84,
        tier: "Strong",
        investmentTake: "Accumulation candidate before broad hobby consensus fully catches up.",
        talentBreakdown: [
            PlayerIQMetric(name: "Hit", score: 78),
            PlayerIQMetric(name: "Power", score: 74),
            PlayerIQMetric(name: "Speed", score: 61),
            PlayerIQMetric(name: "Fielding", score: 58),
            PlayerIQMetric(name: "Arm", score: 66)
        ],
        marketBreakdown: [
            PlayerIQMarketMetric(name: "Demand", value: "High"),
            PlayerIQMarketMetric(name: "Supply", value: "Moderate"),
            PlayerIQMarketMetric(name: "Liquidity", value: "Healthy"),
            PlayerIQMarketMetric(name: "Market Trend", value: "Uptrend"),
            PlayerIQMarketMetric(name: "Confidence", value: "81 / 100")
        ],
        riskFactors: [
            "Defensive home remains fluid, which could pressure long-term positional value.",
            "Power output must keep trending up to justify premium bat-first pricing.",
            "Market has reacted positively, so weak short-term performance could create volatility.",
            "If strikeout rates drift up, hobby enthusiasm may cool quickly."
        ],
        followUpPrompts: [
            "How does Bonemer compare to Blake Burke?",
            "What would make Bonemer a sell?",
            "Which Bonemer cards have the best upside?"
        ]
    )
}

struct PlayerIQMetric: Identifiable {
    let id = UUID()
    let name: String
    let score: Int
}

struct PlayerIQMarketMetric: Identifiable {
    let id = UUID()
    let name: String
    let value: String
}
