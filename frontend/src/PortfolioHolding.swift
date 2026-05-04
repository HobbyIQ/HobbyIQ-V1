import Foundation
import SwiftUI

struct PortfolioHolding: Identifiable, Codable, Equatable {
    let id: UUID
    let cardTitle: String
    let subject: [String: AnyCodable] // Raw subject for future API
    let verdict: String
    let action: String
    let dealScore: Int
    let quickSaleValue: Int
    let fairMarketValue: Int
    let premiumValue: Int
    let explanation: [String]
    let marketDNA: [String]
    let confidence: [String: AnyCodable]
    let exitStrategy: [String: AnyCodable]
    let freshness: String?
    let lastUpdated: Date
    // User fields
    var quantity: Int
    var purchasePrice: Double
    var purchaseDate: Date
    var fees: Double
    var tax: Double
    var shipping: Double
    var notes: String

    var costBasis: Double {
        (purchasePrice * Double(quantity)) + fees + tax + shipping
    }
    var currentValue: Double {
        Double(fairMarketValue) * Double(quantity)
    }
    var profitLoss: Double {
        currentValue - costBasis
    }
    var freshnessStatus: String {
        freshness ?? "Unknown"
    }
    var status: String {
        verdict
    }
}

// Codable wrapper for [String: Any]
struct AnyCodable: Codable, Equatable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws { self.value = "" }
    func encode(to encoder: Encoder) throws {}
}
