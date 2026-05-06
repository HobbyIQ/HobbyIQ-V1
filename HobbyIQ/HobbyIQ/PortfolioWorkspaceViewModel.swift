//
//  PortfolioWorkspaceViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class PortfolioWorkspaceViewModel: ObservableObject {
    @Published private(set) var inventory: [InventoryCard] = []
    @Published private(set) var monthPerformance: PortfolioPerformanceSnapshot = .empty
    @Published private(set) var yearPerformance: PortfolioPerformanceSnapshot = .empty
    @Published private(set) var totalCurrentValue: Double = 0
    @Published private(set) var totalCost: Double = 0
    @Published private(set) var totalProfitLoss: Double = 0
    @Published private(set) var importedCards: [InventoryCard] = []
    @Published private(set) var estimates: [CardEstimate] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isRefreshingValues = false
    @Published private(set) var selectedFileName = "No file selected"
    @Published private(set) var uploadSuccessMessage: String?
    @Published private(set) var refreshValuesErrorMessage: String?
    @Published private(set) var importErrorMessage: String?
    @Published var errorMessage: String?

    private let apiService: APIService
    private let inventoryCacheKey = "portfolio.cachedInventory"

    init(apiService: APIService) {
        self.apiService = apiService
    }

    convenience init() {
        self.init(apiService: .shared)
    }

    var hasSalesData: Bool {
        monthPerformance.totalSold > 0 || yearPerformance.totalSold > 0
    }

    var portfolioROIPercent: Double {
        guard totalCost > 0 else { return 0 }
        return ((totalCurrentValue - totalCost) / totalCost) * 100
    }

    func load() async {
        isLoading = true
        uploadSuccessMessage = nil
        errorMessage = nil
        defer { isLoading = false }

        async let inventoryTask = apiService.getInventory()
        async let summaryTask = apiService.fetchPortfolioSummary()

        var loadMessages: [String] = []

        do {
            let fetchedInventory = try await inventoryTask
            let cachedInventory = loadCachedInventory()
            inventory = mergeInventories(fetchedInventory, cachedInventory)
            saveCachedInventory(inventory)
            updatePortfolioTotals()
        } catch {
            inventory = loadCachedInventory()
            updatePortfolioTotals()
            loadMessages.append("Inventory is unavailable right now.")
        }

        do {
            let summary = try await summaryTask
            monthPerformance = summary.month.map(PortfolioPerformanceSnapshot.init(summaryPeriod:)) ?? .empty
            yearPerformance = summary.year.map(PortfolioPerformanceSnapshot.init(summaryPeriod:)) ?? .empty
        } catch {
            monthPerformance = .empty
            yearPerformance = .empty
            loadMessages.append(error.localizedDescription)
        }

        if loadMessages.isEmpty == false {
            errorMessage = loadMessages.joined(separator: " ")
        }
    }

    func retryLoad() async {
        await load()
    }

    func clearStatus() {
        uploadSuccessMessage = nil
        refreshValuesErrorMessage = nil
        importErrorMessage = nil
        errorMessage = nil
    }

    private func updatePortfolioTotals() {
        totalCurrentValue = inventory.reduce(0) { $0 + $1.currentValue }
        totalCost = inventory.reduce(0) { $0 + $1.cost }
        totalProfitLoss = totalCurrentValue - totalCost
    }

    func refreshInventoryValues() async {
        guard inventory.isEmpty == false else {
            refreshValuesErrorMessage = "Add inventory first."
            return
        }

        isRefreshingValues = true
        refreshValuesErrorMessage = nil
        uploadSuccessMessage = nil
        defer { isRefreshingValues = false }

        let request = BulkEstimateRequest(
            cards: inventory.map {
                BulkEstimateCard(playerName: $0.playerName, cardName: $0.cardName, cost: $0.cost)
            }
        )

        do {
            let response = try await apiService.bulkEstimate(request: request)
            let originalCount = inventory.count
            let updatedInventory = inventory.enumerated().map { index, card in
                guard index < response.results.count else { return card }
                let result = response.results[index]
                return card.updatingCompEstimate(
                    currentValue: result.fairValue,
                    lowValue: result.lowValue,
                    highValue: result.highValue,
                    confidence: result.confidence,
                    method: result.method,
                    summary: result.summary
                )
            }

            inventory = updatedInventory
            saveCachedInventory(updatedInventory)
            updatePortfolioTotals()

            if response.results.count != originalCount {
                refreshValuesErrorMessage = "CompIQ returned fewer results than cards."
            } else {
                uploadSuccessMessage = "Portfolio values refreshed."
            }
        } catch {
            refreshValuesErrorMessage = friendlyRefreshErrorMessage(for: error)
        }
    }

    func importInventoryFile(data: Data, fileName: String) async {
        isLoading = true
        defer { isLoading = false }

        do {
            let parsedCards = try parseInventoryCSV(data)
            importedCards = deduplicate(parsedCards)
            selectedFileName = fileName
            importErrorMessage = nil
            uploadSuccessMessage = importedCards.isEmpty ? nil : "Preview ready."
            errorMessage = nil
        } catch {
            importedCards = []
            selectedFileName = fileName
            importErrorMessage = "Could not read that CSV."
            uploadSuccessMessage = nil
        }
    }

    func confirmImportReview() async {
        guard importedCards.isEmpty == false else { return }
        let merged = mergeInventories(inventory, importedCards)
        inventory = merged
        saveCachedInventory(merged)
        updatePortfolioTotals()
        importedCards = []
        estimates = []
        selectedFileName = "No file selected"
        uploadSuccessMessage = "Import confirmed."
        importErrorMessage = nil
        errorMessage = nil
    }

    func priceMyCards() async {
        guard importedCards.isEmpty == false else {
            errorMessage = "Import a file first."
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let cards = importedCards.map {
                CardInput(playerName: $0.playerName, cardName: $0.cardName, cost: $0.cost)
            }
            estimates = try await apiService.bulkEstimate(cards: cards)
            errorMessage = nil
            uploadSuccessMessage = "Pricing finished."
        } catch {
            errorMessage = "Something went wrong"
        }
    }

    func addEstimatedCardsToPortfolio() async {
        guard estimates.isEmpty == false else { return }
        await load()
        importedCards = []
        estimates = []
        selectedFileName = "No file selected"
        uploadSuccessMessage = "Portfolio refreshed."
    }

    func exportInventory() async -> URL? {
        let csv = exportInventoryCSV()
        do {
            let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("hobbyiq_inventory.csv")
            try csv.write(to: fileURL, atomically: true, encoding: .utf8)
            uploadSuccessMessage = "Inventory export ready."
            errorMessage = nil
            return fileURL
        } catch {
            errorMessage = "Something went wrong"
            return nil
        }
    }

    private func exportInventoryCSV() -> String {
        var lines = ["playerName,cardName,cost,currentValue,status"]
        lines.append(contentsOf: inventory.map { card in
            [
                csvValue(card.playerName),
                csvValue(card.cardName),
                csvValue(String(format: "%.2f", card.cost)),
                csvValue(String(format: "%.2f", card.currentValue)),
                csvValue(card.status)
            ].joined(separator: ",")
        })
        return lines.joined(separator: "\n")
    }

    private func saveCachedInventory(_ cards: [InventoryCard]) {
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(cards) {
            UserDefaults.standard.set(data, forKey: inventoryCacheKey)
        }
    }

    private func loadCachedInventory() -> [InventoryCard] {
        guard let data = UserDefaults.standard.data(forKey: inventoryCacheKey) else { return [] }
        return (try? JSONDecoder().decode([InventoryCard].self, from: data)) ?? []
    }

    private func mergeInventories(_ base: [InventoryCard], _ overlay: [InventoryCard]) -> [InventoryCard] {
        var seen: Set<String> = []
        var merged: [InventoryCard] = []

        for card in base + overlay {
            let key = inventoryKey(for: card)
            if seen.contains(key) {
                if let index = merged.firstIndex(where: { inventoryKey(for: $0) == key }) {
                    merged[index] = card
                }
                continue
            }
            seen.insert(key)
            merged.append(card)
        }

        return merged
    }

    private func deduplicate(_ cards: [InventoryCard]) -> [InventoryCard] {
        mergeInventories([], cards)
    }

    private func inventoryKey(for card: InventoryCard) -> String {
        "\(card.playerName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())|\(card.cardName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private func csvValue(_ value: String) -> String {
        if value.contains(",") || value.contains("\"") || value.contains("\n") {
            return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
        }
        return value
    }

    private func friendlyRefreshErrorMessage(for error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .httpError, .decodingError, .networkError, .invalidResponse, .invalidURL, .encodingError, .insecureBaseURL:
                return "Could not refresh values. Try again."
            }
        }

        return error.localizedDescription.isEmpty ? "Could not refresh values. Try again." : error.localizedDescription
    }

    private func parseInventoryCSV(_ data: Data) throws -> [InventoryCard] {
        guard var text = String(data: data, encoding: .utf8) else {
            throw CSVImportError.invalidEncoding
        }

        text = text.replacingOccurrences(of: "\u{feff}", with: "")
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        let rows = normalized.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard rows.isEmpty == false else { return [] }

        let headers = parseCSVRow(rows[0]).map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        let bodyRows = rows.dropFirst()

        return bodyRows.compactMap { row in
            let values = parseCSVRow(row)
            guard values.isEmpty == false else { return nil }

            let valueMap = Dictionary(uniqueKeysWithValues: zip(headers, values))
            let playerName = valueMap["playername"] ?? values[safe: 0] ?? ""
            let cardName = valueMap["cardname"] ?? values[safe: 1] ?? ""
            let cost = Double((valueMap["cost"] ?? values[safe: 2] ?? "0").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            let currentValue = Double((valueMap["currentvalue"] ?? values[safe: 3] ?? "0").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            let status = valueMap["status"] ?? values[safe: 4] ?? ""

            guard playerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
                  cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                return nil
            }

            return InventoryCard(
                playerName: playerName.trimmingCharacters(in: .whitespacesAndNewlines),
                cardName: cardName.trimmingCharacters(in: .whitespacesAndNewlines),
                cost: cost,
                currentValue: currentValue,
                status: status.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }

    private func parseCSVRow(_ row: String) -> [String] {
        var values: [String] = []
        var current = ""
        var isInQuotes = false
        var index = row.startIndex

        while index < row.endIndex {
            let character = row[index]
            if character == "\"" {
                let nextIndex = row.index(after: index)
                if isInQuotes, nextIndex < row.endIndex, row[nextIndex] == "\"" {
                    current.append("\"")
                    index = nextIndex
                } else {
                    isInQuotes.toggle()
                }
            } else if character == "," && isInQuotes == false {
                values.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
                current = ""
            } else {
                current.append(character)
            }
            index = row.index(after: index)
        }

        values.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
        return values
    }

    private enum CSVImportError: Error {
        case invalidEncoding
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
