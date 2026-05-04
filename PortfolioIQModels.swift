import Foundation
import SwiftUI

// MARK: - Portfolio Holding Model
struct PortfolioHolding: Identifiable, Hashable {
    let id: UUID
    var playerName: String
    var cardTitle: String
    var cardYear: Int
    var brand: String
    var setName: String
    var product: String
    var cardNumber: String?
    var parallel: String?
    var serialNumber: String?
    var isAuto: Bool
    var isPatch: Bool
    var variation: String?
    var bowmanFirst: Bool
    var grade: String
    var gradingCompany: String
    var quantity: Int
    var purchasePrice: Double
    var totalCostBasis: Double
    var purchaseDate: Date?
    var purchaseSource: String?
    var feesPaid: Double
    var taxPaid: Double
    var shippingPaid: Double
    var currentValue: Double
    var quickSaleValue: Double?
    var fairMarketValue: Double?
    var premiumValue: Double?
    var netEstimatedValue: Double?
    var totalProfitLoss: Double
    var totalProfitLossPct: Double
    var verdict: String
    var recommendation: String
    var trend: PortfolioTrend
    var riskLevel: PortfolioRiskLevel
    var marketSpeed: String
    var marketPressure: String
    var expectedDaysToSell: Int?
    var confidence: Double?
    var explanationBullets: [String]
    var freshnessStatus: FreshnessStatus
    var lastUpdated: Date
    var statusCategory: StatusCategory
    var notes: String?
}

enum PortfolioTrend: String, CaseIterable, Codable {
    case rising, stable, falling
}

enum PortfolioRiskLevel: String, CaseIterable, Codable {
    case low, medium, high
}

enum FreshnessStatus: String, CaseIterable, Codable {
    case live = "Live"
    case updatedToday = "Updated Today"
    case yesterday = "Yesterday"
    case needsRefresh = "Needs Refresh"
}

enum StatusCategory: String, CaseIterable, Codable {
    case strong, hold, sellWatch, risky, needsAttention, winner, loser, normal
}

// MARK: - Filter & Sort

enum PortfolioFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case winners = "Winners"
    case losers = "Losers"
    case sellWatch = "Sell Watch"
    case rising = "Rising"
    case risky = "Risky"
    var id: String { rawValue }
}

enum PortfolioSort: String, CaseIterable, Identifiable {
    case highestValue = "Highest Value"
    case lowestValue = "Lowest Value"
    case biggestGainDollar = "Biggest Gain $"
    case biggestGainPercent = "Biggest Gain %"
    case biggestLossDollar = "Biggest Loss $"
    case biggestLossPercent = "Biggest Loss %"
    case recentlyUpdated = "Recently Updated"
    case oldestUpdate = "Oldest Update"
    case bestSellCandidates = "Best Sell Candidates"
    case highestRisk = "Highest Risk"
    case alphabetical = "Alphabetical"
    case purchaseDateNewest = "Purchase Date (Newest)"
    case purchaseDateOldest = "Purchase Date (Oldest)"
    var id: String { rawValue }
}

