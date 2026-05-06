import Foundation
import SwiftUI

// MARK: - Portfolio Snapshot (daily value history)
struct PortfolioSnapshot: Codable, Identifiable {
    var id: String { ISO8601DateFormatter().string(from: date) }
    let date: Date
    let totalValue: Double
}

@MainActor
class PortfolioIQViewModel: ObservableObject {
    @Published var holdings: [PortfolioHolding] = []
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
    @Published var valueHistory: [PortfolioSnapshot] = []
    @Published var ledgerEntries: [PortfolioLedgerEntry] = []
    @Published var realizedProfitLoss: Double = 0
    @Published var ledgerGrossProceeds: Double = 0
    @Published var ledgerNetProceeds: Double = 0
    @Published var ledgerCostBasisSold: Double = 0

    private var activeSessionId: String? = nil
    private var snapshotKey: String { "portfolio.snapshots.\(activeSessionId ?? "anon")" }

    // MARK: - Snapshot helpers
    func loadSnapshots() {
        guard let data = UserDefaults.standard.data(forKey: snapshotKey),
              let decoded = try? JSONDecoder().decode([PortfolioSnapshot].self, from: data)
        else { return }
        valueHistory = decoded
    }

    private func recordSnapshot() {
        let total = holdings.reduce(0.0) { $0 + $1.currentValue * Double($1.quantity) }
        guard total > 0 else { return }
        let today = Calendar.current.startOfDay(for: Date())
        // Replace today's entry if it already exists
        valueHistory.removeAll { Calendar.current.startOfDay(for: $0.date) == today }
        valueHistory.append(PortfolioSnapshot(date: today, totalValue: total))
        // Keep rolling 90 days
        valueHistory = valueHistory.sorted { $0.date < $1.date }.suffix(90).map { $0 }
        if let encoded = try? JSONEncoder().encode(valueHistory) {
            UserDefaults.standard.set(encoded, forKey: snapshotKey)
        }
    }

