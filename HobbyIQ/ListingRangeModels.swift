//
//  ListingRangeModels.swift
//  HobbyIQ
//
//  Wire model for GET /api/compiq/cards/:cardId/listing-range (backend
//  PR #592). Powers the "Currently listing on eBay" section that sits
//  under the FMV headline on Card Detail.
//

import Foundation

struct ListingRangeResponse: Decodable, Hashable {
    let count: Int?
    let range: ListingRangeBand?
    let median: Double?
    let min: Double?
    let max: Double?
    let delta: ListingRangeDelta?
    let listings: [ListingRangeEntry]?
}

struct ListingRangeBand: Decodable, Hashable {
    let p25: Double
    let p75: Double
}

/// Direction of the median-vs-FMV comparison. `flat` when the
/// divergence is within +/-15%, otherwise `up` or `down`.
enum ListingRangeDirection: String, Decodable, Hashable {
    case up
    case down
    case flat
}

struct ListingRangeDelta: Decodable, Hashable {
    let vsFmv: Double?
    let vsFmvPct: Double?
    let direction: ListingRangeDirection?
}

struct ListingRangeEntry: Decodable, Hashable, Identifiable {
    let price: Double?
    /// ISO string — rendered as a relative "ends in 2 days" label.
    let endsAt: String?
    let sellerHandle: String?
    let itemWebUrl: String?
    let imageUrl: String?
    let title: String?

    /// Composite id for ForEach stability — listings don't carry a
    /// stable server-side id in the wire response.
    var id: String {
        let priceString = price.map { String($0) } ?? ""
        return [itemWebUrl ?? "", sellerHandle ?? "", priceString]
            .joined(separator: "|")
    }
}