// MARK: - Mock Data
extension PortfolioHolding {
    static let mockHoldings: [PortfolioHolding] = [
        PortfolioHolding(
            id: UUID(),
            playerName: "Elly De La Cruz",
            cardTitle: "2023 Bowman Chrome Orange Auto PSA 10",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Prospect Auto",
            product: "Orange",
            cardNumber: "BCP-101",
            parallel: "Orange",
            serialNumber: "/25",
            isAuto: true,
            isPatch: false,
            variation: nil,
            bowmanFirst: true,
            grade: "10",
            gradingCompany: "PSA",
            quantity: 1,
            purchasePrice: 900,
            totalCostBasis: 900,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -60, to: Date()),
            purchaseSource: "eBay",
            feesPaid: 45,
            taxPaid: 30,
            shippingPaid: 10,
            currentValue: 1700,
            quickSaleValue: 1600,
            fairMarketValue: 1700,
            premiumValue: 1800,
            netEstimatedValue: 1550,
            totalProfitLoss: 800,
            totalProfitLossPct: 88.9,
            verdict: "Strong hold — value is rising and demand is healthy.",
            recommendation: "Hold",
            trend: .rising,
            riskLevel: .low,
            marketSpeed: "Fast",
            marketPressure: "Low",
            expectedDaysToSell: 2,
            confidence: 0.95,
            explanationBullets: ["Value is up 32% from cost.", "Demand is strong.", "Market speed is healthy."],
            freshnessStatus: .live,
            lastUpdated: Date(),
            statusCategory: .strong,
            notes: "Pulled from pack."
        ),
        PortfolioHolding(
            id: UUID(),
            playerName: "Blake Burke",
            cardTitle: "2023 Bowman Chrome Base Auto Raw",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Base Auto",
            product: "Base",
            cardNumber: "BCP-55",
            parallel: nil,
            serialNumber: nil,
            isAuto: true,
            isPatch: false,
            variation: nil,
            bowmanFirst: true,
            grade: "Raw",
            gradingCompany: "",
            quantity: 2,
            purchasePrice: 120,
            totalCostBasis: 240,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -30, to: Date()),
            purchaseSource: "Card Show",
            feesPaid: 0,
            taxPaid: 0,
            shippingPaid: 0,
            currentValue: 180,
            quickSaleValue: 170,
            fairMarketValue: 180,
            premiumValue: 200,
            netEstimatedValue: 170,
            totalProfitLoss: 120,
            totalProfitLossPct: 50.0,
            verdict: "Sell watch — profit is strong, but market speed is slowing.",
            recommendation: "Sell Watch",
            trend: .stable,
            riskLevel: .medium,
            marketSpeed: "Slowing",
            marketPressure: "Medium",
            expectedDaysToSell: 7,
            confidence: 0.8,
            explanationBullets: ["Profit is strong.", "Market speed is slowing.", "Consider selling soon."],
            freshnessStatus: .updatedToday,
            lastUpdated: Calendar.current.date(byAdding: .hour, value: -3, to: Date())!,
            statusCategory: .sellWatch,
            notes: nil
        ),
        PortfolioHolding(
            id: UUID(),
            playerName: "Max Clark",
            cardTitle: "2023 Bowman Chrome Blue Wave PSA 9",
            cardYear: 2023,
            brand: "Bowman Chrome",
            setName: "Refractor",
            product: "Blue Wave",
            cardNumber: "BCP-77",
            parallel: "Blue Wave",
            serialNumber: "/150",
            isAuto: false,
            isPatch: false,
            variation: nil,
            bowmanFirst: false,
            grade: "9",
            gradingCompany: "PSA",
            quantity: 1,
            purchasePrice: 600,
            totalCostBasis: 600,
            purchaseDate: Calendar.current.date(byAdding: .day, value: -90, to: Date()),
            purchaseSource: "eBay",
            feesPaid: 30,
            taxPaid: 20,
            shippingPaid: 10,
            currentValue: 570,
            quickSaleValue: 550,
            fairMarketValue: 570,
            premiumValue: 600,
            netEstimatedValue: 530,
            totalProfitLoss: -30,
            totalProfitLossPct: -5.0,
            verdict: "Risk rising — value is slipping and supply is building.",
            recommendation: "Risk",
            trend: .falling,
            riskLevel: .high,
            marketSpeed: "Slow",
            marketPressure: "High",
            expectedDaysToSell: 14,
            confidence: 0.6,
            explanationBullets: ["Value is slipping.", "Supply is building.", "Risk is rising."],
            freshnessStatus: .needsRefresh,
            lastUpdated: Calendar.current.date(byAdding: .day, value: -2, to: Date())!,
            statusCategory: .risky,
            notes: nil
        )
    ]
}
