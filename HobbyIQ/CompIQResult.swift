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

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            marketDirection = try? container.decodeIfPresent(String.self, forKey: .marketDirection)
            recentSalesPattern = try? container.decodeIfPresent(String.self, forKey: .recentSalesPattern)
            olderSalesPattern = try? container.decodeIfPresent(String.self, forKey: .olderSalesPattern)
            // Backend may send this as a number (-4.4) or a string ("-4.4%")
            if let str = try? container.decodeIfPresent(String.self, forKey: .changeFromOlderToRecent) {
                changeFromOlderToRecent = str
            } else if let num = try? container.decodeIfPresent(Double.self, forKey: .changeFromOlderToRecent) {
                changeFromOlderToRecent = "\(num)%"
            } else {
                changeFromOlderToRecent = nil
            }
            liquidity = try? container.decodeIfPresent(String.self, forKey: .liquidity)
            trendConfidence = try? container.decodeIfPresent(Double.self, forKey: .trendConfidence)
            windows = try? container.decodeIfPresent(Windows.self, forKey: .windows)
        }

        private enum CodingKeys: String, CodingKey {
            case marketDirection, recentSalesPattern, olderSalesPattern
            case changeFromOlderToRecent, liquidity, trendConfidence, windows
        }
    }

    struct RecentComp: Codable {
        let price: Double?
        let title: String?
        let date: String?
        let soldDate: String?
        let url: String?
        let grade: String?
        let parallel: String?
        let normalizedPrice: Double?
    }

    struct SearchIdentity: Codable {
        let player: String?
        let set: String?
        let number: String?
        let variant: String?
    }

    let success: Bool?
    let query: String?
    let summary: String?
    let marketTier: MarketTier?
    /// Phase 3: renamed from `fmv`. The canonical market value from the engine.
    let marketValue: Double?
    /// Phase 3: predicted price from multiplier-anchored mechanism (nullable).
    let predictedPrice: Double?
    /// Phase 3: predicted price range (nullable AND may be absent from JSON — both decode as nil).
    let predictedPriceRange: CompIQPriceRange?
    /// Phase 3: attribution metadata for predictedPrice (shape varies by engine path).
    let predictedPriceAttribution: CompIQPredictedPriceAttribution?
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
    let cardIdentity: SearchIdentity?
    let gradeUsed: String?
    let compsUsed: Int?
    let verdict: String?
    let action: String?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let graderPremium: Double?
    let dealScore: Double?
    let variantWarning: String?
    let compQuality: String?
    let dataSufficiency: String?
    let freshness: SearchFreshness?
    let broaderTrend: SearchBroaderTrend?
    let trendIQ: TrendIQResponse?

    struct SearchFreshness: Codable {
        let status: String?
        let lastUpdated: String?
        let daysSinceNewestComp: Int?
    }

    struct SearchBroaderTrend: Codable {
        let direction: String?
        let label: String?
        let note: String?
    }

    private enum CodingKeys: String, CodingKey {
        case success, query, summary, marketTier
        case marketValue, predictedPrice, predictedPriceRange, predictedPriceAttribution
        case buyZone, holdZone, sellZone
        case recentComps, outliers, trendAnalysis, supply, confidence
        case source, valuationMethod, gradeTierUsed, error
        case cardIdentity, gradeUsed, compsUsed
        case verdict, action, quickSaleValue, premiumValue
        case graderPremium, dealScore, variantWarning
        case compQuality, dataSufficiency, freshness, broaderTrend
        case trendIQ
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = try? container.decodeIfPresent(Bool.self, forKey: .success)
        query = try? container.decodeIfPresent(String.self, forKey: .query)
        summary = try? container.decodeIfPresent(String.self, forKey: .summary)
        marketTier = try? container.decodeIfPresent(MarketTier.self, forKey: .marketTier)
        marketValue = try? container.decodeIfPresent(Double.self, forKey: .marketValue)
        predictedPrice = try? container.decodeIfPresent(Double.self, forKey: .predictedPrice)
        predictedPriceRange = try? container.decodeIfPresent(CompIQPriceRange.self, forKey: .predictedPriceRange)
        predictedPriceAttribution = try? container.decodeIfPresent(CompIQPredictedPriceAttribution.self, forKey: .predictedPriceAttribution)
        buyZone = try? container.decodeIfPresent([Double].self, forKey: .buyZone)
        holdZone = try? container.decodeIfPresent([Double].self, forKey: .holdZone)
        sellZone = try? container.decodeIfPresent([Double].self, forKey: .sellZone)
        recentComps = try? container.decodeIfPresent([RecentComp].self, forKey: .recentComps)
        outliers = try? container.decodeIfPresent([RecentComp].self, forKey: .outliers)
        trendAnalysis = try? container.decodeIfPresent(TrendAnalysis.self, forKey: .trendAnalysis)
        supply = try? container.decodeIfPresent(CompIQEbaySupply.self, forKey: .supply)
        confidence = try? container.decodeIfPresent(Double.self, forKey: .confidence)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        valuationMethod = try? container.decodeIfPresent(String.self, forKey: .valuationMethod)
        gradeTierUsed = try? container.decodeIfPresent(String.self, forKey: .gradeTierUsed)
        error = try? container.decodeIfPresent(String.self, forKey: .error)
        cardIdentity = try? container.decodeIfPresent(SearchIdentity.self, forKey: .cardIdentity)
        gradeUsed = try? container.decodeIfPresent(String.self, forKey: .gradeUsed)
        compsUsed = try? container.decodeIfPresent(Int.self, forKey: .compsUsed)
        verdict = try? container.decodeIfPresent(String.self, forKey: .verdict)
        action = try? container.decodeIfPresent(String.self, forKey: .action)
        quickSaleValue = try? container.decodeIfPresent(Double.self, forKey: .quickSaleValue)
        premiumValue = try? container.decodeIfPresent(Double.self, forKey: .premiumValue)
        graderPremium = try? container.decodeIfPresent(Double.self, forKey: .graderPremium)
        dealScore = try? container.decodeIfPresent(Double.self, forKey: .dealScore)
        variantWarning = try? container.decodeIfPresent(String.self, forKey: .variantWarning)
        compQuality = try? container.decodeIfPresent(String.self, forKey: .compQuality)
        dataSufficiency = try? container.decodeIfPresent(String.self, forKey: .dataSufficiency)
        freshness = try? container.decodeIfPresent(SearchFreshness.self, forKey: .freshness)
        broaderTrend = try? container.decodeIfPresent(SearchBroaderTrend.self, forKey: .broaderTrend)
        trendIQ = try? container.decodeIfPresent(TrendIQResponse.self, forKey: .trendIQ)
    }

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
                fetchedAt: item.soldDate ?? item.date,
                date: item.soldDate ?? item.date,
                medianPrice: price,
                lowPrice: nil,
                highPrice: nil,
                sampleSize: nil
            )
        }

        // Build canonical card title from identity when available
        let identity = cardIdentity
        let canonicalTitle: String = {
            guard let id = identity, let player = id.player, let set = id.set else {
                return query ?? "Unknown Card"
            }
            let number = id.number.map { "#\($0) " } ?? ""
            let grade = gradeUsed.map { " — \($0)" } ?? ""
            let variant = (id.variant != nil && id.variant != "Base") ? " (\(id.variant!))" : ""
            return "\(set) \(number)\(player)\(grade)\(variant)"
        }()

        // Build enriched explanation bullets
        var enrichedBullets = explanationBullets
        let firstCompPrice = recentComps?.first?.price.map { "$\(Int($0.rounded()))" } ?? "—"
        let firstCompTitle = recentComps?.first?.title ?? "No recent comp"
        enrichedBullets.append("Recent comp: \(firstCompPrice) — \(firstCompTitle)")

        // Build enriched market DNA chips
        let dealScoreInt = Int((confidence ?? trendConfidence) * 100)
        let trendDirection = trendAnalysis?.marketDirection?.capitalized ?? "Flat"
        let liq = trendAnalysis?.liquidity ?? "Unknown"
        var dna = [trendDirection, liq, "Confidence \(dealScoreInt)%"]
        if let grade = gradeUsed { dna.append(grade) }
        if let n = compsUsed, n > 0 { dna.append("\(n) comps") }

        return CompIQEstimateResult(
            fairValue: fairValue,
            lowValue: lowValue,
            highValue: highValue,
            confidence: confidence ?? trendConfidence,
            method: valuationMethod ?? source ?? "live-search",
            summary: canonicalTitle,
            details: CompIQEstimateDetails(
                playerName: query,
                cardName: nil,
                parallel: nil,
                grade: gradeUsed ?? gradeTierUsed,
                compCount: compsUsed ?? trendAnalysis?.windows?.last30?.count ?? recentHistory.count,
                buyZone: buyZone?.first,
                fairZone: marketTier?.value,
                sellZone: sellZone?.last,
                lastUpdated: freshness?.lastUpdated
            ),
            marketHistory: recentHistory,
            compTrendConfidence: compTrendConfidence,
            compTrendPctPerWeek: trendPct,
            explanation: enrichedBullets.joined(separator: "\n"),
            explanationBullets: enrichedBullets,
            verdict: verdict,
            action: action,
            quickSaleValue: quickSaleValue,
            premiumValue: premiumValue,
            graderPremium: graderPremium,
            dealScore: self.dealScore,
            variantWarning: variantWarning,
            compQuality: compQuality,
            dataSufficiency: dataSufficiency,
            freshnessStatus: freshness?.status,
            freshnessLastUpdated: freshness?.lastUpdated,
            broaderTrendLabel: broaderTrend?.label,
            exitRecommendation: nil,
            exitDaysToSell: nil,
            buyWindowLabel: nil,
            buyWindowScore: nil,
            confidenceInterval: nil,
            marketDNAChips: dna,
            sellingGuidance: nil
        )
    }

    private var explanationBullets: [String] {
        var bullets: [String] = []
        if let marketDirection = trendAnalysis?.marketDirection, marketDirection.isEmpty == false {
            bullets.append(marketDirection)
        }
        if let changeSummary = trendAnalysis?.changeFromOlderToRecent, changeSummary.isEmpty == false {
            bullets.append(changeSummary)
        }
        if let liquidity = trendAnalysis?.liquidity, liquidity.isEmpty == false {
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
