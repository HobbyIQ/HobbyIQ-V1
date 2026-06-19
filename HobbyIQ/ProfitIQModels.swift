//
//  ProfitIQModels.swift
//  HobbyIQ
//

import Foundation

enum SellSignal: Codable, CaseIterable, Hashable {
    case sellNow
    case watch
    case hold
    case compIQ

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? ""
        self = Self(signalLabel: raw)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(displayTitle)
    }

    init(signalLabel: String) {
        let normalized = signalLabel.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "sell now", "sellnow", "sell":
            self = .sellNow
        case "watch":
            self = .watch
        case "hold":
            self = .hold
        case "compiq", "comp iq":
            self = .compIQ
        default:
            self = .watch
        }
    }

    var displayTitle: String {
        switch self {
        case .sellNow:
            return "Sell Now"
        case .watch:
            return "Watch"
        case .hold:
            return "Hold"
        case .compIQ:
            return "CompIQ"
        }
    }
}

struct ProfitIQCardResult: Identifiable, Codable, Hashable {
    let cardId: String
    let userId: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: SellSignal
    let confidence: Double
    let listPrice: Double
    let minAcceptableOffer: Double
    let quickSalePrice: Double
    let format: String
    let reasoning: [String]
    let lastSellIQAt: String
    // FMV × quantity propagated from `InventoryCard` via SellIQPortfolioCard.
    // Display-only: existing `currentValue` and P/L derivations are unchanged.
    let fairMarketValueTotal: Double?

    var id: String { cardId }

    var displayValueFormatted: String {
        fairMarketValueTotal.map { portfolioCurrencyString($0) } ?? "—"
    }

    init(from card: SellIQPortfolioCard) {
        cardId = card.cardId
        userId = card.userId
        playerName = card.playerName
        cardName = card.cardName
        cost = card.cost
        currentValue = card.currentValue
        profitLoss = card.profitLoss
        roi = card.roi
        signal = SellSignal(signalLabel: card.signal)
        confidence = card.confidence
        listPrice = card.listPrice
        minAcceptableOffer = card.minAcceptableOffer
        quickSalePrice = card.quickSalePrice
        format = card.format
        reasoning = card.reasoning
        lastSellIQAt = card.lastSellIQAt
        fairMarketValueTotal = card.fairMarketValueTotal
    }

    var asSellIQPortfolioCard: SellIQPortfolioCard {
        SellIQPortfolioCard(
            cardId: cardId,
            userId: userId,
            playerName: playerName,
            cardName: cardName,
            cost: cost,
            currentValue: currentValue,
            profitLoss: profitLoss,
            roi: roi,
            signal: signal.displayTitle,
            confidence: confidence,
            listPrice: listPrice,
            minAcceptableOffer: minAcceptableOffer,
            quickSalePrice: quickSalePrice,
            format: format,
            reasoning: reasoning,
            lastSellIQAt: lastSellIQAt,
            fairMarketValueTotal: fairMarketValueTotal
        )
    }
}

struct RecordSaleRequest: Codable {
    let userId: String
    let cardId: String
    let salePrice: Double
    let fees: Double
    let saleDate: String
}

struct RecordSaleResponse: Codable, Hashable {
    let success: Bool?
    let message: String?
    let card: ProfitIQCardResult?

    init(success: Bool? = nil, message: String? = nil, card: ProfitIQCardResult? = nil) {
        self.success = success
        self.message = message
        self.card = card
    }
}
