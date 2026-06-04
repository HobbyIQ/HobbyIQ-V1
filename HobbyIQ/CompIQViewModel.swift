//
//  CompIQViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class CompIQViewModel: ObservableObject {
    static let shared = CompIQViewModel()

    @Published var result: CompIQEstimateResult?
    @Published var insight: String?
    @Published var listingTitle: String?
    @Published var listingDescription: String?
    @Published var isLoading = false
    @Published var isLoadingInsight = false
    @Published var isLoadingListing = false
    @Published var errorMessage: String?
    @Published var parsedCard: CompIQParsedCard?

    @Published var playerName = ""
    @Published var cardName = ""
    @Published var cost = ""
    @Published var parallel = ""
    @Published var grade = ""
    @Published var serialNumber = ""
    @Published var salePrice = ""

    /// Cache: key is "player|card|cost|parallel|grade" → result
    private var estimateCache: [String: CompIQEstimateResult] = [:]

    private init() {}

    private func cacheKey() -> String {
        "\(trimmed(playerName))|\(trimmed(cardName))|\(cost)|\(trimmedOrNil(parallel) ?? "")|\(normalizedGrade(grade) ?? "")"
    }

    var costDouble: Double? {
        Double(cost.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var salePriceDouble: Double? {
        let trimmed = salePrice.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty, let current = result?.fairValue {
            return current
        }
        return Double(trimmed)
    }

    var serialInt: Int? {
        Int(serialNumber.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var isFormValid: Bool {
        playerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false &&
        cardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false &&
        costDouble != nil
    }

    func runEstimate() async {
        guard isFormValid else {
            errorMessage = "Add a player name, card name, and cost first."
            return
        }

        // Return cached result if available for identical inputs
        let key = cacheKey()
        if let cached = estimateCache[key] {
            result = cached
            return
        }

        isLoading = true
        errorMessage = nil
        insight = nil
        listingTitle = nil
        listingDescription = nil

        defer { isLoading = false }

        do {
            let request = CompIQSingleInput(
                playerName: trimmed(playerName),
                cardName: trimmed(cardName),
                cost: costDouble ?? 0,
                parallel: trimmedOrNil(parallel),
                grade: normalizedGrade(grade),
                serialNumber: serialInt,
                recentComps: nil
            )
            let fetchedResult = try await APIService.shared.singleEstimate(request: request)
            estimateCache[key] = fetchedResult
            result = fetchedResult
        } catch {
            result = nil
            errorMessage = friendlyError(error)
        }
    }

    func runBulkEstimate(cards: [CompIQCardInput]) async -> [CompIQEstimateResult] {
        guard cards.isEmpty == false else { return [] }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let results = try await APIService.shared.bulkEstimate(cards: cards)
            if result == nil {
                result = results.first
            }
            return results
        } catch {
            errorMessage = friendlyError(error)
            return []
        }
    }

    func loadInsight() async {
        guard let result else {
            errorMessage = "Run CompIQ first."
            return
        }

        isLoadingInsight = true
        errorMessage = nil
        defer { isLoadingInsight = false }

        do {
            let response = try await APIService.shared.investmentInsight(
                request: CompIQInsightInput(
                    playerName: trimmed(playerName),
                    cardName: trimmedOrNil(cardName),
                    fairValue: result.fairValue,
                    investmentScore: Int(result.confidence),
                    compCount: result.details?.compCount,
                    trendDirection: result.details?.grade,
                    trendStrength: result.method,
                    outlook: result.summary,
                    outlookNote: result.explanationLines.first,
                    forwardValue30d: result.highValue,
                    bearValue30d: result.lowValue,
                    bullValue30d: result.highValue
                )
            )

            if response.available {
                insight = response.insight
            } else {
                insight = nil
                errorMessage = response.error ?? "Could not generate insight."
            }
        } catch {
            insight = nil
            errorMessage = friendlyError(error)
        }
    }

    func loadListing(platform: String) async {
        guard let result else {
            errorMessage = "Run CompIQ first."
            return
        }

        isLoadingListing = true
        errorMessage = nil
        defer { isLoadingListing = false }

        do {
            let response = try await APIService.shared.generateListing(
                request: CompIQListingInput(
                    playerName: trimmed(playerName),
                    cardName: trimmed(cardName),
                    parallel: trimmedOrNil(parallel),
                    grade: normalizedGrade(grade),
                    fairValue: result.fairValue,
                    platform: platform.isEmpty ? nil : platform
                )
            )

            if response.available {
                listingTitle = response.title
                listingDescription = response.description
            } else {
                listingTitle = nil
                listingDescription = nil
                errorMessage = response.error ?? "Could not generate listing."
            }
        } catch {
            listingTitle = nil
            listingDescription = nil
            errorMessage = friendlyError(error)
        }
    }

    func parseFromText(_ text: String) async {
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedText.isEmpty == false else {
            errorMessage = "Paste a card label or listing first."
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await APIService.shared.parseCard(request: CompIQParseRequest(text: trimmedText))
            parsedCard = response.parsed

            if let parsed = response.parsed {
                if let player = parsed.playerName, player.isEmpty == false { playerName = player }
                if let card = parsed.cardName, card.isEmpty == false { cardName = card }
                if let parallel = parsed.parallel, parallel.isEmpty == false { self.parallel = parallel }
                if let grade = parsed.grade, grade.isEmpty == false { self.grade = grade }
                if let serial = parsed.serialNumber {
                    serialNumber = String(serial)
                }
            } else if response.available == false {
                errorMessage = response.error ?? "Could not parse that text."
            }
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    func submitSale(platform: String) async {
        guard result != nil else {
            errorMessage = "Run CompIQ first."
            return
        }

        guard let recordedSalePrice = salePriceDouble else {
            errorMessage = "Enter a sale price."
            return
        }

        errorMessage = nil

        do {
            let response = try await APIService.shared.recordSale(
                request: CompIQSaleInput(
                    playerName: trimmed(playerName),
                    cardName: trimmed(cardName),
                    parallel: trimmedOrNil(parallel),
                    serialNumber: serialInt,
                    salePrice: recordedSalePrice,
                    saleDate: Self.saleDateFormatter.string(from: Date()),
                    grade: normalizedGrade(grade),
                    platform: platform.isEmpty ? nil : platform
                )
            )

            if response.success == false {
                errorMessage = "Could not save the sale."
            }

            if let canonicalParallel = response.canonicalParallel, canonicalParallel.isEmpty == false {
                parallel = canonicalParallel
            }

            if let recordedPrice = response.salePrice {
                salePrice = String(format: "%.2f", recordedPrice)
            }
        } catch {
            errorMessage = friendlyError(error)
        }
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func trimmedOrNil(_ value: String) -> String? {
        let trimmed = self.trimmed(value)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedGrade(_ value: String) -> String? {
        trimmedOrNil(value)
    }

    private func friendlyError(_ error: Error) -> String {
        if let apiError = error as? APIServiceError,
           case .httpError(let code, let body) = apiError, code == 402 {
            let msg = APIService.backendMessage(from: body)
            return msg.isEmpty ? "You've reached your daily price check limit. Upgrade for more." : msg
        }
        if let local = error as? LocalizedError, let description = local.errorDescription {
            return description
        }
        return error.localizedDescription
    }

    private static let saleDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
