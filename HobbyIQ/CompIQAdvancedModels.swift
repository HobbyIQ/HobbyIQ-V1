//
//  CompIQAdvancedModels.swift
//  HobbyIQ
//

import Foundation

// MARK: - TrendIQ Dedicated Endpoints

struct TrendIQRequest: Encodable {
    let cardsightCardId: String
    let query: String?
    let gradeCompany: String?
    let gradeValue: Double?
}

struct TrendIQDedicatedResponse: Codable {
    let success: Bool?
    let cardsightCardId: String?
    let trendIQ: TrendIQResponse?
    let signalsLastUpdated: String?
    let cardIdentity: CompIQPriceCardIdentity?
    let gradeUsed: String?
}

struct TrendIQFullResponse: Codable {
    let success: Bool?
    let cardsightCardId: String?
    let trendIQ: TrendIQResponse?
    let signalsLastUpdated: String?
    let cardIdentity: CompIQPriceCardIdentity?
    let gradeUsed: String?
    let segmentTrajectoryFull: SegmentTrajectoryFull?
}

struct SegmentTrajectoryFull: Codable {
    let siblingCardIds: [String]?
    let reanchorApplied: Bool?
    let effectiveAnchorDate: String?
    let originalAnchorDate: String?
    let preAnchorSales: [AnchorSale]?
    let postAnchorSales: [AnchorSale]?
    let perWindow: PerWindowStats?

    struct AnchorSale: Codable, Identifiable {
        let price: Double
        let ts: Double
        var id: Double { ts }
    }

    struct WindowStat: Codable {
        let mean: Double
        let p25: Double
        let p75: Double
    }

    struct PerWindowStats: Codable {
        let pre: WindowStat
        let post: WindowStat
    }
}

// MARK: - Market Trend Endpoints

struct MarketDelta: Codable {
    let pct1d: Double?
    let pct7d: Double?
    let pct30d: Double?
    let avg1d: Double?
    let avg7d: Double?
    let avg30d: Double?
    let volume1d: Int?
    let volume7d: Int?
    let volume30d: Int?
}

struct MarketTrendWindow: Codable {
    let pct30dLabel: String?
}

struct MarketTrendResponse: Codable {
    let success: Bool?
    let playerName: String?
    let delta: MarketDelta?
    let confidence: String?
    let window: MarketTrendWindow?
}

struct MarketTrendBatchResponse: Codable {
    let success: Bool?
    let deltas: [String: MarketTrendBatchEntry]?
    let window: MarketTrendWindow?
    let truncated: MarketTrendTruncated?
}

struct MarketTrendBatchEntry: Codable {
    let delta: MarketDelta?
    let confidence: String?
}

struct MarketTrendTruncated: Codable {
    let requested: Int?
    let served: Int?
}

struct TopMoversResponse: Codable {
    let success: Bool?
    let window: TopMoversWindow?
    let limit: Int?
    let movers: [TopMover]?
    let poolSize: Int?
}

struct TopMoversWindow: Codable {
    let selected: String?
    let pct30dLabel: String?
}

struct TopMover: Codable, Identifiable {
    let playerName: String
    let delta: MarketDelta?
    let confidence: String?
    var id: String { playerName }
}

// MARK: - Grade Premium

struct GradePremiumRequest: Encodable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let isAuto: Bool?
}

struct GradePremiumResponse: Codable {
    let success: Bool?
    let playerName: String?
    let rawFmv: Double?
    let psa10Fmv: Double?
    let premiumDollars: Double?
    let premiumPct: Double?
    let worthGrading: Bool?
    let verdict: String?
}

// MARK: - Sell Window

struct SellWindowRequest: Encodable {
    let playerName: String
    let isRookie: Bool?
    let cardYear: Int?
    let sport: String?
}

struct SellWindowResponse: Codable {
    let success: Bool?
    let playerName: String?
    let inWindowNow: Bool?
    let activeWindow: SellWindowPeriod?
    let nextWindow: SellWindowPeriod?
    let monthsUntilNext: Int?
    let allWindows: [SellWindowPeriod]?
    let verdict: String?
}

struct SellWindowPeriod: Codable, Identifiable {
    let startMonth: Int?
    let endMonth: Int?
    let label: String?
    let reason: String?
    var id: String { "\(startMonth ?? 0)-\(endMonth ?? 0)-\(label ?? "")" }

    var monthRange: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM"
        guard let start = startMonth, let end = endMonth,
              start >= 1, start <= 12, end >= 1, end <= 12 else { return label ?? "" }
        let startDate = Calendar.current.date(from: DateComponents(month: start))!
        let endDate = Calendar.current.date(from: DateComponents(month: end))!
        return "\(formatter.string(from: startDate)) – \(formatter.string(from: endDate))"
    }
}

// MARK: - What-If

struct WhatIfRequest: Encodable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let isAuto: Bool?
}

// MARK: - Bulk Estimate

struct AdvancedBulkEstimateRequest: Encodable {
    let queries: [String]
}

struct AdvancedBulkEstimateResponse: Codable {
    let requested: Int?
    let succeeded: Int?
    let failed: Int?
    let results: [BulkEstimateResultItem]?
}

struct BulkEstimateResultItem: Codable, Identifiable {
    let query: String?
    let status: String?
    let data: BulkEstimateItemData?
    let error: String?
    var id: String { query ?? UUID().uuidString }
}

struct BulkEstimateItemData: Codable {
    let cardTitle: String?
    let fairMarketValue: Double?
    let marketValue: Double?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let verdict: String?
    let action: String?
    let confidence: Double?
    let compsUsed: Int?
    let gradeUsed: String?
    let source: String?
    let dealScore: Double?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cardTitle = try? container.decodeIfPresent(String.self, forKey: .cardTitle)
        fairMarketValue = try? container.decodeIfPresent(Double.self, forKey: .fairMarketValue)
        marketValue = try? container.decodeIfPresent(Double.self, forKey: .marketValue)
        quickSaleValue = try? container.decodeIfPresent(Double.self, forKey: .quickSaleValue)
        premiumValue = try? container.decodeIfPresent(Double.self, forKey: .premiumValue)
        verdict = try? container.decodeIfPresent(String.self, forKey: .verdict)
        action = try? container.decodeIfPresent(String.self, forKey: .action)
        // confidence can be a number or an object — try number first
        confidence = try? container.decodeIfPresent(Double.self, forKey: .confidence)
        compsUsed = try? container.decodeIfPresent(Int.self, forKey: .compsUsed)
        gradeUsed = try? container.decodeIfPresent(String.self, forKey: .gradeUsed)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        dealScore = try? container.decodeIfPresent(Double.self, forKey: .dealScore)
    }

    private enum CodingKeys: String, CodingKey {
        case cardTitle, fairMarketValue, marketValue, quickSaleValue, premiumValue
        case verdict, action, confidence, compsUsed, gradeUsed, source, dealScore
    }
}

// MARK: - Comps By Player

struct CompsByPlayerResponse: Codable {
    let player: String?
    let product: String?
    let cardYear: Int?
    let cardIds: [String]?
    let comps: [PlayerComp]?
    let cached: Bool?
    let cacheAge: Int?
    let warnings: [String]?
}

struct PlayerComp: Codable, Identifiable {
    let cardId: String?
    let price: Double?
    let date: String?
    let title: String?
    let source: String?
    var id: String { "\(cardId ?? "")-\(price ?? 0)-\(date ?? "")" }
}
