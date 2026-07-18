//
//  TradeTargetModels.swift
//  HobbyIQ
//
//  Wire model for GET /api/portfolio/trade-targets?source={inventory|watchlist}
//  (backend PR #551). Powers the "Find Deals" sheet — underpriced eBay
//  listings surfaced from cards the user cares about.
//

import Foundation

enum TradeTargetSource: String, Codable, Hashable, CaseIterable, Identifiable {
    case inventory
    case watchlist

    var id: String { rawValue }

    /// Label for the segmented picker.
    var pickerLabel: String {
        switch self {
        case .inventory: return "From my inventory"
        case .watchlist: return "Watchlist (coming soon)"
        }
    }
}

enum TradeTargetConfidence: String, Codable, Hashable {
    case high
    case medium
    case low
}

struct TradeTargetSeller: Codable, Hashable {
    let username: String?
    let feedbackScore: Int?
}

struct TradeTarget: Codable, Identifiable, Hashable {
    let cardId: String
    let playerName: String?
    let cardTitle: String?
    let imageUrl: String?
    let askPrice: Double?
    let engineValue: Double?
    let discountPct: Double?
    let discountAbsolute: Double?
    let confidence: TradeTargetConfidence?
    let reason: String?
    let listingUrl: String?
    let seller: TradeTargetSeller?

    var id: String {
        [cardId, listingUrl ?? "", seller?.username ?? ""].joined(separator: "|")
    }
}

struct TradeTargetsResponse: Codable, Hashable {
    let computedAt: String?
    let source: String?
    let cardsScanned: Int?
    let listingsSeen: Int?
    let targets: [TradeTarget]?
}
