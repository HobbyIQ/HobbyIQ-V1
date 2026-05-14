import Foundation

@MainActor
class HobbyIQViewModel: ObservableObject {
    static let shared = HobbyIQViewModel()
    private init() {}
    private let authSessionKey = "auth.sessionId"

    // MARK: - Input fields (bound to CompIQView form)
    @Published var playerName = ""
    @Published var cardName   = ""
    @Published var parallel   = ""
    @Published var grade      = "Raw"
    @Published var costInput  = ""

    // MARK: - State
    @Published var isLoading    = false
    @Published var errorMessage: String?
    @Published var estimateResult: CompIQEstimateResult?
    /// Broader-pool trend signal from pricing engine v3.
    /// Surface in CompIQView when `basedOn == "broader_pool"` to show the
    /// user that the trend direction is backed by similar-card sales rather
    /// than just this card's own (often thin) comp history.
    @Published var broaderTrend: CompIQBroaderTrend?

    // MARK: - Legacy
    @Published var searchResult: CardSearchResponse?

    private let api = APIService.shared

    // MARK: - priceCard (called by CompIQView)
    func priceCard() async {
        let name = playerName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else {
            errorMessage = "Player name is required."
            return
        }
        isLoading     = true
        errorMessage  = nil
        estimateResult = nil
        broaderTrend  = nil

        let (cardYear, product, isAuto) = parseCardName(cardName)
        let parallelVal = parallel.trimmingCharacters(in: .whitespaces).isEmpty ? nil
                        : parallel.trimmingCharacters(in: .whitespaces)
        let gradeVal    = grade == "Raw" ? nil : grade

        let request = CompIQPriceRequest(
            playerName: name,
            cardYear: cardYear,
            product: product,
            parallel: parallelVal,
            grade: gradeVal,
            isAuto: isAuto
        )
        do {
            let response = try await api.priceCardEstimate(request: request)
            estimateResult = response.asEstimateResult(requestedParallel: parallelVal)
            broaderTrend = response.broaderTrend
            await syncPortfolioPricing(
                request: request,
                fairMarketValue: response.fairMarketValue,
                quickSaleValue: response.quickSaleValue,
                premiumValue: response.premiumValue,
                verdict: response.summary,
                recommendation: response.recommendation
            )
        } catch {
            errorMessage = "Pricing failed — please try again."
        }
        isLoading = false
    }

    // MARK: - Live CompIQ -> PortfolioIQ sync
    private func normalizeKey(_ value: String?) -> String {
        (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func holdingMatchesCompRequest(_ holding: PortfolioHolding, request: CompIQPriceRequest) -> Bool {
        guard normalizeKey(holding.playerName) == normalizeKey(request.playerName) else {
            return false
        }

        if let requestedParallel = request.parallel, !requestedParallel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let holdingParallel = normalizeKey(holding.parallel)
            if holdingParallel.isEmpty || holdingParallel != normalizeKey(requestedParallel) {
                return false
            }
        }

        if let requestedGrade = request.grade, !requestedGrade.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let gradeKey = normalizeKey(requestedGrade)
            if gradeKey == "raw" {
                if !holding.isRaw { return false }
            } else {
                if normalizeKey(holding.grade) != gradeKey { return false }
            }
        }

        if let requestedProduct = request.product, !requestedProduct.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let requested = normalizeKey(requestedProduct)
            let product = normalizeKey(holding.product)
            let setName = normalizeKey(holding.setName)
            if !product.contains(requested) && !setName.contains(requested) {
                return false
            }
        }

        return true
    }

    private func syncPortfolioPricing(
        request: CompIQPriceRequest,
        fairMarketValue: Double?,
        quickSaleValue: Double?,
        premiumValue: Double?,
        verdict: String?,
        recommendation: String?
    ) async {
        guard let fmv = fairMarketValue, fmv > 0 else { return }
        guard let sessionId = UserDefaults.standard.string(forKey: authSessionKey), !sessionId.isEmpty else { return }

        do {
            let response = try await api.fetchPortfolioHoldings(sessionId: sessionId)
            let matches = response.holdings.filter { holdingMatchesCompRequest($0, request: request) }
            guard !matches.isEmpty else { return }

            for var holding in matches {
                holding.currentValue = fmv
                holding.fairMarketValue = fmv
                if let qsv = quickSaleValue { holding.quickSaleValue = qsv }
                if let pv = premiumValue { holding.premiumValue = pv }
                if let verdict, !verdict.isEmpty { holding.verdict = verdict }
                if let recommendation, !recommendation.isEmpty { holding.recommendation = recommendation }
                holding.freshnessStatus = .live
                holding.lastUpdated = Date()

                let basis = holding.totalCostBasis
                holding.totalProfitLoss = fmv - basis
                holding.totalProfitLossPct = basis > 0 ? ((fmv - basis) / basis) * 100 : 0

                _ = try? await api.updatePortfolioHolding(holding, sessionId: sessionId)
            }
        } catch {
            // Do not fail CompIQ UX if portfolio sync fails.
            print("[CompIQ] Portfolio sync skipped: \(error)")
        }
    }

    // MARK: - Parse card name into (year, product, isAuto)
    private func parseCardName(_ raw: String) -> (Int?, String, Bool?) {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return (nil, "Bowman Chrome", nil) }
        let lower   = trimmed.lowercased()
        let isAuto  = lower.contains("auto") ? true : nil
        var year: Int? = nil
        for token in trimmed.components(separatedBy: .whitespaces) {
            if let y = Int(token), y >= 2010 && y <= 2030 { year = y; break }
        }
        return (year, trimmed, isAuto)
    }

    // MARK: - Legacy helpers
    func search(query: String) async {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        isLoading    = true
        errorMessage = nil
        do {
            searchResult = try await api.searchCards(query: query)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func estimate(subject: CompIQSubject, comps: [CompIQComp] = [], context: CompIQContext = CompIQContext(activeListings: nil, soldCount30d: nil, playerTrendScore: nil, scarcityScore: nil)) async {
        isLoading    = true
        errorMessage = nil
        do {
            let request = CompIQEstimateRequest(subject: subject, comps: comps, context: context, debug: nil)
            let response = try await api.estimateCard(request: request)
            _ = response // legacy path — not mapped to estimateResult
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

