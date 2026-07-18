//
//  OutcomeAttributionModels.swift
//  HobbyIQ
//
//  Wire models for the post-sale attribution loop (backend PR #554 store,
//  read route added as a follow-up). Powers the outcome badge on the
//  Sale Details sheet and the "engine hit rate" counter on Portfolio
//  landing.
//

import Foundation

enum SaleOutcomeClass: String, Codable, Hashable {
    case verdictHit   = "verdict_hit"
    case verdictMiss  = "verdict_miss"
    case holdSold     = "hold_sold"
    case noVerdict    = "no_verdict"
}

/// Response for GET /api/portfolio/sales/:soldEntryId/outcome.
/// `verdictAtSaleTime` and `priceTargetAtSnapshot` are the values that
/// were on the snapshot when the sale committed (source of truth for
/// the "engine said X" copy). `outcomeClass == .noVerdict` hides the
/// badge entirely.
struct SaleOutcomeResponse: Codable, Hashable {
    /// Wire uses SELL_NOW / LIST_HIGHER / GRADE_UP / WAIT_TO_LIST / HOLD.
    let verdictAtSaleTime: String?
    let verdictSnapshotDate: String?
    let priceTargetAtSnapshot: Double?
    let daysSinceVerdict: Int?
    let outcomeClass: SaleOutcomeClass?
    /// Optional actual sale price for miss copy ("engine said $2,639,
    /// actual $2,000"). Missing on older docs — copy adapts.
    let actualSalePrice: Double?
}

/// Response for GET /api/backtest/outcomes-summary. Powers the counter
/// pill on Portfolio landing. Hidden entirely when totalVerdicts < 5.
struct OutcomesSummaryResponse: Codable, Hashable {
    let windowDays: Int?
    let totalVerdicts: Int?
    let perVerdictHitRate: [OutcomeVerdictRollup]?
}

struct OutcomeVerdictRollup: Codable, Hashable, Identifiable {
    let verdict: String?
    let calls: Int?
    let hits: Int?
    let hitRate: Double?

    var id: String { verdict ?? UUID().uuidString }
}
