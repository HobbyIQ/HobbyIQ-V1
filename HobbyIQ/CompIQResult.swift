//
//  CompIQResult.swift
//  HobbyIQ
//

import Foundation

struct CompIQSearchRequest: Codable {
    let query: String
}

struct CompIQSearchResponse: Codable {
    struct MarketTier: Codable {
        let value: Double?
        let high: Double?
    }

    struct TrendAnalysis: Codable {
        struct Window: Codable {
            let count: Int?
            let avgPrice: Double?
        }

        struct Windows: Codable {
            let last7: Window?
            let last14: Window?
            let last30: Window?
            let last60: Window?
            let last90: Window?
        }

        let marketDirection: String?
        let recentSalesPattern: String?
        let olderSalesPattern: String?
        let changeFromOlderToRecent: String?
        let liquidity: String?
        let trendConfidence: Double?
        let windows: Windows?
    }

    struct RecentComp: Codable {
        let price: Double?
        let title: String?
        let date: String?
        let url: String?
        let grade: String?
        let parallel: String?
        let normalizedPrice: Double?
    }

    let success: Bool?
    let query: String?
    let summary: String?
    let marketTier: MarketTier?
    let buyZone: [Double]?
    let holdZone: [Double]?
    let sellZone: [Double]?
    let recentComps: [RecentComp]?
    let outliers: [RecentComp]?
    let trendAnalysis: TrendAnalysis?
    let supply: CompIQEbaySupply?
    let confidence: Double?
    let source: String?
    let valuationMethod: String?
    let gradeTierUsed: String?
    let error: String?

    func asEstimateResult() -> CompIQEstimateResult {
        let fairValue = marketTier?.value ?? 0
        let lowValue = buyZone?.first ?? fairValue
        let highValue = marketTier?.high ?? sellZone?.last ?? fairValue
        let trendConfidence = trendAnalysis?.trendConfidence ?? confidence ?? 0
        let compTrendConfidence = compTrendConfidenceLabel(from: trendConfidence)
        let trendPct = parsedTrendPercent(from: trendAnalysis?.changeFromOlderToRecent)
        let recentHistory = (recentComps ?? []).compactMap { item -> CompIQMarketHistoryPoint? in
            let price = item.normalizedPrice ?? item.price
            guard let price else { return nil }
            return CompIQMarketHistoryPoint(
                fetchedAt: item.date,
                date: item.date,
                medianPrice: price,
                lowPrice: nil,
                highPrice: nil,
                sampleSize: nil
            )
        }

        return CompIQEstimate(
            fairValue: fairValue,
            lowValue: lowValue,
            highValue: highValue,
            confidence: confidence ?? trendConfidence,
            method: valuationMethod ?? source ?? "live-search",
            summary: summary ?? "CompIQ did not return a summary.",
            details: CompIQEstimateDetails(
                playerName: query,
                cardName: nil,
                parallel: nil,
                grade: gradeTierUsed,
                compCount: trendAnalysis?.windows?.last30?.count ?? recentHistory.count,
                buyZone: buyZone?.first,
                fairZone: marketTier?.value,
                sellZone: sellZone?.last,
                lastUpdated: nil
            ),
            marketHistory: recentHistory,
            compTrendConfidence: compTrendConfidence,
            compTrendPctPerWeek: trendPct,
            explanation: explanationText,
            explanationBullets: explanationBullets
        )
    }

    private var explanationBullets: [String] {
        var bullets: [String] = []
        if let recentSalesPattern, recentSalesPattern.isEmpty == false {
            bullets.append(recentSalesPattern)
        }
        if let olderSalesPattern, olderSalesPattern.isEmpty == false {
            bullets.append(olderSalesPattern)
        }
        if let liquidity, liquidity.isEmpty == false {
            bullets.append("Liquidity: \(liquidity)")
        }
        return bullets
    }

    private var explanationText: String {
        if let summary, summary.isEmpty == false {
            return summary
        }
        return explanationBullets.joined(separator: "\n")
    }

    private func compTrendConfidenceLabel(from value: Double) -> String {
        switch value {
        case 0.85...:
            return "High"
        case 0.65..<0.85:
            return "Moderate"
        case 0.0..<0.65:
            return "Low"
        default:
            return "None"
        }
    }

    private func parsedTrendPercent(from rawValue: String?) -> Double? {
        guard let rawValue else { return nil }
        let pattern = #"[-+]?\d+(?:\.\d+)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: rawValue, range: NSRange(rawValue.startIndex..., in: rawValue)),
              let range = Range(match.range, in: rawValue),
              let percent = Double(rawValue[range]) else {
            return nil
        }
        return percent / 100
    }
}
