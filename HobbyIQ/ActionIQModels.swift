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

    var id: String { cardId }
}

struct ActionIQRequest: Codable {
    let userId: String
}
