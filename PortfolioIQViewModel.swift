import Foundation
import SwiftUI

class PortfolioIQViewModel: ObservableObject {
    @Published var holdings: [PortfolioHolding] = PortfolioHolding.mockHoldings
    @Published var filter: PortfolioFilter = .all
    @Published var sort: PortfolioSort = .highestValue
    @Published var isLoading: Bool = false
    @Published var error: String? = nil
    @Published var showAddCard: Bool = false
    @Published var showSortMenu: Bool = false
    @Published var showEditCard: PortfolioHolding? = nil
    @Published var showDetail: PortfolioHolding? = nil
    @Published var isRefreshing: Bool = false
    @Published var lastRefresh: Date = Date()

    // MARK: - Computed
    var filteredHoldings: [PortfolioHolding] {
        let filtered: [PortfolioHolding]
        switch filter {
        case .all:
            filtered = holdings
        case .winners:
            filtered = holdings.filter { $0.totalProfitLoss > 0 }
        case .losers:
            filtered = holdings.filter { $0.totalProfitLoss < 0 }
        case .sellWatch:
            filtered = holdings.filter { $0.statusCategory == .sellWatch }
        case .rising:
            filtered = holdings.filter { $0.trend == .rising }
        case .risky:
            filtered = holdings.filter { $0.riskLevel == .high }
        }
        return sortHoldings(filtered)
    }

    func sortHoldings(_ list: [PortfolioHolding]) -> [PortfolioHolding] {
        switch sort {
        case .highestValue:
            return list.sorted { $0.currentValue > $1.currentValue }
        case .lowestValue:
            return list.sorted { $0.currentValue < $1.currentValue }
        case .biggestGainDollar:
            return list.sorted { $0.totalProfitLoss > $1.totalProfitLoss }
        case .biggestGainPercent:
            return list.sorted { $0.totalProfitLossPct > $1.totalProfitLossPct }
        case .biggestLossDollar:
            return list.sorted { $0.totalProfitLoss < $1.totalProfitLoss }
        case .biggestLossPercent:
            return list.sorted { $0.totalProfitLossPct < $1.totalProfitLossPct }
        case .recentlyUpdated:
            return list.sorted { $0.lastUpdated > $1.lastUpdated }
        case .oldestUpdate:
            return list.sorted { $0.lastUpdated < $1.lastUpdated }
        case .bestSellCandidates:
            return list.sorted { $0.statusCategory == .sellWatch && $1.statusCategory != .sellWatch }
        case .highestRisk:
            return list.sorted { $0.riskLevel == .high && $1.riskLevel != .high }
        case .alphabetical:
            return list.sorted { $0.cardTitle < $1.cardTitle }
        case .purchaseDateNewest:
            return list.sorted { ($0.purchaseDate ?? .distantPast) > ($1.purchaseDate ?? .distantPast) }
        case .purchaseDateOldest:
            return list.sorted { ($0.purchaseDate ?? .distantFuture) < ($1.purchaseDate ?? .distantFuture) }
        }
    }

    // MARK: - Actions
    func refreshPortfolio() {
        isRefreshing = true
        Task {
            await refreshPortfolioAsync()
        }
    }

