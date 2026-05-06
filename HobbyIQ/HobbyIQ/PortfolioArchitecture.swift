//
//  PortfolioArchitecture.swift
//  HobbyIQ
//

import Foundation

struct CardInput: Identifiable, Hashable {
    let id: UUID
    let playerName: String
    let cardName: String
    let cost: Double

    init(id: UUID = UUID(), playerName: String, cardName: String, cost: Double) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
    }
}

struct CardEstimate: Identifiable, Hashable {
    let id: UUID
    let playerName: String
    let cardName: String
    let estimatedValue: Double
    let confidence: String

    init(
        id: UUID = UUID(),
        playerName: String,
        cardName: String,
        estimatedValue: Double,
        confidence: String
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.estimatedValue = estimatedValue
        self.confidence = confidence
    }
}

struct InventoryCard: Identifiable, Hashable {
    let id: UUID
    let playerName: String
    let cardName: String
    let cost: Double
    let currentValue: Double
    let status: String
    let year: String
    let setName: String
    let parallel: String
    let grade: String

    init(
        id: UUID = UUID(),
        playerName: String,
        cardName: String,
        cost: Double,
        currentValue: Double,
        status: String,
        year: String = "",
        setName: String = "",
        parallel: String = "",
        grade: String = ""
    ) {
        self.id = id
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
        self.currentValue = currentValue
        self.status = status
        self.year = year
        self.setName = setName
        self.parallel = parallel
        self.grade = grade
    }

    var profitLoss: Double {
        currentValue - cost
    }
}

struct Sale: Identifiable, Hashable {
    let id: UUID
    let cardId: UUID
    let playerName: String
    let cardName: String
    let cost: Double
    let salePrice: Double
    let fees: Double
    let profit: Double
    let date: Date

    init(
        id: UUID = UUID(),
        cardId: UUID,
        playerName: String,
        cardName: String,
        cost: Double,
        salePrice: Double,
        fees: Double,
        profit: Double,
        date: Date
    ) {
        self.id = id
        self.cardId = cardId
        self.playerName = playerName
        self.cardName = cardName
        self.cost = cost
        self.salePrice = salePrice
        self.fees = fees
        self.profit = profit
        self.date = date
    }

    var margin: Double {
        salePrice > 0 ? profit / salePrice : 0
    }
}

protocol CompIQProvider {
    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate]
}

protocol PortfolioProvider {
    func getInventory() async -> [InventoryCard]
    func saveInventory(_ cards: [InventoryCard]) async
    func getSales() async -> [Sale]
    func saveSale(_ sale: Sale) async
}

final class LocalCompIQProvider: CompIQProvider {
    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate] {
        cards.map { card in
            let multiplier = stableMultiplier(for: card)
            return CardEstimate(
                playerName: card.playerName,
                cardName: card.cardName,
                estimatedValue: card.cost * multiplier,
                confidence: confidenceLabel(for: multiplier)
            )
        }
    }

    private func stableMultiplier(for card: CardInput) -> Double {
        let source = "\(card.playerName)|\(card.cardName)".unicodeScalars.map(\.value).reduce(0, +)
        let normalized = Double(source % 100) / 100
        return 1.2 + normalized
    }

    private func confidenceLabel(for multiplier: Double) -> String {
        switch multiplier {
        case ..<1.5:
            return "medium"
        case ..<1.9:
            return "good"
        default:
            return "high"
        }
    }
}

@MainActor
final class LocalPortfolioProvider: ObservableObject, PortfolioProvider {
    static let shared = LocalPortfolioProvider()

    @Published private var inventory: [InventoryCard]
    @Published private var sales: [Sale]

    init(
        inventory: [InventoryCard] = PortfolioSeedData.inventory,
        sales: [Sale] = PortfolioSeedData.sales
    ) {
        self.inventory = inventory
        self.sales = sales
    }

    func getInventory() async -> [InventoryCard] {
        inventory
    }

    func saveInventory(_ cards: [InventoryCard]) async {
        inventory = cards
    }

    func getSales() async -> [Sale] {
        sales
    }

    func saveSale(_ sale: Sale) async {
        sales.append(sale)
    }
}

final class CompIQService {
    let provider: CompIQProvider

    init(provider: CompIQProvider) {
        self.provider = provider
    }

    func bulkEstimate(cards: [CardInput]) async throws -> [CardEstimate] {
        try await provider.bulkEstimate(cards: cards)
    }
}

struct PortfolioPerformanceSnapshot {
    let totalSold: Double
    let totalProfit: Double
    let margin: Double

    static let empty = PortfolioPerformanceSnapshot(totalSold: 0, totalProfit: 0, margin: 0)
}

final class PortfolioService {
    let provider: PortfolioProvider

    init(provider: PortfolioProvider) {
        self.provider = provider
    }

    func getInventory() async -> [InventoryCard] {
        await provider.getInventory()
    }

    func saveInventory(_ cards: [InventoryCard]) async {
        await provider.saveInventory(cards)
    }

    func getSales() async -> [Sale] {
        await provider.getSales()
    }

