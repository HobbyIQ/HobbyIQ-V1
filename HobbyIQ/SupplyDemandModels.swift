//
//  SupplyDemandModels.swift
//  HobbyIQ
//
//  PR #425 (2026-07-13): response models for the three portfolio-level
//  supply/demand endpoints — the priced-card response's `supplyDemand`
//  field is defined in CompIQSearchModels alongside the other priced-card
//  types. These are portfolio aggregates.
//
//  All fields decode defensively (try? decodeIfPresent) so a shape drift
//  degrades to empty UI instead of a crash. Verdict enum strings are
//  passed through verbatim to VerdictStyle.from(_:) at render time.
//

import Foundation

// MARK: - GET /api/portfolio/supply-demand-summary

struct SupplyDemandSummaryResponse: Codable {
    let portfolioBias: String?
    let totalHoldings: Int?
    let breakdown: Breakdown?
    let topMovers: [TopMover]?

    struct Breakdown: Codable {
        let up: Int?
        let mixed: Int?
        let bear: Int?
        let unknown: Int?
    }

    struct TopMover: Codable, Identifiable, Hashable {
        let holdingId: String?
        let cardId: String?
        let playerName: String?
        let verdict: String?
        let listingsSlopePerMonthPct: Double?
        let salesSlopePerMonthPct: Double?

        var id: String {
            holdingId ?? cardId ?? "\(playerName ?? "")-\(verdict ?? "")"
        }
    }
}

// MARK: - GET /api/portfolio/signal-weighted-totals

struct SignalWeightedTotalsResponse: Codable {
    let totals: Totals?
    let byVerdictClass: ByVerdictClass?

    struct Totals: Codable {
        let gross: Double?
        let trendAdjusted: Double?
        let feesAdjusted: Double?
    }

    struct ByVerdictClass: Codable {
        let bull: Bucket?
        /// Wire key is `static` — Swift-reserved word, escape via CodingKeys.
        let staticBucket: Bucket?
        let bear: Bucket?
        let unavailable: Bucket?

        struct Bucket: Codable {
            let trendAdjusted: Double?
            let holdings: Int?
        }

        enum CodingKeys: String, CodingKey {
            case bull
            case staticBucket = "static"
            case bear
            case unavailable
        }
    }
}

// MARK: - GET /api/portfolio/watchlist-bull-candidates

struct WatchlistBullCandidatesResponse: Codable {
    let candidates: [Candidate]?

    struct Candidate: Codable, Identifiable, Hashable {
        let playerName: String?
        let verdict: String?
        let listingsSlopePerMonthPct: Double?
        let salesSlopePerMonthPct: Double?

        var id: String { playerName ?? UUID().uuidString }
    }
}
