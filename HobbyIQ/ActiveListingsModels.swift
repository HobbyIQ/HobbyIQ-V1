//
//  ActiveListingsModels.swift
//  HobbyIQ
//
//  Backend PR #544 (2026-07-17): GET /api/compiq/cards/:cardId/active-listings
//  wire models. Feeds the "Active Listings on eBay" section on both the
//  holding-detail page and the CompIQ priced-card page.
//

import Foundation

struct ActiveListingsResponse: Codable {
    let success: Bool?
    let listings: [ActiveListing]?
    let totalReported: Int?
    let effectiveQuery: String?
    let snapshottedAt: String?
    let cached: Bool?
}

struct ActiveListing: Codable, Identifiable, Hashable {
    let id: String
    let title: String?
    let price: Double?
    let currency: String?
    let imageUrl: String?
    let itemWebUrl: String?
    let seller: ActiveListingSeller?
    let endsAt: String?
    /// 0..100 — how well the listing matched the card query.
    let matchScore: Int?
    let scoreBreakdown: ActiveListingScoreBreakdown?
}

struct ActiveListingSeller: Codable, Hashable {
    let username: String?
    let feedbackScore: Int?
    let feedbackPercentage: Double?
}

struct ActiveListingScoreBreakdown: Codable, Hashable {
    let parallelHit: Bool?
    /// Non-nil when the listing title carries a *different* parallel than
    /// the target (e.g. "Blue Refractor" showing on a Refractor search).
    let wrongParallelHit: String?
    let cardNumberHit: Bool?
    let yearHit: Bool?
    let setHit: Bool?
    /// `"correct"` / `"wrong-grade"` / `"raw-but-graded"` / `"not-graded"` /
    /// `"no-signal"`. Drives the confidence chip on the row.
    let gradeMatch: String?
}
