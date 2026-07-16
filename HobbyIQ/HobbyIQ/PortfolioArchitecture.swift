//
//  PortfolioArchitecture.swift
//  HobbyIQ
//

import Combine
import Foundation
import SwiftUI

/// CF-IOS-GRADER-STATUS-UI (2026-06-28): backend's persisted grader-status
/// bucket on each holding. Three real states power the dropdown today:
/// `available` (in-hand), `atPsa` (sent in for grading), `pendingRedemption`
/// (graded but waiting for slab pickup). Backend type retains a 4th
/// `in_route` for forward-compat but iOS deliberately omits it — no rows
/// use it and surfacing it would clutter the picker.
enum GraderStatus: String, Codable, Hashable, CaseIterable, Identifiable {
    case available
    case atPsa = "at_psa"
    case pendingRedemption = "pending_redemption"

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .available:          return "Available"
        case .atPsa:              return "At PSA"
        case .pendingRedemption:  return "Pending Redemption"
        }
    }

    var tintColor: Color {
        switch self {
        case .available:          return HobbyIQTheme.Colors.mutedText
        case .atPsa:              return HobbyIQTheme.Colors.electricBlue
        case .pendingRedemption:  return .orange
        }
    }
}

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

/// CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): per-grade anchor sale the
/// backend ladder fallback uses when computing an estimated FMV. Renders
/// in the detail view as "Anchor: PSA 9 $755, today" or, for raw anchors,
/// "Last sold: $1185 raw, 4 days ago". `confidence` is 0.0–1.0 (engine-
/// internal), not currently surfaced.
struct NearestGradedAnchor: Codable, Hashable {
    let grade: String
    let price: Double
    let daysOld: Int
    let sampleSize: Int
    let confidence: Double
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
    /// CF-INVENTORY-CATALOG-IMAGE (2026-07-05): backend-served card
    /// image (same CDN URL the comp-card hero uses). Populated on
    /// holdings the engine has resolved to a Cardsight catalog card.
    /// Rendered as the inventory row/grid thumbnail whenever the
    /// user hasn't uploaded their own `imageFrontUrl` photo. Nil on
    /// legacy or unmatched holdings; view falls through to the
    /// initials/photo-glyph placeholder.
    let catalogImageUrl: String?
    /// CF-ACTION-BADGES (2026-07-06, backend §1): per-holding
    /// seller-facing verdict. Named `actionRecommendation` (NOT
    /// `recommendation`) because a legacy `recommendation: String`
    /// field is already on the wire for backward-compat. iOS must
    /// read this new one; the old one is ignored.
    let actionRecommendation: CardPanelGradeEntry.ActionRecommendation?
    /// CF-HOLDING-REGRADE (2026-07-06, PR #294): PSA/BGS/SGC/CGC cert
    /// number. Always on the wire per backend regression tests; iOS
    /// was silently dropping it. Round-trips through the
    /// `/regrade` endpoint. Nil for raw / legacy holdings.
    let certNumber: String?
    let lowValue: Double?
    let highValue: Double?
    let confidence: Double?
    let method: String?
    let summary: String?
    var isAuto: Bool = false
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): backend-persisted grader bucket.
    /// `available` is the default; missing/null on the wire decodes to it.
    var graderStatus: GraderStatus = .available

    // PR B: photo-storage-sas schema additions
    let photos: [String]?
    let clientId: String?

    // CF-IOS-DIRECTION-SWEEP (2026-06-18) — HISTORICAL: predictedPrice*
    // fields were removed here because backtest showed direction was at-
    // chance. Comment said "Do NOT re-add fields here without a matching
    // backend wire-shape CF."
    //
    // CF-COMP-HOLDING-WIRE-PARITY (audit PR #482 + PR #484, 2026-07-15):
    // the matching backend wire-shape CF landed in #482 — the holding
    // wire now carries `marketValue`, `fairMarketValueLive`,
    // `predictedPrice`, `predictedPriceRange`, `predictedPriceAttribution`
    // etc. Drew's whole-app audit explicitly asked for holding views to
    // render the same fields as comp cards ("Override CF-IOS-DIRECTION-
    // SWEEP for the parity work" — chosen 2026-07-15). Re-adding the
    // fields here so the shared PricingPanelView (PR #485) can render
    // them uniformly across inventory-detail and comp-detail surfaces.
    //
    // Every field is optional + nullable — legacy wires that predate
    // #482 decode as nil (existing behavior). Direction concern is
    // acknowledged; UX call is Drew's per the override decision.

    // Anchor field (already persisted backend-side)
    let fairMarketValue: Double?
    /// CF-COMP-HOLDING-WIRE-PARITY (PR #482, 2026-07-15): alias of
    /// fairMarketValue that comp routes emit. Both fields carry the
    /// same number; PricingPanelView reads whichever is populated.
    let marketValue: Double?
    let fairMarketValueLive: Double?
    /// CF-COMP-HOLDING-WIRE-PARITY (PR #484, 2026-07-15): forward-
    /// looking predicted next-sale value + range + mechanism +
    /// timestamp. Populated from the estimate's engine response
    /// through composeHoldingWireShape's flat pair; iOS renders the
    /// same Predicted Next Price row CompIQPricedCardView shows.
    let predictedPrice: Double?
    let predictedPriceLow: Double?
    let predictedPriceHigh: Double?
    let predictedPriceMechanism: String?
    let predictedPriceUpdatedAt: String?

    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): backend valuation bucket.
    // "observed" → row has comp-anchored FMV (fairMarketValue is set).
    // "estimated" → row has a model estimate but no observed comp (fmv=nil,
    //   estimateLow/High would carry the band — not decoded on iOS yet).
    // "pending" → no estimate at all (fmv=nil, no estimate fields).
    // nil → legacy wire row pre-Step-1; treat as pending when fmv is also nil.
    //
    // Used ONLY for the inventory hero's "N estimated · M pending" subtitle
    // count split — Story B's display-only contract holds: every row with
    // fairMarketValue == nil still renders "—" regardless of bucket. The
    // collection-value card is the surface that includes the estimated
    // bucket in its headline.
    let valuationStatus: String?

    /// CF-IOS-NEAREST-GRADED-ANCHOR-UI (2026-06-29): backend ladder-fallback
    /// fields populated on holdings the engine couldn't observe directly.
    /// `estimatedValue` is the ladder-derived FMV; `estimateBasis` is the
    /// engine's human-readable provenance prose surfaced in the detail
    /// view's "Why this estimate" disclosure. `nearestGradedAnchor`
    /// carries the anchor sale itself for the row's context caption.
    let estimatedValue: Double?
    let estimateLow: Double?
    let estimateHigh: Double?
    let estimateBasis: String?
    let estimateConfidence: String?
    let nearestGradedAnchor: NearestGradedAnchor?

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): movement* fields removed —
    // direction-class signals every render site of which was stripped
    // in this same CF. Wire keys silently ignored on decode.

    /// Cardsight catalog UUID resolved at identify / cert-resolve time. When
    /// present, the backend can comp the holding without re-matching from
    /// text fields. Optional + backward-compatible: legacy holdings decode
    /// with this as nil and continue to work via text-based matching.
    let cardId: String?

    /// CF-IOS-MODEL-SIGNAL-RENDER (2026-06-26): LiveMarket headline +
    /// model-line + lean-badge wire fields surfaced on the holdings
    /// list. All three independently optional — render whichever blocks
    /// arrive populated. `lastSaleSurface` uses `date` (not `soldDate`)
    /// per the holding wire contract; the view layer maps it to a
    /// shared display value.
    let lastSaleSurface: LiveMarketLastSaleSurface?
    let modelExpectation: LiveMarketModelExpectation?
    let modelSignal: LiveMarketModelSignal?

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
        catalogImageUrl: String? = nil,
        actionRecommendation: CardPanelGradeEntry.ActionRecommendation? = nil,
        certNumber: String? = nil,
        lowValue: Double? = nil,
        highValue: Double? = nil,
        confidence: Double? = nil,
        method: String? = nil,
        summary: String? = nil,
        isAuto: Bool = false,
        graderStatus: GraderStatus = .available,
        photos: [String]? = nil,
        clientId: String? = nil,
        fairMarketValue: Double? = nil,
        valuationStatus: String? = nil,
        estimatedValue: Double? = nil,
        estimateLow: Double? = nil,
        estimateHigh: Double? = nil,
        estimateBasis: String? = nil,
        estimateConfidence: String? = nil,
        nearestGradedAnchor: NearestGradedAnchor? = nil,
        cardId: String? = nil,
        lastSaleSurface: LiveMarketLastSaleSurface? = nil,
        modelExpectation: LiveMarketModelExpectation? = nil,
        modelSignal: LiveMarketModelSignal? = nil,
        // CF-COMP-HOLDING-WIRE-PARITY (PR #484, 2026-07-15): parity fields.
        // All default to nil so existing callers of this memberwise init
        // don't break — additive across the entire signature.
        marketValue: Double? = nil,
        fairMarketValueLive: Double? = nil,
        predictedPrice: Double? = nil,
        predictedPriceLow: Double? = nil,
        predictedPriceHigh: Double? = nil,
        predictedPriceMechanism: String? = nil,
        predictedPriceUpdatedAt: String? = nil
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
        self.catalogImageUrl = catalogImageUrl
        self.actionRecommendation = actionRecommendation
        self.certNumber = certNumber
        self.lowValue = lowValue
        self.highValue = highValue
        self.confidence = confidence
        self.method = method
        self.summary = summary
        self.isAuto = isAuto
        self.graderStatus = graderStatus
        self.photos = photos
        self.clientId = clientId
        self.fairMarketValue = fairMarketValue
        self.valuationStatus = valuationStatus
        self.estimatedValue = estimatedValue
        self.estimateLow = estimateLow
        self.estimateHigh = estimateHigh
        self.estimateBasis = estimateBasis
        self.estimateConfidence = estimateConfidence
        self.nearestGradedAnchor = nearestGradedAnchor
        self.cardId = cardId
        self.lastSaleSurface = lastSaleSurface
        self.modelExpectation = modelExpectation
        self.modelSignal = modelSignal
        // CF-COMP-HOLDING-WIRE-PARITY (PR #484): parity fields.
        self.marketValue = marketValue
        self.fairMarketValueLive = fairMarketValueLive
        self.predictedPrice = predictedPrice
        self.predictedPriceLow = predictedPriceLow
        self.predictedPriceHigh = predictedPriceHigh
        self.predictedPriceMechanism = predictedPriceMechanism
        self.predictedPriceUpdatedAt = predictedPriceUpdatedAt
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
