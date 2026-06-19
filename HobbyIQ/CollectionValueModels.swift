//
//  CollectionValueModels.swift
//  HobbyIQ
//
//  CF-PHASE-5-COLLECTION-VALUE (2026-06-18): wire models for
//  GET /api/portfolio/value-history.
//
//  Honest-by-contract collection-value surface for the iOS dashboard.
//  Level + range + HISTORICAL 30d change + 30d sparkline + top-5 holdings
//  + framing.note footnote. ZERO forecast/direction/momentum fields — the
//  backend deliberately doesn't expose them and iOS deliberately doesn't
//  decode any.
//
//  totalDisplayable = observed + estimated (the card's headline). That's
//  WIDER than the InventoryIQ hero's observed-only displayValue. The two
//  are intentionally different surfaces:
//    - hero answers "what's confirmed-priced" (observed only)
//    - card answers "what's the collection worth incl. model estimates"
//  The "Est." prefix and the rangeLow–rangeHigh band on the card prime
//  the user that this number is wider than the hero.
//

import Foundation

// MARK: - Top-level response

struct PortfolioValueHistoryResponse: Codable, Hashable {
    /// ISO timestamp the backend computed this snapshot at.
    let asOf: String
    /// observedValue + estimatedValue (computed LIVE from the user doc).
    let totalDisplayable: Double
    /// Sum of estimateLow×qty (observed contributes its point estimate to
    /// both bounds; estimated contributes its band). LIVE.
    let rangeLow: Double
    let rangeHigh: Double
    let observedValue: Double
    let estimatedValue: Double
    let observedCount: Int
    let estimatedCount: Int
    let pendingCount: Int
    /// Active holdings — excludes sold/archived/watchlist/trade-pending.
    let totalCards: Int
    /// Historical delta against the closest snapshot ≤ today−30d. Null
    /// when history is empty.
    let change30d: PortfolioValueChange30d?
    /// Persisted daily trail, ASCENDING by date.
    let historySeries: [PortfolioValueHistoryPoint]
    /// Capped at 5; pending holdings excluded (no number to rank).
    let topHoldings: [PortfolioValueTopHolding]
    let framing: PortfolioValueFraming
}

// MARK: - Sub-types

struct PortfolioValueChange30d: Codable, Hashable {
    let absolute: Double
    /// Null when baseline displayableTotal is 0 (avoids a synthetic 0%
    /// reading at the start of history).
    let percent: Double?
    /// YYYY-MM-DD — the OLDEST snapshot used as the baseline.
    let asOfDate: String
    /// True when history is shorter than 30 days OR is a single snapshot
    /// (baseline == latest). iOS renders "since {asOfDate}" instead of
    /// "30d" when this is true.
    let rangeWeak: Bool
}

struct PortfolioValueHistoryPoint: Codable, Hashable, Identifiable {
    let date: String   // YYYY-MM-DD
    let total: Double

    /// The date string is unique per-user-per-day (id slot in Cosmos), so
    /// it doubles as the SwiftUI identity.
    var id: String { date }
}

struct PortfolioValueTopHolding: Codable, Hashable, Identifiable {
    let holdingId: String
    /// Pre-joined "Player · Card" display name from the backend (already
    /// trimmed + Card fallback when both fields are empty).
    let name: String
    let estValue: Double
    /// "observed" | "estimated". Kept as String for forward-compat — the
    /// backend may add new bucket values without an iOS decode break.
    let source: String

    var id: String { holdingId }

    var isObserved: Bool { source == "observed" }
    var isEstimated: Bool { source == "estimated" }
}

struct PortfolioValueFraming: Codable, Hashable {
    /// Always true in v1 — the headline is an estimate (includes the
    /// estimated bucket). Decoded as bool so future versions could flip
    /// the framing without an iOS schema break.
    let isEstimate: Bool
    /// Long-form copy from the backend explaining the range semantics.
    /// Renderable as-is in the muted footnote.
    let note: String
}