    private func applyRoiRecommendation(to holding: inout PortfolioHolding) {
        let shouldSell = holding.totalProfitLossPct > 25
        holding.recommendation = shouldSell ? "Sell" : "Hold"

        if shouldSell {
            holding.statusCategory = .sellWatch
        } else if holding.statusCategory == .sellWatch {
            holding.statusCategory = .hold
        }
    }

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
    func loadPortfolio(sessionId: String?) {
        activeSessionId = sessionId
        guard let sessionId, !sessionId.isEmpty else {
            holdings = []
            ledgerEntries = []
            realizedProfitLoss = 0
            ledgerGrossProceeds = 0
            ledgerNetProceeds = 0
            ledgerCostBasisSold = 0
            error = nil
            valueHistory = []
            return
        }

        isLoading = true
        error = nil

        Task {
            defer { isLoading = false }
            do {
                let response = try await APIService.shared.fetchPortfolioHoldings(sessionId: sessionId)
                holdings = response.holdings
                for index in holdings.indices {
                    applyRoiRecommendation(to: &holdings[index])
                }
                await fetchLedger(sessionId: sessionId)
                loadSnapshots()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func refreshPortfolio() {
        isRefreshing = true
        Task {
            await refreshPortfolioAsync()
        }
    }

    /// Pull-to-refresh: reload holdings list from backend, then reprice all.
    func refreshAll() async {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else { return }
        isRefreshing = true
        defer {
            isRefreshing = false
            lastRefresh = Date()
        }
        do {
            let response = try await APIService.shared.fetchPortfolioHoldings(sessionId: sessionId)
            holdings = response.holdings
            for index in holdings.indices {
                applyRoiRecommendation(to: &holdings[index])
            }
        } catch {
            self.error = error.localizedDescription
            return
        }
        await refreshPortfolioAsync()
    }

    @MainActor
    private func refreshPortfolioAsync() async {
        defer {
            isRefreshing = false
            lastRefresh = Date()
        }

        guard !holdings.isEmpty else { return }

        // Build (id → query) map so we can match results back by position
        let orderedIDs: [UUID] = holdings.map { $0.id }
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

        do {
            let response = try await APIService.shared.bulkPriceCards(queries: queries)
            // Results are returned in the same order as queries — match by position
            for (position, bulkResult) in response.results.enumerated() {
                guard bulkResult.status == "ok", let data = bulkResult.data else { continue }
                guard position < orderedIDs.count,
                      let idx = holdings.firstIndex(where: { $0.id == orderedIDs[position] })
                else { continue }

                let fmv = data.marketTier?.value ?? holdings[idx].currentValue
                let high = data.marketTier?.high
                let direction = data.trendAnalysis?.market_direction ?? "unclear"

                holdings[idx].currentValue = fmv
                holdings[idx].fairMarketValue = fmv
                if let h = high { holdings[idx].premiumValue = h }
                holdings[idx].quickSaleValue = fmv * 0.88
                holdings[idx].trend = direction == "up" ? .rising : direction == "down" ? .falling : .stable
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
                let basis = holdings[idx].totalCostBasis
                holdings[idx].totalProfitLoss = fmv - basis
                holdings[idx].totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0
                applyRoiRecommendation(to: &holdings[idx])
            }
            // Persist updated values back to server
            if let sessionId = activeSessionId, !sessionId.isEmpty {
                for holding in holdings {
                    try? await APIService.shared.updatePortfolioHolding(holding, sessionId: sessionId)
                }
            }
            recordSnapshot()
        } catch {
            self.error = "Refresh failed: \(error.localizedDescription)"
        }
    }

    func addHolding(_ holding: PortfolioHolding) {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else {
            error = "Sign in required to add cards to your portfolio."
            return
        }

        var normalized = holding
        applyRoiRecommendation(to: &normalized)
        holdings.append(normalized)

        Task {
            do {
                _ = try await APIService.shared.addPortfolioHolding(normalized, sessionId: sessionId)
            } catch {
                self.error = error.localizedDescription
                self.holdings.removeAll { $0.id == normalized.id }
                return
            }
        }

        // Auto-fetch live pricing for the newly added card
        let newID = normalized.id
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
        let req = CardEstimateRequest(
            playerName: h.playerName,
            cardYear: h.cardYear > 0 ? h.cardYear : nil,
            product: h.product.isEmpty ? nil : h.product,
            parallel: h.parallel.flatMap { $0.isEmpty ? nil : $0 },
            isAuto: h.isAuto ? true : nil,
            gradeCompany: h.gradingCompany.isEmpty ? nil : h.gradingCompany,
            gradeValue: gradeValue
        )
        do {
            let est = try await APIService.shared.estimateCardDirect(request: req)
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
                holdings[idx2].marketPressure = dna.liquidity ?? holdings[idx2].marketPressure
            }
            if let exit = est.exitStrategy {
                holdings[idx2].expectedDaysToSell = exit.expectedDaysToSell
            }
            if let bullets = est.explanation, !bullets.isEmpty {
                holdings[idx2].explanationBullets = bullets
            }
            // pricingAnalytics: comp pool, confidence, parallel detection
            if let pa = est.pricingAnalytics {
                holdings[idx2].compsUsed = pa.compsUsed
                holdings[idx2].confidence = pa.rSquared
                holdings[idx2].parallelDetected = pa.parallelDetected
            }
            let basis = holdings[idx2].totalCostBasis
            holdings[idx2].totalProfitLoss = fmv - basis
            holdings[idx2].totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0
            applyRoiRecommendation(to: &holdings[idx2])
            holdings[idx2].freshnessStatus = .live
            holdings[idx2].lastUpdated = Date()
            if let sessionId = activeSessionId, !sessionId.isEmpty {
                _ = try? await APIService.shared.updatePortfolioHolding(holdings[idx2], sessionId: sessionId)
            }
        } catch {
            print("[PortfolioIQ] Auto-estimate failed for \(h.playerName): \(error)")
        }
    }

    // MARK: - Single-card reprice (used by detail view)
    func repriceSingleHolding(id: UUID) {
        Task { await refreshSingleHolding(id: id) }
    }

    // MARK: - Cost basis update
    func updateCostBasis(id: UUID, newPurchasePrice: Double, newQuantity: Int, notes: String? = nil, purchaseDate: Date? = nil) {
        guard let idx = holdings.firstIndex(where: { $0.id == id }) else { return }
        holdings[idx].purchasePrice = newPurchasePrice
        holdings[idx].quantity = newQuantity
        holdings[idx].totalCostBasis = newPurchasePrice * Double(newQuantity)
        let fmv = holdings[idx].currentValue
        holdings[idx].totalProfitLoss = fmv - holdings[idx].totalCostBasis
        holdings[idx].totalProfitLossPct = holdings[idx].totalCostBasis > 0
            ? ((fmv - holdings[idx].totalCostBasis) / holdings[idx].totalCostBasis) * 100 : 0
        if let notes { holdings[idx].notes = notes }
        if let purchaseDate { holdings[idx].purchaseDate = purchaseDate }
        applyRoiRecommendation(to: &holdings[idx])
        updateHolding(holdings[idx])
    }

    func updateHolding(_ holding: PortfolioHolding) {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else {
            error = "Sign in required to update cards in your portfolio."
            return
        }

        if let idx = holdings.firstIndex(where: { $0.id == holding.id }) {
            var normalized = holding
            applyRoiRecommendation(to: &normalized)
            holdings[idx] = normalized

            Task {
                do {
                    _ = try await APIService.shared.updatePortfolioHolding(normalized, sessionId: sessionId)
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    func deleteHolding(_ holding: PortfolioHolding) {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else {
            error = "Sign in required to remove cards from your portfolio."
            return
        }

        holdings.removeAll { $0.id == holding.id }

        Task {
            do {
                _ = try await APIService.shared.removePortfolioHolding(holdingId: holding.id, sessionId: sessionId)
                await fetchLedger(sessionId: sessionId)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func sellHolding(
        _ holding: PortfolioHolding,
        quantity: Int = 1,
        salePrice: Double? = nil,
        fees: Double = 0,
        tax: Double = 0,
        shipping: Double = 0,
        notes: String? = nil
    ) {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else {
            error = "Sign in required to sell cards."
            return
        }

        let unitPrice = salePrice ?? holding.currentValue
        let request = PortfolioSellRequest(
            quantity: max(1, quantity),
            salePrice: unitPrice,
            fees: fees,
            tax: tax,
            shipping: shipping,
            soldAt: ISO8601DateFormatter().string(from: Date()),
            notes: notes
        )

        Task {
            do {
                _ = try await APIService.shared.sellPortfolioHolding(holdingId: holding.id, request: request, sessionId: sessionId)
                let holdingsResponse = try await APIService.shared.fetchPortfolioHoldings(sessionId: sessionId)
                self.holdings = holdingsResponse.holdings
                for index in self.holdings.indices {
                    applyRoiRecommendation(to: &self.holdings[index])
                }
                await fetchLedger(sessionId: sessionId)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func fetchLedger(sessionId: String) async {
        do {
            let ledger = try await APIService.shared.fetchPortfolioLedger(sessionId: sessionId)
            self.ledgerEntries = ledger.entries
            self.realizedProfitLoss = ledger.totals.realizedProfitLoss
            self.ledgerGrossProceeds = ledger.totals.grossProceeds
            self.ledgerNetProceeds = ledger.totals.netProceeds
            self.ledgerCostBasisSold = ledger.totals.costBasisSold
        } catch {
            self.ledgerEntries = []
            self.realizedProfitLoss = 0
            self.ledgerGrossProceeds = 0
            self.ledgerNetProceeds = 0
            self.ledgerCostBasisSold = 0
        }
    }
}
