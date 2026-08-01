//
//  RecentSalesModels.swift
//  HobbyIQ
//
//  Wire model for GET /api/compiq/cards/:cardId/recent-sales
//  (backend PR #598/#599/#600 series). Feeds the "recent sales" feed
//  on Card Detail — the raw comps that the canonical FMV pipeline
//  consumed.
//

import Foundation

/// Source of a comp row. Never surfaced verbatim — mapped to a
/// human-readable chip label in the UI (see `RecentSaleSource.chipLabel`).
enum RecentSaleSource: String, Decodable, Hashable {
    case ebayUserPurchase   = "ebay-user-purchase"
    case ebayUserSale       = "ebay-user-sale"
    case manualUserEntry    = "manual-user-entry"
    case cardhedge          = "cardhedge"
    case cardsight          = "cardsight"
    case ebayBrowseEnded    = "ebay-browse-ended"

    var chipLabel: String {
        switch self {
        case .ebayUserPurchase, .ebayUserSale, .ebayBrowseEnded: return "eBay"
        case .manualUserEntry:                                    return "Manual"
        case .cardhedge:                                           return "CardHedge"
        case .cardsight:                                           return "Cardsight"
        }
    }

    /// True when the comp originates from the user's own action
    /// (personal eBay purchase/sale or manual attest), regardless of
    /// whether contributorUserId is set.
    var isUserOriginated: Bool {
        switch self {
        case .ebayUserPurchase, .ebayUserSale, .manualUserEntry: return true
        default:                                                  return false
        }
    }
}

struct RecentSale: Decodable, Hashable, Identifiable {
    let source: RecentSaleSource?
    let price: Double?
    let soldAt: String?
    let title: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let cardYear: Int?
    let cardNumber: String?
    let imageUrl: String?
    let sellerHandle: String?
    /// "self" when the row is the caller's own comp; nil otherwise.
    /// Any other value is discarded — we never surface another user's id.
    let contributorUserId: String?
    let confidence: Double?
    // CF-USER-FLAG (Drew, 2026-08-01). Server-side row id + partition
    // key (cardId) needed so the flag button can POST /api/user/flag-comp.
    let rowId: String?
    let cardId: String?
    // CF-CONFIDENCE-EXPLAIN (Drew, 2026-08-01). Persisted at ingest.
    let confidenceScore: Double?
    let confidenceBand: String?
    let confidenceExplain: String?

    // Backend recentSales endpoint sends `id` for row id — decode into
    // rowId to avoid colliding with Identifiable's synthesized id.
    enum CodingKeys: String, CodingKey {
        case source, price, soldAt, title, parallel, gradeCompany, gradeValue
        case cardYear, cardNumber, imageUrl, sellerHandle
        case contributorUserId, confidence
        case rowId = "id"
        case cardId
        case confidenceScore, confidenceBand, confidenceExplain
    }

    /// True when contributorUserId == "self" — used for the "You" chip.
    var isSelfContribution: Bool {
        contributorUserId == "self"
    }

    /// Identifiable id — prefer server rowId when present, fallback to composite.
    var id: String {
        if let rowId, rowId.isEmpty == false { return rowId }
        return [soldAt ?? "", price.map { String($0) } ?? "", sellerHandle ?? "", source?.rawValue ?? ""]
            .joined(separator: "|")
    }
}

struct RecentSalesResponse: Decodable, Hashable {
    let count: Int?
    let sales: [RecentSale]?
}
