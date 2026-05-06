//
//  PortfolioIQViewModel.swift
//  HobbyIQ
//

import Foundation

@MainActor
final class PortfolioIQViewModel: ObservableObject {
    @Published private(set) var summary: PortfolioSummaryResponse?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let service: APIService

    init(service: APIService = .shared, initialSummary: PortfolioSummaryResponse? = nil) {
        self.service = service
        self.summary = initialSummary
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

    func load() async {
        await fetch(preserveExistingSummaryOnError: false)
    }

    func refresh() async {
        await fetch(preserveExistingSummaryOnError: true)
    }

    private func fetch(preserveExistingSummaryOnError: Bool) async {
        guard isLoading == false else { return }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let userId = (AuthService.shared.userId ?? "demo")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            let fetchedSummary = try await service.fetchPortfolioSummary(userId: userId)
            summary = fetchedSummary
        } catch {
            if preserveExistingSummaryOnError == false {
                summary = nil
            }
            errorMessage = userFacingMessage(for: error, fallback: "Could not load PortfolioIQ right now.")
        }
    }
}
