//
//  ProfitIQViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation

@MainActor
final class ProfitIQViewModel: ObservableObject {
    @Published private(set) var cards: [ProfitIQCardResult] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var selectedCard: ProfitIQCardResult?

    private let workspaceViewModel: PortfolioWorkspaceViewModel

    init(workspaceViewModel: PortfolioWorkspaceViewModel = PortfolioWorkspaceViewModel()) {
        self.workspaceViewModel = workspaceViewModel
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        await workspaceViewModel.refreshSellIQPortfolio()
        cards = workspaceViewModel.sellIQPortfolioCards.map(ProfitIQCardResult.init(from:))
        errorMessage = workspaceViewModel.sellIQPortfolioErrorMessage
    }

    func refresh() async {
        await load()
    }

    func select(_ card: ProfitIQCardResult?) {
        selectedCard = card
    }

    func markSold(card: ProfitIQCardResult, salePrice: Double, fees: Double, date: Date) async -> Bool {
        let didSave = await workspaceViewModel.markSellIQCardSold(
            card: card.asSellIQPortfolioCard,
            salePrice: salePrice,
            fees: fees,
            date: date
        )

        if didSave {
            cards.removeAll { $0.id == card.id }
            if selectedCard?.id == card.id {
                selectedCard = nil
            }
            errorMessage = nil
        } else {
            errorMessage = workspaceViewModel.errorMessage ?? "Could not save sale. Try again."
        }

        return didSave
    }

    func card(with id: String) -> ProfitIQCardResult? {
        cards.first { $0.id == id }
    }
}
