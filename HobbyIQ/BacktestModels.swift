//
//  BacktestModels.swift
//  HobbyIQ
//
//  Wire model for GET /api/backtest/predicted-price-accuracy
//  (backend PR #548). Powers the small "engine accuracy" trust badge
//  under the total portfolio value on the Portfolio landing.
//

import Foundation

/// Verdict signalling how much weight the user should give the badge.
/// `insufficient_sample` = hide entirely.
enum BacktestVerdict: String, Codable, Hashable {
    case trustworthy         = "trustworthy"
    case developing          = "developing"
    case insufficientSample  = "insufficient_sample"
}

struct PredictedPriceAccuracyResponse: Codable, Hashable {
    /// ISO string — never surfaced to the user directly.
    let computedAt: String?
    /// "user" or "global" — surfaced only inside the drill-down sheet.
    let scope: String?
    let totalCards: Int?
    let accuracy: PredictedPriceAccuracy?
}

struct PredictedPriceAccuracy: Codable, Hashable {
    let matchedPairs: Int?
    let medianAbsPctError: Double?
    let hitRateWithin10Pct: Double?
    let hitRateWithin20Pct: Double?
    let overShootShare: Double?
    let underShootShare: Double?
    let verdict: BacktestVerdict?
}
