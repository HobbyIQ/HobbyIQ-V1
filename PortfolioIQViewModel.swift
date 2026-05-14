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

    // Grading pipeline
    @Published var gradingSubmissions: [GradingSubmission] = GradingSubmission.mockSubmissions

    // Sales records
    @Published var saleRecords: [SaleRecord] = SaleRecord.mockSales

    // AI recommendations
    @Published var aiRecommendations: [AIRecommendation] = []
    @Published var dailyIQPerformerHitCounts: [String: Int] = [:]
    @Published var portfolioAlerts: [PortfolioAlert] = []
    @Published var portfolioHealth: PortfolioHealthResponse? = nil
    @Published var holdingPriceHistory: [UUID: [PortfolioPricePoint]] = [:]
    @Published var calibrationReport: PortfolioCalibrationResponse? = nil
    @Published var weeklyBrief: PortfolioWeeklyBriefResponse? = nil

    private var activeSessionId: String? = nil
    private var snapshotKey: String { "portfolio.snapshots.\(activeSessionId ?? "anon")" }
    private let dailyIQBriefCacheKey = "dailyiq.brief.cache.v1"
    private let dailyIQTrendWindowDays = 21
    private let dailyIQTrendMinRepeatsHitter = 6
    private let dailyIQTrendMinRepeatsPitcher = 2
    private let minConfidenceGate: Double = 0.55
    private let minCompsGate: Int = 3

    private func confidenceToPercent(_ value: Double?) -> Double {
        guard let value else { return 0 }
        return value <= 1.0 ? value * 100 : value
    }

    private func shouldApplyConfidenceGate(confidencePercent: Double, compsUsed: Int?) -> Bool {
        if let compsUsed, compsUsed > 0 {
            return confidencePercent >= minConfidenceGate * 100 && compsUsed >= minCompsGate
        }
        return confidencePercent >= minConfidenceGate * 100
    }

    private func normalizePlayerKey(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func recalculateDailyIQTrendSignals() {
        guard let data = UserDefaults.standard.data(forKey: dailyIQBriefCacheKey),
              let briefByDay = try? JSONDecoder().decode([String: DailyBriefResponse].self, from: data)
        else {
            dailyIQPerformerHitCounts = [:]
            return
        }

        let cutoff = Calendar.current.date(byAdding: .day, value: -dailyIQTrendWindowDays, to: Date()) ?? .distantPast
        var dayBucketsByPlayer: [String: Set<String>] = [:]

        for (dayKey, brief) in briefByDay {
            if let briefDate = ISO8601DateFormatter().date(from: brief.date), briefDate < cutoff {
                continue
            }

            let uniquePlayersForDay = Set((brief.mlb + brief.milb)
                .map { normalizePlayerKey($0.playerName) }
                .filter { !$0.isEmpty })

            for playerKey in uniquePlayersForDay {
                dayBucketsByPlayer[playerKey, default: []].insert(dayKey)
            }
        }

        var counts: [String: Int] = [:]
        for (playerKey, dayKeys) in dayBucketsByPlayer {
            let count = dayKeys.count
            if count >= dailyIQTrendMinRepeatsPitcher {
                counts[playerKey] = count
            }
        }
        dailyIQPerformerHitCounts = counts
    }

    func dailyIQRepeatCount(for playerName: String) -> Int {
        dailyIQPerformerHitCounts[normalizePlayerKey(playerName)] ?? 0
    }

    private func isLikelyPitcher(_ holding: PortfolioHolding) -> Bool {
        let haystack = [
            holding.playerName,
            holding.cardTitle,
            holding.product,
            holding.setName,
            holding.notes ?? "",
            holding.tags.joined(separator: " ")
        ]
            .joined(separator: " ")
            .lowercased()

        // Keep the heuristic conservative to avoid misclassifying hitters.
        let pitcherSignals = ["pitcher", "starting pitcher", "relief pitcher", "closer"]
        if pitcherSignals.contains(where: { haystack.contains($0) }) {
            return true
        }

        let rolePattern = #"\b(lhp|rhp|sp|rp)\b"#
        if haystack.range(of: rolePattern, options: .regularExpression) != nil {
            return true
        }

        return false
    }

    func isDailyIQTrending(_ holding: PortfolioHolding) -> Bool {
        let repeats = dailyIQRepeatCount(for: holding.playerName)
        let threshold = isLikelyPitcher(holding) ? dailyIQTrendMinRepeatsPitcher : dailyIQTrendMinRepeatsHitter
        return repeats >= threshold
    }

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
                await fetchAlertsAndHealth(sessionId: sessionId)
                loadSnapshots()
                recalculateDailyIQTrendSignals()
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

    /// Pull-to-refresh: ask the server to reprice every holding (persists fresh
    /// fair-market-value, P&L $ and %, alerts, and price-history to Cosmos),
    /// then re-fetch the persisted holdings so the inventory tab shows the
    /// updated profit/loss. Falls back to a client-side bulk reprice if the
    /// server-side batch endpoint fails so users on older API builds still
    /// get a refresh.
    func refreshAll() async {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else { return }
        isRefreshing = true
        defer {
            isRefreshing = false
            lastRefresh = Date()
        }

        // 1) Server-side batch reprice (persists to Cosmos). Best-effort —
        // if it fails we still try to fetch and locally reprice below.
        var serverRepriced = false
        do {
            _ = try await APIService.shared.runPortfolioBatchReprice(sessionId: sessionId)
            serverRepriced = true
        } catch {
            print("[PortfolioIQ] batch reprice failed, falling back to local: \(error)")
        }

        // 2) Pull the freshly-priced holdings back from the server.
        do {
            let response = try await APIService.shared.fetchPortfolioHoldings(sessionId: sessionId)
            holdings = response.holdings
            for index in holdings.indices {
                applyRoiRecommendation(to: &holdings[index])
            }
            recalculateDailyIQTrendSignals()
        } catch {
            self.error = error.localizedDescription
            return
        }

        // 3) Refresh alerts + health snapshots so badges/sell-watch reflect the
        // new values.
        await fetchAlertsAndHealth(sessionId: sessionId)

        // 4) If the server reprice failed (older deploy or transient outage),
        // fall back to a local bulk reprice so the UI still updates.
        if !serverRepriced {
            await refreshPortfolioAsync()
        }
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

                let confidencePercent = confidenceToPercent(data.confidence)
                let confidencePass = shouldApplyConfidenceGate(confidencePercent: confidencePercent, compsUsed: nil)
                if !confidencePass {
                    holdings[idx].freshnessStatus = .needsRefresh
                    holdings[idx].statusCategory = .needsAttention
                    holdings[idx].recommendation = "Needs Review"
                    holdings[idx].verdict = "Confidence too low for auto-repricing."
                    continue
                }

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
                holdings[idx].confidence = confidencePercent
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
            if let sessionId = activeSessionId, !sessionId.isEmpty {
                await fetchAlertsAndHealth(sessionId: sessionId)
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
            // Pricing Accuracy v2: never overwrite currentValue with a fake
            // number when the backend couldn't gather enough recent comps.
            // Surface the thin-data state so PortfolioIQ shows it instead.
            if let ds = est.dataSufficiency, !ds.sufficient {
                holdings[idx2].freshnessStatus = .needsRefresh
                holdings[idx2].statusCategory = .needsAttention
                holdings[idx2].recommendation = "Awaiting comps"
                holdings[idx2].verdict = ds.message
                if let pa = est.pricingAnalytics { holdings[idx2].compsUsed = pa.compsUsed }
                #if DEBUG
                print("CompIQ thin-data: \(id) — \(ds.message)")
                #endif
                return
            }
            // pricingAnalytics: comp pool, confidence, parallel detection
            if let pa = est.pricingAnalytics {
                let confidencePercent = confidenceToPercent(pa.rSquared)
                if !shouldApplyConfidenceGate(confidencePercent: confidencePercent, compsUsed: pa.compsUsed) {
                    holdings[idx2].freshnessStatus = .needsRefresh
                    holdings[idx2].statusCategory = .needsAttention
                    holdings[idx2].recommendation = "Needs Review"
                    holdings[idx2].verdict = "Confidence too low for auto-apply."
                    holdings[idx2].confidence = confidencePercent
                    holdings[idx2].compsUsed = pa.compsUsed
                    holdings[idx2].parallelDetected = pa.parallelDetected
                    return
                }
                holdings[idx2].compsUsed = pa.compsUsed
                holdings[idx2].confidence = confidencePercent
                holdings[idx2].parallelDetected = pa.parallelDetected
            }

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
            let basis = holdings[idx2].totalCostBasis
            holdings[idx2].totalProfitLoss = fmv - basis
            holdings[idx2].totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0
            applyRoiRecommendation(to: &holdings[idx2])
            holdings[idx2].freshnessStatus = .live
            holdings[idx2].lastUpdated = Date()
            if let sessionId = activeSessionId, !sessionId.isEmpty {
                _ = try? await APIService.shared.updatePortfolioHolding(holdings[idx2], sessionId: sessionId)
                if let history = try? await APIService.shared.fetchHoldingPriceHistory(holdingId: id, sessionId: sessionId) {
                    holdingPriceHistory[id] = history.points
                }
                await fetchAlertsAndHealth(sessionId: sessionId)
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
                recalculateDailyIQTrendSignals()
                await fetchLedger(sessionId: sessionId)
                await fetchAlertsAndHealth(sessionId: sessionId)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func runBatchReprice() {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else { return }
        Task {
            do {
                _ = try await APIService.shared.runPortfolioBatchReprice(sessionId: sessionId)
                let response = try await APIService.shared.fetchPortfolioHoldings(sessionId: sessionId)
                holdings = response.holdings
                await fetchAlertsAndHealth(sessionId: sessionId)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func submitRecommendationFeedback(holding: PortfolioHolding, actionTaken: String, notes: String? = nil) {
        guard let sessionId = activeSessionId, !sessionId.isEmpty else { return }
        Task {
            do {
                let req = RecommendationFeedbackRequest(
                    holdingId: holding.id.uuidString,
                    recommendation: holding.recommendation,
                    actionTaken: actionTaken,
                    notes: notes
                )
                _ = try await APIService.shared.submitRecommendationFeedback(request: req, sessionId: sessionId)
                if let brief = try? await APIService.shared.fetchPortfolioWeeklyBrief(sessionId: sessionId) {
                    self.weeklyBrief = brief
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func fetchAlertsAndHealth(sessionId: String) async {
        if let alerts = try? await APIService.shared.fetchPortfolioAlerts(sessionId: sessionId, limit: 30) {
            self.portfolioAlerts = alerts.alerts
        }
        if let health = try? await APIService.shared.fetchPortfolioHealth(sessionId: sessionId) {
            self.portfolioHealth = health
        }
        if let calibration = try? await APIService.shared.fetchPortfolioCalibration(sessionId: sessionId) {
            self.calibrationReport = calibration
        }
        if let brief = try? await APIService.shared.fetchPortfolioWeeklyBrief(sessionId: sessionId) {
            self.weeklyBrief = brief
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