    func addSale(card: InventoryCard, salePrice: Double, fees: Double) async {
        let profit = salePrice - card.cost - fees

        let sale = Sale(
            cardId: card.id,
            playerName: card.playerName,
            cardName: card.cardName,
            cost: card.cost,
            salePrice: salePrice,
            fees: fees,
            profit: profit,
            date: Date()
        )

        await provider.saveSale(sale)
    }

    func markCardAsSold(
        card: InventoryCard,
        salePrice: Double,
        fees: Double,
        date: Date
    ) async {
        let profit = salePrice - card.cost - fees

        let sale = Sale(
            cardId: card.id,
            playerName: card.playerName,
            cardName: card.cardName,
            cost: card.cost,
            salePrice: salePrice,
            fees: fees,
            profit: profit,
            date: date
        )

        let inventory = await provider.getInventory()
        let remaining = inventory.filter { $0.id != card.id }
        await provider.saveInventory(remaining)
        await provider.saveSale(sale)
    }

    func appendEstimatedCards(_ cards: [InventoryCard]) async {
        let existing = await provider.getInventory()
        await provider.saveInventory(existing + cards)
    }

    func calculateSummary(sales: [Sale]) -> (month: Double, year: Double) {
        let calendar = Calendar.current
        let now = Date()

        let monthly = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .month) &&
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }

        let yearly = sales.filter {
            calendar.isDate($0.date, equalTo: now, toGranularity: .year)
        }

        let monthlyProfit = monthly.reduce(0) { $0 + $1.profit }
        let yearlyProfit = yearly.reduce(0) { $0 + $1.profit }

        return (monthlyProfit, yearlyProfit)
    }

    func performanceSnapshot(for sales: [Sale], in period: PortfolioPeriod) -> PortfolioPerformanceSnapshot {
        let calendar = Calendar.current
        let now = Date()

        let filteredSales = sales.filter { sale in
            switch period {
            case .month:
                return calendar.isDate(sale.date, equalTo: now, toGranularity: .month) &&
                    calendar.isDate(sale.date, equalTo: now, toGranularity: .year)
            case .year:
                return calendar.isDate(sale.date, equalTo: now, toGranularity: .year)
            }
        }

        let totalSold = filteredSales.reduce(0) { $0 + $1.salePrice }
        let totalProfit = filteredSales.reduce(0) { $0 + $1.profit }
        let margin = totalSold > 0 ? totalProfit / totalSold : 0

        return PortfolioPerformanceSnapshot(
            totalSold: totalSold,
            totalProfit: totalProfit,
            margin: margin
        )
    }

    func exportInventoryCSV(cards: [InventoryCard]) throws -> URL {
        var csv = "Player Name,Year,Set,Card Name,Parallel,Grade,Cost,Current Value,Status\n"

        for card in cards {
            let row = [
                card.playerName.csvEscaped,
                card.year.csvEscaped,
                card.setName.csvEscaped,
                card.cardName.csvEscaped,
                card.parallel.csvEscaped,
                card.grade.csvEscaped,
                String(format: "%.2f", card.cost),
                String(format: "%.2f", card.currentValue),
                card.status.csvEscaped
            ].joined(separator: ",")

            csv.append(row)
            csv.append("\n")
        }

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("hobbyiq_inventory.csv")

        try csv.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
    }
}

enum PortfolioPeriod {
    case month
    case year
}

enum PortfolioSeedData {
    static let inventory: [InventoryCard] = [
        InventoryCard(
            playerName: "Roman Anthony",
            cardName: "Chrome Auto",
            cost: 225,
            currentValue: 468,
            status: "active",
            year: "2024",
            setName: "Bowman Chrome",
            parallel: "Base Auto",
            grade: "Raw"
        ),
        InventoryCard(
            playerName: "Leo De Vries",
            cardName: "Blue Refractor",
            cost: 140,
            currentValue: 118,
            status: "active",
            year: "2024",
            setName: "Bowman Sapphire",
            parallel: "Blue Refractor",
            grade: "PSA 10"
        ),
        InventoryCard(
            playerName: "Paul Skenes",
            cardName: "Draft Refractor",
            cost: 310,
            currentValue: 515,
            status: "active",
            year: "2023",
            setName: "Bowman Draft Chrome",
            parallel: "Refractor",
            grade: "PSA 9"
        )
    ]

    static let sales: [Sale] = [
        Sale(
            cardId: UUID(),
            playerName: "Junior Caminero",
            cardName: "Gold Chrome",
            cost: 180,
            salePrice: 325,
            fees: 22,
            profit: 123,
            date: Calendar.current.date(byAdding: .day, value: -8, to: .now) ?? .now
        ),
        Sale(
            cardId: UUID(),
            playerName: "Walker Jenkins",
            cardName: "Chrome Auto",
            cost: 145,
            salePrice: 240,
            fees: 16,
            profit: 79,
            date: Calendar.current.date(byAdding: .day, value: -20, to: .now) ?? .now
        ),
        Sale(
            cardId: UUID(),
            playerName: "Jackson Holliday",
            cardName: "Draft Sapphire",
            cost: 260,
            salePrice: 235,
            fees: 18,
            profit: -43,
            date: Calendar.current.date(byAdding: .month, value: -2, to: .now) ?? .now
        )
    ]
}

private extension String {
    var csvEscaped: String {
        let escaped = replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}
