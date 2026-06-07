//
//  PortfolioArchitecture.swift
//  HobbyIQ
//

import Combine
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

struct InventoryCard: Identifiable, Hashable, Codable {
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
    // CF-AUTOPRICE-GRADE-CONTRACT (2026-05-27): canonical structured grade
    // fields. `gradeCompany` ("PSA", "BGS", "SGC", "CGC") and `gradeValue`
    // (Double — supports decimal BGS/CSG grades like 9.5/8.5 alongside
    // integer PSA grades) replace the joined `grade` label string as
    // the source of truth for grade-aware pricing. The legacy `grade`
    // string remains on the wire for display compatibility.
    //
    // Backend autoPriceHolding reads gradingCompany ?? gradeCompany and
    // gradeValue directly — without these fields, /api/compiq/estimate
    // searches the raw/ungraded comp bucket regardless of the user's
    // actual slab grade. See cardsight.translator.ts:31-99.
    //
    // gradeValue MUST be Double (not Int) — Int? loses the fractional
    // on BGS 9.5 / CSG 8.5 grades AND crashes JSONDecoder when the
    // backend sends a decimal number (Swift's strict decoder rejects
    // "Parsed JSON number 9.5 does not fit in Int"). Backend type
    // contract is `number`; Double matches and the cardsight translator
    // does `String(...).trim()` to coerce for match against Cardsight's
    // `grade_value` string field.
    //
    // Optional with default nil to preserve backward compat for existing
    // call sites that haven't been threaded through yet.
    let gradeCompany: String?
    let gradeValue: Double?
    let purchaseDate: String?
    let purchasePlatform: String?
    let quantity: Double?
    let notes: String?
    let imageFrontUrl: String?
    let imageBackUrl: String?
    let lowValue: Double?
    let highValue: Double?
    let confidence: Double?
    let method: String?
    let summary: String?
    var isAuto: Bool = false

    // PR B: photo-storage-sas schema additions
    let photos: [String]?
    let clientId: String?

    // Prediction fields (CF-NEXT-SALE-PREDICTION-LAYER)
    let predictedPrice: Double?
    let predictedPriceLow: Double?
    let predictedPriceHigh: Double?
    let predictedPriceMechanism: String?
    let predictedPriceUpdatedAt: String?

    // Anchor field (already persisted backend-side)
    let fairMarketValue: Double?

    // Movement fields (CF-AUTOPRICE-PERSIST-TRENDIQ)
    let movementDirection: String?
    let movementComposite: Double?
    let movementImpliedPct: Double?
    let movementCoverage: String?
    let movementUpdatedAt: String?

    /// Cardsight catalog UUID resolved at identify / cert-resolve time. When
    /// present, the backend can comp the holding without re-matching from
    /// text fields. Optional + backward-compatible: legacy holdings decode
    /// with this as nil and continue to work via text-based matching.
    let cardsightCardId: String?

    // The Codable conformance + CodingKeys for InventoryCard live in the
    // extension at CompatibilityShims.swift:1584 — that extension defines
    // its own custom init(from:) which wins over any struct-level synthesized
    // implementation. Adding CodingKeys here would be dead code (the wire-
    // shape aliases are applied inside that extension's init).

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
        grade: String = "",
        gradeCompany: String? = nil,
        gradeValue: Double? = nil,
        purchaseDate: String? = nil,
        purchasePlatform: String? = nil,
        quantity: Double? = nil,
        notes: String? = nil,
        imageFrontUrl: String? = nil,
        imageBackUrl: String? = nil,
        lowValue: Double? = nil,
        highValue: Double? = nil,
        confidence: Double? = nil,
        method: String? = nil,
        summary: String? = nil,
        isAuto: Bool = false,
        photos: [String]? = nil,
        clientId: String? = nil,
        predictedPrice: Double? = nil,
        predictedPriceLow: Double? = nil,
        predictedPriceHigh: Double? = nil,
        predictedPriceMechanism: String? = nil,
        predictedPriceUpdatedAt: String? = nil,
        fairMarketValue: Double? = nil,
        movementDirection: String? = nil,
        movementComposite: Double? = nil,
        movementImpliedPct: Double? = nil,
        movementCoverage: String? = nil,
        movementUpdatedAt: String? = nil,
        cardsightCardId: String? = nil
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
        self.gradeCompany = gradeCompany
        self.gradeValue = gradeValue
        self.purchaseDate = purchaseDate
        self.purchasePlatform = purchasePlatform
        self.quantity = quantity
        self.notes = notes
        self.imageFrontUrl = imageFrontUrl
        self.imageBackUrl = imageBackUrl
        self.lowValue = lowValue
        self.highValue = highValue
        self.confidence = confidence
        self.method = method
        self.summary = summary
        self.isAuto = isAuto
        self.photos = photos
        self.clientId = clientId
        self.predictedPrice = predictedPrice
        self.predictedPriceLow = predictedPriceLow
        self.predictedPriceHigh = predictedPriceHigh
        self.predictedPriceMechanism = predictedPriceMechanism
        self.predictedPriceUpdatedAt = predictedPriceUpdatedAt
        self.fairMarketValue = fairMarketValue
        self.movementDirection = movementDirection
        self.movementComposite = movementComposite
        self.movementImpliedPct = movementImpliedPct
        self.movementCoverage = movementCoverage
        self.movementUpdatedAt = movementUpdatedAt
        self.cardsightCardId = cardsightCardId
    }

    var profitLoss: Double {
        currentValue - cost
    }
}

struct Sale: Identifiable, Hashable, Codable {
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

    private static let inventoryKey = "hiq.local.inventory"
    private static let salesKey = "hiq.local.sales"

    @Published private var inventory: [InventoryCard]
    @Published private var sales: [Sale]

    init(
        inventory: [InventoryCard]? = nil,
        sales: [Sale]? = nil
    ) {
        if let inventory {
            self.inventory = inventory
        } else {
            self.inventory = Self.loadFromDisk(key: Self.inventoryKey) ?? []
        }
        if let sales {
            self.sales = sales
        } else {
            self.sales = Self.loadFromDisk(key: Self.salesKey) ?? []
        }
    }

    func getInventory() async -> [InventoryCard] {
        inventory
    }

    func saveInventory(_ cards: [InventoryCard]) async {
        inventory = cards
        Self.saveToDisk(cards, key: Self.inventoryKey)
    }

    func getSales() async -> [Sale] {
        sales
    }

    func saveSale(_ sale: Sale) async {
        sales.append(sale)
        Self.saveToDisk(sales, key: Self.salesKey)
    }

    // MARK: - Disk Persistence

    private static func saveToDisk<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    private static func loadFromDisk<T: Decodable>(key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
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
        let margin = totalSold > 0 ? (totalProfit / totalSold) * 100 : 0

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

private extension String {
    var csvEscaped: String {
        let escaped = replacingOccurrences(of: "\"", with: "\"\"")
        return "\"\(escaped)\""
    }
}
