//
//  PortfolioIQModels.swift
//  HobbyIQ
//

import Foundation
import SwiftUI

typealias PortfolioPeriodStats = SummaryPeriod

struct PortfolioAccountSnapshot: Codable, Hashable {
    let userId: String
    let totalCards: Int
    let totalValue: Double
    let totalCost: Double
    let totalProfitLoss: Double
    let roi: Double
    let generatedAt: String

    var generatedAtFormatted: String {
        portfolioDisplayDate(from: generatedAt)
    }
}

struct PortfolioCardDetail: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let purchasePlatform: String?
    let notes: String?
    let lastPricedAt: String?
    let signal: String?
    let format: String?
    let sellReason: String?

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .gray)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var currentValueFormatted: String {
        portfolioCurrencyString(currentValue)
    }
}

struct PortfolioBestSellCard: Codable, Identifiable, Hashable {
    let id: String
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let profitLoss: Double
    let roi: Double
    let signal: String?
    let format: String?
    let recommendation: String

    var signalColor: Color {
        portfolioSignalColor(signal, fallback: .blue)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(profitLoss)
    }

    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }
}

extension PortfolioInventorySummary {
    var roiFormatted: String {
        portfolioSignedPercentString(roi)
    }

    var profitFormatted: String {
        portfolioSignedCurrencyString(totalProfitLoss)
    }

    var totalValueFormatted: String {
        portfolioCurrencyString(totalCurrentValue)
    }

    var totalCostFormatted: String {
        portfolioCurrencyString(totalCost)
    }
}

extension SummaryPeriod {
    var netProfitFormatted: String {
        portfolioSignedCurrencyString(netProfit ?? totalProfit)
    }

    var marginFormatted: String {
        String(format: "%.1f%% margin", margin)
    }

    var totalSoldFormatted: String {
        portfolioCurrencyString(totalSold)
    }

    var totalExpensesFormatted: String {
        portfolioCurrencyString(totalExpenses ?? 0)
    }
}

private func portfolioCurrencyString(_ value: Double) -> String {
    value.formatted(.currency(code: Locale.current.currency?.identifier ?? "USD"))
}

private func portfolioSignedCurrencyString(_ value: Double) -> String {
    let amount = portfolioCurrencyString(abs(value))
    return value >= 0 ? "+\(amount)" : "-\(amount)"
}

private func portfolioSignedPercentString(_ value: Double) -> String {
    String(format: "%+.1f%%", value)
}

private func portfolioDisplayDate(from rawValue: String) -> String {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
        return "—"
    }

    let date = portfolioParseDate(trimmed) ?? .distantPast
    guard date != .distantPast else {
        return trimmed
    }

    return date.formatted(.dateTime.month(.abbreviated).day())
}

private func portfolioParseDate(_ rawValue: String) -> Date? {
    let parser = ISO8601DateFormatter()
    if let date = parser.date(from: rawValue) {
        return date
    }

    let fractionalParser = ISO8601DateFormatter()
    fractionalParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractionalParser.date(from: rawValue) {
        return date
    }

    let dateOnlyFormatter = DateFormatter()
    dateOnlyFormatter.locale = Locale(identifier: "en_US_POSIX")
    dateOnlyFormatter.dateFormat = "yyyy-MM-dd"
    return dateOnlyFormatter.date(from: rawValue)
}

private func portfolioSignalColor(_ rawValue: String?, fallback: Color) -> Color {
    guard let rawValue else {
        return fallback
    }

    let normalized = rawValue
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")

    switch normalized {
    case "strong_sell", "sell_now", "sellnow", "sell":
        return .red
    case "hold":
        return Color(hex: 0x3B82F6)
    case "strong_hold":
        return .green
    default:
        return fallback
    }
}
