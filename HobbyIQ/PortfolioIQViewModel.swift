//
//  PortfolioIQViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation
import UIKit
import os

@MainActor
final class PortfolioIQViewModel: ObservableObject {
    @Published private(set) var summary: PortfolioSummaryResponse?
    @Published private(set) var inventoryCards: [InventoryCard] = [] {
        didSet { recomputeCachedProperties() }
    }
    @Published private(set) var salesHistory: [Sale] = []
    @Published private(set) var apiLedgerEntries: [PortfolioLedgerEntry]?
    @Published private(set) var ledgerTotals: PortfolioLedgerTotals?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var pendingInventoryFilter: PortfolioInventoryFilter?

    // Cached derived data — recomputed only when inventoryCards changes
    @Published private(set) var cachedPriorityActions: [PortfolioPriorityAction] = []
    @Published private(set) var cachedTopMovers: [PortfolioMover] = []

    private let service: APIService
    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "portfolio")

    init(service: APIService, initialSummary: PortfolioSummaryResponse? = nil) {
        self.service = service
        self.summary = initialSummary
        self.inventoryCards = []
    }

    convenience init(initialSummary: PortfolioSummaryResponse? = nil) {
        self.init(service: APIService.shared, initialSummary: initialSummary)
    }

    var inventorySummary: PortfolioInventorySummary? {
        summary?.inventory
    }

    var accountSnapshot: PortfolioAccountSnapshot? {
        summary?.accountSnapshot
    }

    var inventoryDetails: [PortfolioCardDetail] {
        summary?.inventoryDetails ?? []
    }

    var bestCardsToSellNow: [PortfolioBestSellCard] {
        summary?.bestCardsToSellNow ?? []
    }

    var monthStats: PortfolioPeriodStats? {
        summary?.month
    }

    var yearStats: PortfolioPeriodStats? {
        summary?.year
    }

    var heroSummary: PortfolioHeroSummary {
        let inventory = inventorySummary ?? PortfolioInventorySummary(
            totalCost: 0,
            totalCurrentValue: 0,
            totalProfitLoss: 0,
            roi: 0,
            activeCount: inventoryCards.count
        )

        return PortfolioHeroSummary(
            totalCards: accountSnapshot?.totalCards ?? inventory.activeCount,
            totalValue: accountSnapshot?.totalValue ?? inventory.totalCurrentValue,
            costBasis: accountSnapshot?.totalCost ?? inventory.totalCost,
            unrealizedPnL: accountSnapshot?.totalProfitLoss ?? inventory.totalProfitLoss,
            roi: accountSnapshot?.roi ?? inventory.roi,
            lastRefreshText: accountSnapshot?.generatedAtFormatted ?? "—"
        )
    }

    var priorityActions: [PortfolioPriorityAction] { cachedPriorityActions }

    var topMovers: [PortfolioMover] { cachedTopMovers }

    private func recomputeCachedProperties() {
        // Priority actions
        let sellWatch = bestCardsToSellNow.prefix(3).map { $0.playerName }
        let negativeCards = inventoryCards.filter { $0.profitLoss < 0 }.prefix(3)
        let staleCards = inventoryCards.filter { $0.freshnessChipText == "Stale" }.prefix(3)

        var actions: [PortfolioPriorityAction] = []

        if sellWatch.isEmpty == false {
            actions.append(
                PortfolioPriorityAction(
                    id: "sell-watch",
                    kind: .sellWatch,
                    title: "Sell-watch cards",
                    subtitle: sellWatch.joined(separator: ", "),
                    detail: "\(bestCardsToSellNow.count) cards are already flagged in the sell queue.",
                    cardCount: bestCardsToSellNow.count
                )
            )
        }

        if negativeCards.isEmpty == false {
            actions.append(
                PortfolioPriorityAction(
                    id: "high-risk",
                    kind: .highRisk,
                    title: "High risk cards",
                    subtitle: negativeCards.map(\.playerName).joined(separator: ", "),
                    detail: "\(negativeCards.count) cards are currently underwater.",
                    cardCount: negativeCards.count
                )
            )
        }

        if staleCards.isEmpty == false {
            actions.append(
                PortfolioPriorityAction(
                    id: "stale-pricing",
                    kind: .stalePricing,
                    title: "Stale pricing cards",
                    subtitle: staleCards.map(\.playerName).joined(separator: ", "),
                    detail: "\(staleCards.count) cards need a fresh comp check.",
                    cardCount: staleCards.count
                )
            )
        }

        cachedPriorityActions = actions

        // Top movers
        let gainers = inventoryCards
            .sorted { $0.profitLoss > $1.profitLoss }
            .prefix(3)
            .map { card in
                PortfolioMover(
                    id: "gain-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    trendLabel: "Gainer",
                    trendDetail: card.trendChipText
                )
            }

        let losers = inventoryCards
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .map { card in
                PortfolioMover(
                    id: "loss-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    trendLabel: "Loser",
                    trendDetail: card.trendChipText
                )
            }

        cachedTopMovers = Array(gainers) + Array(losers)
    }



    var ledgerEntries: [PortfolioLedgerEntry] {
        if let api = apiLedgerEntries { return api }
        return salesHistory
            .sorted { $0.date > $1.date }
            .prefix(10)
            .enumerated()
            .map { index, sale in PortfolioLedgerEntry(fromSale: sale, index: index) }
    }

    func fetchLedger() async {
        do {
            let response = try await service.fetchPortfolioLedger()
            apiLedgerEntries = response.entries ?? []
            ledgerTotals = response.totals
        } catch {
            logger.error("Ledger fetch failed, falling back to local sales: \(error.localizedDescription, privacy: .public)")
        }
    }

    func dismissLedgerEntry(id: String, reason: String?) async throws {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = LedgerPatchBody(
            dismissedAt: .some(ISO8601DateFormatter().string(from: Date())),
            dismissedReason: .some(trimmed?.isEmpty == false ? trimmed : nil)
        )
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    func undismissLedgerEntry(id: String) async throws {
        let body = LedgerPatchBody(
            dismissedAt: .some(nil),
            dismissedReason: .some(nil)
        )
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    func updateLedgerEntryCosts(id: String, gradingCost: Double??, suppliesCost: Double??) async throws {
        let body = LedgerPatchBody(gradingCost: gradingCost, suppliesCost: suppliesCost)
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    private func replaceEntry(_ updated: PortfolioLedgerEntry) {
        guard var entries = apiLedgerEntries,
              let idx = entries.firstIndex(where: { $0.id == updated.id }) else { return }
        entries[idx] = updated
        apiLedgerEntries = entries
    }

    func exportLedgerCSV(includeUnreconciled: Bool) -> URL? {
        let entries = ledgerEntries
        let filtered = includeUnreconciled ? entries : entries.filter { $0.needsReconciliation != true }

        var lines: [String] = []
        let header = [
            "Date", "Player", "Card", "Source", "Sale Price", "Gross Proceeds",
            "Final Value Fee", "Payment Processing Fee", "Promoted Listing Fee",
            "Ad Fee", "Shipping Cost", "Other Fees", "Total Fees",
            "Net Proceeds", "Cost Basis", "Grading Cost", "Supplies Cost",
            "Realized P&L", "ROI %", "Needs Reconciliation"
        ].map { csvEscape($0) }.joined(separator: ",")
        lines.append(header)

        let isoFmt = ISO8601DateFormatter()
        isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoStd = ISO8601DateFormatter()
        isoStd.formatOptions = [.withInternetDateTime]
        let dateFmt = DateFormatter()
        dateFmt.dateFormat = "yyyy-MM-dd"

        for entry in filtered {
            let dateStr: String = {
                guard let soldAt = entry.soldAt, !soldAt.isEmpty,
                      let date = isoFmt.date(from: soldAt) ?? isoStd.date(from: soldAt) else {
                    return entry.dateText
                }
                return dateFmt.string(from: date)
            }()

            let unreconciledFlag = (includeUnreconciled && entry.needsReconciliation == true) ? "YES" : ""

            let row = [
                csvEscape(dateStr),
                csvEscape(entry.playerName),
                csvEscape(entry.cardName),
                csvEscape(entry.source ?? "manual"),
                csvNum(entry.unitSalePrice),
                csvNum(entry.grossProceeds),
                csvNum(entry.finalValueFee),
                csvNum(entry.paymentProcessingFee),
                csvNum(entry.promotedListingFee),
                csvNum(entry.adFee),
                csvNum(entry.actualShippingCost),
                csvNum(entry.otherFees),
                csvNum(entry.totalGranularFees),
                csvNum(entry.netProceeds),
                csvNum(entry.costBasisSold),
                csvNum(entry.gradingCost),
                csvNum(entry.suppliesCost),
                csvNum(entry.realizedProfitLoss),
                entry.realizedProfitLossPct.map { String(format: "%.2f", $0) } ?? "",
                unreconciledFlag
            ].joined(separator: ",")
            lines.append(row)
        }

        let csv = lines.joined(separator: "\n")
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("hobbyiq_tax_export_\(dateFmt.string(from: Date())).csv")
        do {
            try csv.write(to: fileURL, atomically: true, encoding: .utf8)
            return fileURL
        } catch {
            logger.error("CSV export failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func csvEscape(_ value: String) -> String {
        if value.contains(",") || value.contains("\"") || value.contains("\n") {
            return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
        }
        return value
    }

    private func csvNum(_ value: Double?) -> String {
        guard let value else { return "" }
        return String(format: "%.2f", value)
    }

    func load() async {
        async let _ = fetchLedger()
        await fetch(preserveExistingSummaryOnError: false)
    }

    private func userFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }

    func refresh() async {
        await fetch(preserveExistingSummaryOnError: true)
    }

    func removeHolding(_ card: InventoryCard) async -> Bool {
        let userId = resolvedUserId()
        let currentInventory = inventoryCards.isEmpty ? await LocalPortfolioProvider.shared.getInventory() : inventoryCards
        let remaining = currentInventory.filter { $0.id != card.id }

        inventoryCards = remaining
        summary = Self.composeSummary(
            backendSummary: nil,
            holdings: remaining,
            userId: userId
        )
        await LocalPortfolioProvider.shared.saveInventory(remaining)

        do {
            _ = try await service.removePortfolioHolding(userId: userId, cardId: card.id.uuidString)
            return true
        } catch {
            errorMessage = "Removed from this device. Live portfolio sync failed."
            logger.error("Remove holding sync failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return true
        }
    }

    func markHoldingSold(_ card: InventoryCard, salePrice: Double, fees: Double, date: Date) async -> Bool {
        let userId = resolvedUserId()

        do {
            _ = try await service.markPortfolioHoldingSold(
                userId: userId,
                cardId: card.id.uuidString,
                salePrice: salePrice,
                fees: fees,
                date: date
            )
            await PortfolioService(provider: LocalPortfolioProvider.shared).markCardAsSold(
                card: card,
                salePrice: salePrice,
                fees: fees,
                date: date
            )
            await fetch(preserveExistingSummaryOnError: true)
            return true
        } catch {
            await PortfolioService(provider: LocalPortfolioProvider.shared).markCardAsSold(
                card: card,
                salePrice: salePrice,
                fees: fees,
                date: date
            )
            await fetch(preserveExistingSummaryOnError: true)
            errorMessage = "Live sale save failed. Updated cached inventory instead."
            logger.error("Mark sold sync failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return true
        }
    }

    func previewEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> PortfolioEbayListingResponse? {
        await submitEbayListing(
            card: card,
            request: request,
            pathKind: .draft
        )
    }

    func publishEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> PortfolioEbayListingResponse? {
        await submitEbayListing(
            card: card,
            request: request,
            pathKind: .listing
        )
    }

    func createEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> Bool {
        guard let response = await publishEbayListing(for: card, request: request) else { return false }
        return response.success ?? true
    }

    func uploadCardPhoto(
        for card: InventoryCard,
        image: UIImage,
        side: CardPhotoSide
    ) async -> CardPhotoUploadResponse? {
        guard let sessionId = resolvedSessionId() else {
            errorMessage = "Sign in to upload card photos."
            return nil
        }

        guard let payload = CardPhotoFormat.payload(for: image) else {
            errorMessage = "Could not process that photo."
            return nil
        }

        do {
            let response = try await APIService.shared.uploadCardPhoto(
                imageData: payload.data,
                mimeType: payload.mimeType,
                side: side,
                sessionId: sessionId
            )

            let updatedCard = InventoryCard(
                id: card.id,
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                status: card.status,
                year: card.year,
                setName: card.setName,
                parallel: card.parallel,
                grade: card.grade,
                purchaseDate: card.purchaseDate,
                purchasePlatform: card.purchasePlatform,
                quantity: card.quantity,
                notes: card.notes,
                imageFrontUrl: side == .front ? response.resolvedURL : card.imageFrontUrl,
                imageBackUrl: side == .back ? response.resolvedURL : card.imageBackUrl,
                lowValue: card.lowValue,
                highValue: card.highValue,
                confidence: card.confidence,
                method: card.method,
                summary: card.summary,
                isAuto: card.isAuto,
                photos: card.photos,
                clientId: card.clientId
            )

            let currentInventory = inventoryCards.isEmpty ? await LocalPortfolioProvider.shared.getInventory() : inventoryCards
            let updatedInventory = currentInventory.map { $0.id == card.id ? updatedCard : $0 }
            inventoryCards = updatedInventory
            await LocalPortfolioProvider.shared.saveInventory(updatedInventory)
            return response
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            logger.error("Card photo upload failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private enum EbayListingPathKind {
        case draft
        case listing
    }

    private func submitEbayListing(
        card: InventoryCard,
        request: PortfolioEbayListingRequest,
        pathKind: EbayListingPathKind
    ) async -> PortfolioEbayListingResponse? {
        let sessionId = resolvedSessionId()

        do {
            let response: PortfolioEbayListingResponse
            switch pathKind {
            case .draft:
                response = try await service.ebayPreviewListing(
                    body: request,
                    sessionId: sessionId
                )
            case .listing:
                response = try await service.ebayPublishListing(
                    body: request,
                    sessionId: sessionId
                )
            }

            if let message = response.message, message.isEmpty == false {
                errorMessage = message
            } else {
                errorMessage = nil
            }

            return response
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            logger.error("eBay listing request failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func resolvedSessionId() -> String? {
        let candidates = [
            AuthService.shared.session?.token,
            UserDefaults.standard.string(forKey: "auth.sessionId")
        ]

        for candidate in candidates {
            let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty == false {
                return value
            }
        }

        return nil
    }

    private func fetch(preserveExistingSummaryOnError: Bool) async {
        guard isLoading == false else { return }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let userId = resolvedUserId()
        let cachedHoldings = await LocalPortfolioProvider.shared.getInventory()
        let cachedSales = await LocalPortfolioProvider.shared.getSales()
        var fetchedHoldings: [InventoryCard] = cachedHoldings
        var backendSummary: PortfolioIQBackendSummaryResponse?
        var loadMessages: [String] = []
        var didLoadLiveHoldings = false

        if cachedHoldings.isEmpty == false, preserveExistingSummaryOnError == false || summary == nil {
            inventoryCards = cachedHoldings
            summary = Self.composeSummary(
                backendSummary: nil,
                holdings: cachedHoldings,
                userId: userId
            )
        }

        do {
            let liveHoldings = try await service.fetchPortfolioHoldings(userId: userId)
            didLoadLiveHoldings = true
            // Guard against the API returning empty when we already have data
            if liveHoldings.isEmpty, preserveExistingSummaryOnError, !inventoryCards.isEmpty {
                loadMessages.append("Live data returned empty. Keeping your current inventory.")
            } else {
                fetchedHoldings = liveHoldings
            }
            // Derive summary from holdings instead of separate API call
            let totalCost = fetchedHoldings.reduce(0) { $0 + $1.cost }
            let totalValue = fetchedHoldings.reduce(0) { $0 + $1.currentValue }
            let totalPL = totalValue - totalCost
            let roi = totalCost > 0 ? (totalPL / totalCost) * 100 : 0
            backendSummary = PortfolioIQBackendSummaryResponse(
                inventory: PortfolioInventorySummary(
                    totalCost: totalCost,
                    totalCurrentValue: totalValue,
                    totalProfitLoss: totalPL,
                    roi: roi,
                    activeCount: fetchedHoldings.count
                ),
                month: nil,
                year: nil
            )
        } catch {
            logger.error("Portfolio holdings load failed: \(error.localizedDescription, privacy: .public)")
            if cachedHoldings.isEmpty {
                fetchedHoldings = await LocalPortfolioProvider.shared.getInventory()
            }
            loadMessages.append("Live holdings unavailable. Showing cached portfolio data.")
        }

        if fetchedHoldings.isEmpty {
            // During refresh, don't wipe existing inventory if we already have cards
            if preserveExistingSummaryOnError, !inventoryCards.isEmpty {
                salesHistory = cachedSales
                if loadMessages.isEmpty == false {
                    errorMessage = loadMessages.joined(separator: " ")
                }
                return
            }
            inventoryCards = []
            salesHistory = cachedSales
            summary = Self.composeSummary(
                backendSummary: backendSummary,
                holdings: [],
                userId: userId
            )
            if didLoadLiveHoldings == false {
                if preserveExistingSummaryOnError == false {
                    errorMessage = loadMessages.isEmpty ? "Could not load PortfolioIQ right now." : loadMessages.joined(separator: " ")
                } else if loadMessages.isEmpty == false {
                    errorMessage = loadMessages.joined(separator: " ")
                }
            } else if loadMessages.isEmpty == false {
                errorMessage = loadMessages.joined(separator: " ")
            }
            return
        }

        inventoryCards = fetchedHoldings
        salesHistory = cachedSales
        summary = Self.composeSummary(
            backendSummary: backendSummary,
            holdings: fetchedHoldings,
            userId: userId
        )

        if loadMessages.isEmpty == false {
            errorMessage = loadMessages.joined(separator: " ")
        }
    }

    private func resolvedUserId() -> String {
        (AuthService.shared.userId ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func composeSummary(
        backendSummary: PortfolioIQBackendSummaryResponse?,
        holdings: [InventoryCard],
        userId: String
    ) -> PortfolioSummaryResponse {
        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalProfitLoss = totalValue - totalCost
        let roi = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0

        let inventory = backendSummary?.inventory ?? PortfolioInventorySummary(
            totalCost: totalCost,
            totalCurrentValue: totalValue,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            activeCount: holdings.count
        )

        let accountSnapshot = PortfolioAccountSnapshot(
            userId: userId,
            totalCards: holdings.count,
            totalValue: totalValue,
            totalCost: totalCost,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            generatedAt: ISO8601DateFormatter().string(from: .now)
        )

        let inventoryDetails = holdings.enumerated().map { index, card in
            PortfolioCardDetail(
                id: "\(index)-\(card.id.uuidString)",
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                purchasePlatform: card.purchasePlatform,
                notes: card.notes,
                lastPricedAt: card.purchaseDate,
                signal: card.profitLoss >= 0 ? "hold" : "sell",
                format: card.grade.isEmpty ? nil : card.grade,
                sellReason: card.summary
            )
        }

        let bestCardsToSellNow = holdings
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .enumerated()
            .map { index, card in
                PortfolioBestSellCard(
                    id: "best-\(index)-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    cost: card.cost,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                    signal: card.profitLoss >= 0 ? "hold" : "sell",
                    format: card.grade.isEmpty ? nil : card.grade,
                    recommendation: card.profitLoss >= 0 ? "Hold for now." : "Consider trimming."
                )
            }

        return PortfolioSummaryResponse(
            inventory: inventory,
            accountSnapshot: accountSnapshot,
            inventoryDetails: inventoryDetails,
            bestCardsToSellNow: bestCardsToSellNow,
            month: backendSummary?.month,
            year: backendSummary?.year
        )
    }
}
