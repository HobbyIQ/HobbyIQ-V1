//
//  ActionIQModels.swift
//  HobbyIQ
//

import Foundation

struct ActionIQPlan: Codable {
    let userId: String
    let generatedAt: String
    let headline: String
    let sellNow: [ActionIQCard]
    let watch: [ActionIQCard]
    let hold: [ActionIQCard]
}

struct ActionIQCard: Codable, Identifiable {
    let cardId: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String?
    let listPrice: Double?
    let minAcceptableOffer: Double?
    let quickSalePrice: Double?
    let format: String?
    let reasoning: [String]?
    // FMV × quantity propagated from the source `InventoryCard` at producer
    // time so the row can render "—" for unpriced holdings without re-
    // reading the underlying holding. Optional + Codable Optional decode →
    // missing field becomes nil and the row falls through to "—", which is
    // the safe display for an unknown source.
    let fairMarketValueTotal: Double?

    var id: String { cardId }

    var displayValueFormatted: String {
        fairMarketValueTotal.map { portfolioCurrencyString($0) } ?? "—"
    }
}

struct ActionIQRequest: Codable {
    let userId: String
}