    @MainActor
    private func refreshPortfolioAsync() async {
        defer {
            isRefreshing = false
            lastRefresh = Date()
        }

        // Build one query per holding
        let queries: [String] = holdings.map { h in
            var parts: [String] = []
            if h.cardYear > 0 { parts.append(String(h.cardYear)) }
            if !h.brand.isEmpty { parts.append(h.brand) }
            if !h.setName.isEmpty { parts.append(h.setName) }
            if let p = h.parallel, !p.isEmpty { parts.append(p) }
            parts.append(h.playerName)
            if h.isAuto { parts.append("Auto") }
            if !h.gradingCompany.isEmpty && h.gradingCompany.lowercased() != "raw" {
                parts.append(h.gradingCompany)
                parts.append(h.grade)
            }
            return parts.joined(separator: " ")
        }

        guard !queries.isEmpty else { return }

        do {
            let response = try await APIService.shared.bulkPriceCards(queries: queries)
            for bulkResult in response.results {
                guard bulkResult.status == "ok", let data = bulkResult.data else { continue }
                guard let idx = holdings.firstIndex(where: { holding in
                    // Match result back to holding by query proximity
                    let q = bulkResult.query.lowercased()
                    return q.contains(holding.playerName.lowercased())
                }) else { continue }

                let fmv = data.marketTier?.value ?? holdings[idx].currentValue
                let high = data.marketTier?.high
                let direction = data.trendAnalysis?.market_direction ?? "unclear"

                holdings[idx].currentValue = fmv
                holdings[idx].fairMarketValue = fmv
                if let h = high { holdings[idx].premiumValue = h }
                holdings[idx].quickSaleValue = fmv * 0.88
                holdings[idx].trend = direction == "up" ? .rising : direction == "down" ? .falling : .stable
                // Update verdict and recommendation from live summary
                if let summary = data.summary, !summary.isEmpty {
                    holdings[idx].verdict = summary
                }
                let rec: String
                switch direction {
                case "up": rec = "Hold"
                case "down": rec = "Sell Watch"
                default: rec = "Hold"
                }
                holdings[idx].recommendation = rec
                if let liquidity = data.trendAnalysis?.liquidity, !liquidity.isEmpty {
                    holdings[idx].marketSpeed = liquidity
                }
                holdings[idx].freshnessStatus = .live
                holdings[idx].lastUpdated = Date()
                // Recalculate P&L
                let basis = holdings[idx].totalCostBasis
                holdings[idx].totalProfitLoss = fmv - basis
                holdings[idx].totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0
            }
        } catch {
            self.error = "Refresh failed: \(error.localizedDescription)"
        }
    }

    func addHolding(_ holding: PortfolioHolding) {
        holdings.append(holding)
        // Auto-fetch live pricing for the newly added card
        let newID = holding.id
        Task { await refreshSingleHolding(id: newID) }
    }

    @MainActor
    private func refreshSingleHolding(id: UUID) async {
        guard let idx = holdings.firstIndex(where: { $0.id == id }) else { return }
        let h = holdings[idx]
        var gradeValue: Int? = nil
        if let last = h.grade.components(separatedBy: " ").last, let g = Int(last) {
            gradeValue = g
        }
        let req = CompIQEstimateRequest(
            playerName: h.playerName,
            cardYear: h.cardYear > 0 ? h.cardYear : nil,
            product: h.product.isEmpty ? nil : h.product,
            parallel: h.parallel,
            isAuto: h.isAuto,
            gradeCompany: h.gradingCompany.isEmpty ? nil : h.gradingCompany,
            gradeValue: gradeValue
        )
        do {
            let est = try await APIService.shared.estimateCard(request: req)
            guard let idx2 = holdings.firstIndex(where: { $0.id == id }) else { return }
            let fmv = est.fairMarketValue ?? holdings[idx2].currentValue
            holdings[idx2].currentValue = fmv
            holdings[idx2].fairMarketValue = fmv
            holdings[idx2].quickSaleValue = est.quickSaleValue
            if let h = est.premiumValue { holdings[idx2].premiumValue = h }
            if let verdict = est.verdict, !verdict.isEmpty { holdings[idx2].verdict = verdict }
            if let action = est.action, !action.isEmpty { holdings[idx2].recommendation = action }
            if let dna = est.marketDNA {
                holdings[idx2].marketSpeed = dna.speed ?? holdings[idx2].marketSpeed
                holdings[idx2].marketPressure = dna.marketCondition ?? holdings[idx2].marketPressure
            }
            if let exit = est.exitStrategy {
                holdings[idx2].expectedDaysToSell = exit.expectedDaysToSell
            }
            if let bullets = est.explanation, !bullets.isEmpty {
                holdings[idx2].explanationBullets = bullets
            }
            let basis = holdings[idx2].totalCostBasis
            holdings[idx2].totalProfitLoss = fmv - basis
            holdings[idx2].totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0
            holdings[idx2].freshnessStatus = .live
            holdings[idx2].lastUpdated = Date()
        } catch {
            print("[PortfolioIQ] Auto-estimate failed for \(h.playerName): \(error)")
        }
    }

    func updateHolding(_ holding: PortfolioHolding) {
        if let idx = holdings.firstIndex(where: { $0.id == holding.id }) {
            holdings[idx] = holding
        }
    }

    func deleteHolding(_ holding: PortfolioHolding) {
        holdings.removeAll { $0.id == holding.id }
    }
}
