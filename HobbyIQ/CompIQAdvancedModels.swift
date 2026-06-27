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

    /// Display-side label with backend mojibake repaired. Backend sometimes
    /// ships "(Sepâ€"Oct)" — UTF-8 en-dash misdecoded as Latin-1 then
    /// re-encoded. Surfacing the raw label is what the user sees; this
    /// computed property repairs the common sequences before display.
    var displayLabel: String? { label?.repairingMojibake() }

    /// Display-side reason with the same mojibake repair pass.
    var displayReason: String? { reason?.repairingMojibake() }

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

// MARK: - Mojibake Repair

extension String {
    /// Backend strings occasionally arrive UTF-8-encoded once, misdecoded as
    /// Latin-1 / Windows-1252, then re-encoded as UTF-8 — classic mojibake.
    /// The most-visible artifact is en-dash printed as `â€”`
    /// or `â€`. Repair common sequences on display so the
    /// user never sees broken bytes. Order matters: longer sequences are
    /// listed first so a partial match doesn't strip a valid suffix.
    func repairingMojibake() -> String {
        guard contains("â€") || contains("Ã") else { return self }
        var s = self
        let pairs: [(String, String)] = [
            ("\u{00E2}\u{0080}\u{0093}", "\u{2013}"),
            ("\u{00E2}\u{0080}\u{0094}", "\u{2014}"),
            ("\u{00E2}\u{0080}\u{0098}", "\u{2018}"),
            ("\u{00E2}\u{0080}\u{0099}", "\u{2019}"),
            ("\u{00E2}\u{0080}\u{009C}", "\u{201C}"),
            ("\u{00E2}\u{0080}\u{009D}", "\u{201D}"),
            ("\u{00E2}\u{0080}\u{00A6}", "\u{2026}"),
            ("\u{00C3}\u{00A9}", "\u{00E9}"),
            ("\u{00C3}\u{00A8}", "\u{00E8}"),
            ("\u{00C3}\u{00B1}", "\u{00F1}"),
            ("\u{00C3}\u{00A1}", "\u{00E1}"),
            ("\u{00C3}\u{00B3}", "\u{00F3}"),
            ("\u{00C3}\u{00BA}", "\u{00FA}")
        ]
        for (broken, fixed) in pairs {
            s = s.replacingOccurrences(of: broken, with: fixed)
        }
        return s
    }
}
