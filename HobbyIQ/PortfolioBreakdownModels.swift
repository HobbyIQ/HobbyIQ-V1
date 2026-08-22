//
//  PortfolioBreakdownModels.swift
//  HobbyIQ
//
//  CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). Wire shapes for
//  GET /api/portfolioiq/breakdown.
//
//  THESE ARE DTOs, NOT LOGIC. The analysis — scarcity parsing, category
//  precedence, scoring weights, concentration thresholds — lives once, on the
//  server, in portfolioAnalytics.service.ts. An earlier cut of this feature
//  computed all of it here in Swift as well; that was two implementations of
//  one rule, and they drift. This codebase was bitten by exactly that three
//  times on 2026-08-17 alone (the slug guard vs computeHobbyIqCardId, the
//  price-outlier diverter vs dataCleanJob, the null-slug backfill vs ingest),
//  so iOS renders what the server computes and nothing else.
//
//  The web dashboard decodes the same payload, which is what makes the two
//  clients incapable of disagreeing about the same portfolio.
//

import Foundation

struct PortfolioBreakdownResponse: Codable {
    let totalValue: Double
    let totalCost: Double
    let totalProfitLoss: Double
    let roi: Double
    let cardCount: Int
    let score: BreakdownScore
    let allocations: [BreakdownAllocation]
    let risk: [BreakdownRiskMetric]
    let concentrations: [BreakdownConcentration]
    let qualityBuckets: [BreakdownQualityBucket]
    let recommendations: [BreakdownRecommendation]
    let upgradeOpportunities: [BreakdownUpgrade]
    /// Share of value whose print run could not be read. Rendered as a caveat so
    /// a thin-data portfolio does not read as a confident verdict.
    let unknownScarcityValueShare: Double
    /// True when the user has defined their own tiers (CF-CUSTOM-TIERS).
    let usingCustomTiers: Bool?

    static let empty = PortfolioBreakdownResponse(
        totalValue: 0, totalCost: 0, totalProfitLoss: 0, roi: 0, cardCount: 0,
        score: BreakdownScore(value: 0, tier: "", components: []),
        allocations: [], risk: [], concentrations: [], qualityBuckets: [],
        recommendations: [], upgradeOpportunities: [],
        unknownScarcityValueShare: 0, usingCustomTiers: nil
    )
}

struct BreakdownScore: Codable {
    let value: Int
    let tier: String
    let components: [BreakdownScoreComponent]
}

struct BreakdownScoreComponent: Codable, Identifiable {
    let name: String
    let score: Double
    let weight: Double
    var id: String { name }
}

struct BreakdownAllocation: Codable, Identifiable {
    /// One of the four built-in categories, OR a user-defined tier id when the
    /// caller has custom tiers. Treated as an opaque string on purpose.
    let category: String
    let label: String
    let blurb: String
    let currentShare: Double
    let targetShare: Double
    let value: Double
    let cardCount: Int
    /// "onTarget" | "slightlyUnderweight" | "underweight" | "slightlyOverweight" | "overweight"
    let status: String
    let driftPoints: Double
    var id: String { category }
}

struct BreakdownRiskMetric: Codable, Identifiable {
    let name: String
    let score: Double
    /// "riskIsBad" | "strengthIsGood"
    let polarity: String
    /// "low" | "moderate" | "high"
    let level: String
    /// Already localised for display by the server — LOW / STRONG / etc.
    let label: String
    let detail: String
    let isConcerning: Bool
    var id: String { name }
}

struct BreakdownConcentration: Codable, Identifiable {
    let dimension: String
    let displayName: String
    let label: String
    let share: Double
    let value: Double
    let cardCount: Int
    let isWarning: Bool
    let guidance: String
    var id: String { dimension }
}

struct BreakdownQualityBucket: Codable, Identifiable {
    let tier: String
    let label: String
    let blurb: String
    let cardCount: Int
    let value: Double
    let valueShare: Double
    var id: String { tier }
}

struct BreakdownRecommendation: Codable, Identifiable {
    let kind: String
    let title: String
    let detail: String
    let priority: Int
    var id: String { "\(kind)-\(title)" }
}

struct BreakdownUpgrade: Codable {
    let cardCount: Int
    let combinedValue: Double
    let lowValue: Double
    let highValue: Double
    let insight: String
}
