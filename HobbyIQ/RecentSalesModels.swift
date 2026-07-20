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

    /// True when contributorUserId == "self" — used for the "You" chip.
    var isSelfContribution: Bool {
        contributorUserId == "self"
    }

    /// Composite id — recent-sales rows don't carry a stable server id.
    var id: String {
        [soldAt ?? "", price.map { String($0) } ?? "", sellerHandle ?? "", source?.rawValue ?? ""]
            .joined(separator: "|")
    }
}

struct RecentSalesResponse: Decodable, Hashable {
    let count: Int?
    let sales: [RecentSale]?
}
