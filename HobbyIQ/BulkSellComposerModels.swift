//
//  BulkSellComposerModels.swift
//  HobbyIQ
//
//  Wire models for POST /api/portfolio/bulk-sell-composer (backend
//  PR #549). Compares "list individually" vs "add to bundle" net
//  proceeds across a user-selected batch of holdings.
//

import Foundation

enum BulkSellStrategy: String, Codable, Hashable {
    case listIndividually       = "list_individually"
    case addToBundle            = "add_to_bundle"
    case skipMissingPredicted   = "skip_missing_predicted"
}

enum BulkSellTotalStrategy: String, Codable, Hashable {
    case allIndividual = "all_individual"
    case allBundle     = "all_bundle"
    case mixed         = "mixed"
}

struct BulkSellRequest: Codable {
    let holdingIds: [String]
}

struct BulkSellCandidate: Codable, Identifiable, Hashable {
    let holdingId: String
    let playerName: String?
    let cardTitle: String?
    let predictedPrice: Double?
    let individualNetProceeds: Double?
    let bundleShareOfNet: Double?
    let netDelta: Double?
    let strategy: BulkSellStrategy?

    var id: String { holdingId }
}

struct BulkSellTotals: Codable, Hashable {
    let individualStrategyNet: Double?
    let bundleStrategyNet: Double?
    let combinedNet: Double?
    let recommendedStrategy: BulkSellTotalStrategy?
    let projectedLift: Double?
}

struct BulkSellAssumptions: Codable, Hashable {
    let ebayFeePct: Double?
    let bundleDiscountPct: Double?
    let perCardShippingCost: Double?
    let bundleShippingCost: Double?
}

struct BulkSellResponse: Codable, Hashable {
    let computedAt: String?
    let requestedCount: Int?
    let resolvedCount: Int?
    let candidates: [BulkSellCandidate]?
    let totals: BulkSellTotals?
    let assumptions: BulkSellAssumptions?
}
