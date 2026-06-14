//
//  APIService.swift
//  HobbyIQ
//

import Foundation

enum APIServiceError: LocalizedError {
    case invalidURL
    case invalidResponse
    case authenticationRequired
    case httpError(statusCode: Int, body: String)
    case decodingFailed(Error)
    case networkFailed(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The live API URL is invalid."
        case .invalidResponse:
            return "The server sent an invalid response."
        case .authenticationRequired:
            return "Your session expired. Please sign in again."
        case let .httpError(statusCode, body):
            let backendMessage = APIService.backendMessage(from: body)
            switch statusCode {
            case 401:
                return APIService.joinMessages("Your session expired. Please sign in again.", backendMessage)
            case 402:
                return backendMessage.isEmpty ? "You've reached your plan limit. Upgrade for more." : backendMessage
            case 403:
                return APIService.joinMessages("eBay account not connected. Connect eBay first.", backendMessage)
            case 404:
                return backendMessage.isEmpty ? "The requested resource was not found." : backendMessage
            default:
                return APIService.joinMessages("The server returned status \(statusCode).", backendMessage.isEmpty ? body : backendMessage)
            }
        case let .decodingFailed(error):
            return "Could not read the live response. \(error.localizedDescription)"
        case let .networkFailed(error):
            return "The network request failed. \(error.localizedDescription)"
        }
    }
}

struct APIService {
    static let shared = APIService()

    private let baseURLString = APIConfig.baseURL.absoluteString
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            // CF-FIND-CARDS-REGROUND: keep per-request default at 15s
            // (per-endpoint overrides via URLRequest.timeoutInterval still
            // win), but raise the resource ceiling above the longest
            // per-endpoint override (cardsearch = 30s) so the session
            // doesn't preempt a legitimately long single request.
            configuration.timeoutIntervalForRequest = 15
            configuration.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: configuration)
        }
    }

    func analyzeComp(query: String) async throws -> CompIQResponse {
        let request = CompIQAnalyzeRequest(
            query: query,
            player: query,
            cardType: "Baseball Card",
            parallel: "Unknown",
            grade: "Raw",
            recentComps: [100, 120, 140]
        )
        return try await post(path: "/api/compiq/estimate", body: request, responseType: CompIQResponse.self)
    }

    func analyzePlayer(query: String) async throws -> PlayerIQResponse {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? query
        do {
            return try await get(path: "/api/playeriq/\(encoded)", responseType: PlayerIQResponse.self)
        } catch let error as APIServiceError {
            if case .httpError(let statusCode, _) = error, statusCode == 404 {
                throw APIServiceError.httpError(statusCode: 404, body: "Player \"\(query)\" not found. Try searching by full name (e.g. \"Mike Trout\").")
            }
            throw error
        }
    }

    func fetchPlayerStats(playerName: String) async throws -> PlayerStatsResponse {
        let encoded = playerName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? playerName
        return try await get(path: "/api/playeriq/\(encoded)/stats", responseType: PlayerStatsResponse.self)
    }

    func estimateCardDirect(request: CardEstimateRequest) async throws -> CardEstimateResponse {
        try await post(path: "/api/compiq/estimate", body: request, responseType: CardEstimateResponse.self)
    }

    func searchCompIQ(query: String) async throws -> CompIQSearchResponse {
        let body = CompIQSearchRequest(query: query)
        return try await post(path: "/api/compiq/search", body: body, responseType: CompIQSearchResponse.self)
    }

    func searchVariantList(query: String) async throws -> CompIQVariantListResponse {
        let body = CompIQVariantSearchRequest(query: query)
        // CF-FIND-CARDS-REGROUND: cardsearch needs headroom. Dispatcher's
        // Cardsight enrichment is several seconds on a cold cache for broad
        // queries ("Mike Trout", "Bowman Chrome"); the default 10s URLRequest
        // timeout fired before the dispatcher could finish, surfacing as a
        // false "search timed out" to the user. 30s covers cold-cache broad
        // queries while still letting the user Cancel via the picker's
        // shimmer state.
        return try await post(
            path: "/api/compiq/cardsearch",
            body: body,
            responseType: CompIQVariantListResponse.self,
            timeoutSeconds: 30
        )
    }

    func priceByCardId(
        cardsightCardId: String,
        query: String?,
        gradeCompany: String?,
        gradeValue: Double?,
        parallelId: String? = nil,
        parallelName: String? = nil
    ) async throws -> CompIQPriceByIdResponse {
        // CF-PRICE-BY-ID-ROUTE (2026-06-07): when a candidate id is pinned,
        // send id + grade ONLY — omit a meaningful query. Backend treats a
        // non-empty `query` alongside `cardsightCardId` as free-text intent
        // and routes through findCompsRouted, which bypasses the pinned-card
        // schema fix and the returned-id consistency guard shipped in
        // f7d2f97 (resulting in Frazier $1 / 4-of-4 instead of Trout $377 /
        // 20-of-26 for fda530ab…). Forcing query=nil here drops
        // hasMeaningfulQuery=true on the backend so the request lands on
        // the pinned path. Callers keep their query string for ergonomics;
        // we only strip it on the wire when an id is actually present.
        let pinnedQuery: String? = cardsightCardId.isEmpty ? query : nil
        // CF-PARALLEL-SUBMARKET (2026-06-10): when a parallel is selected,
        // backend wants `cardsightCardId = parent base UUID` PLUS
        // `parallelId = parallel UUID` so the comp filter narrows to the
        // matched sub-market (vs the parallel UUID landing on
        // cardsightCardId alone, which doesn't resolve as a pricing key).
        // Empty/whitespace parallelId is dropped to nil so the wire body
        // doesn't carry a meaningless field.
        let cleanParallelId: String? = {
            guard let raw = parallelId?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false else { return nil }
            return raw
        }()
        let cleanParallelName: String? = {
            guard let raw = parallelName?.trimmingCharacters(in: .whitespaces),
                  raw.isEmpty == false else { return nil }
            return raw
        }()
        let body = CompIQPriceByIdRequest(
            cardsightCardId: cardsightCardId,
            query: pinnedQuery,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            parallelId: cleanParallelId,
            parallelName: cleanParallelName
        )
        // CF-COMP-PAGE-RECON (2026-06-07): inline request to capture the
        // raw response BEFORE decode so an out-of-band diff against the
        // model can identify any silently-dropped fields. Writes
        // Documents/price_by_id_recon.json on every call (overwrite).
        // DEBUG-only. Mirrors the existing post() → perform() chain
        // otherwise; on release builds we fall through to post() so the
        // generic helper handles it.
        // CF-FIND-CARDS-REGROUND: price-by-id needs headroom too. With a
        // `query` + `parallelId` + `parallelName` (the natural shape a
        // comp-page tap produces for a graded auto parallel), backend
        // routes through findCompsRouted, which aggregates comps from
        // multiple sources and can run several seconds on a cold cache.
        // The 10s default URLRequest timeout was firing before the
        // dispatcher could finish on broader queries (observed: "2024
        // bowman CHROME BLUE AUTO LEO DE VRIES" → 10s timeout).
        #if DEBUG
        return try await debugPriceByIdWithDump(body: body)
        #else
        return try await post(
            path: "/api/compiq/price-by-id",
            body: body,
            responseType: CompIQPriceByIdResponse.self,
            timeoutSeconds: 30
        )
        #endif
    }

    #if DEBUG
    private func debugPriceByIdWithDump(body: CompIQPriceByIdRequest) async throws -> CompIQPriceByIdResponse {
        let path = "/api/compiq/price-by-id"
        let bodyData = try encoder.encode(body)
        // Match the release-path timeout (CF-FIND-CARDS-REGROUND) — the
        // DEBUG dump shouldn't preempt a request the release build would
        // happily wait on.
        let request = try makeRequest(path: path, method: "POST", bodyData: bodyData, sessionId: nil, timeoutSeconds: 30)
        let context = requestContext(request)
        do {
            let (data, response) = try await session.data(for: request)
            let rawResponse = String(data: data, encoding: .utf8) ?? ""
            // Build the recon dump — request + rawResponseBody (verbatim,
            // pre-decode). Human-readable grade label so the diff target
            // matches what the comp page would have asked for in plain
            // English ("Raw", "PSA 10", "BGS 9.5").
            let gradeLabel: String = {
                guard let company = body.gradeCompany, let value = body.gradeValue else { return "Raw" }
                let trimmed = value.truncatingRemainder(dividingBy: 1) == 0
                    ? String(Int(value))
                    : String(value)
                return "\(company) \(trimmed)"
            }()
            let dump: [String: Any] = [
                "request": [
                    "cardsightCardId": body.cardsightCardId,
                    "grade": gradeLabel,
                ],
                "rawResponseBody": rawResponse,
            ]
            if JSONSerialization.isValidJSONObject(dump),
               let dumpData = try? JSONSerialization.data(withJSONObject: dump, options: [.prettyPrinted]) {
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
                if let docs {
                    let url = docs.appendingPathComponent("price_by_id_recon.json")
                    try? dumpData.write(to: url, options: .atomic)
                    print("[PRICE-BY-ID-RECON] wrote", url.path, "bytes:", dumpData.count)
                }
            }
            print("[APIService] Response", context, "body:", rawResponse)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIServiceError.invalidResponse
            }
            print("[APIService] Status", context, httpResponse.statusCode)
            guard 200..<300 ~= httpResponse.statusCode else {
                throw APIServiceError.httpError(statusCode: httpResponse.statusCode, body: rawResponse)
            }
            do {
                return try decoder.decode(CompIQPriceByIdResponse.self, from: data)
            } catch {
                print("[APIService] Decode error", context, error.localizedDescription)
                throw APIServiceError.decodingFailed(error)
            }
        } catch let error as APIServiceError {
            print("[APIService] API error", context, error.errorDescription ?? error.localizedDescription)
            throw error
        } catch {
            print("[APIService] Network error", context, error.localizedDescription)
            throw APIServiceError.networkFailed(error)
        }
    }
    #endif

    // MARK: - CompIQ Advanced Endpoints

    func fetchTrendIQ(request: TrendIQRequest) async throws -> TrendIQDedicatedResponse {
        try await post(path: "/api/compiq/trendiq", body: request, responseType: TrendIQDedicatedResponse.self)
    }

    func fetchTrendIQFull(request: TrendIQRequest) async throws -> TrendIQFullResponse {
        try await post(path: "/api/compiq/trendiq/full", body: request, responseType: TrendIQFullResponse.self)
    }

    func fetchMarketTrend(playerName: String) async throws -> MarketTrendResponse {
        try await get(
            path: "/api/compiq/market-trend",
            queryItems: [URLQueryItem(name: "playerName", value: playerName)],
            responseType: MarketTrendResponse.self
        )
    }

    func fetchMarketTrendBatch(playerNames: [String]) async throws -> MarketTrendBatchResponse {
        try await get(
            path: "/api/compiq/market-trend/batch",
            queryItems: [URLQueryItem(name: "playerNames", value: playerNames.joined(separator: ","))],
            responseType: MarketTrendBatchResponse.self
        )
    }

    func fetchTopMovers(window: String = "7d", limit: Int = 20) async throws -> TopMoversResponse {
        try await get(
            path: "/api/compiq/market-trend/top-movers",
            queryItems: [
                URLQueryItem(name: "window", value: window),
                URLQueryItem(name: "limit", value: String(limit)),
            ],
            responseType: TopMoversResponse.self
        )
    }

    func whatIfEstimate(request: WhatIfRequest) async throws -> CardEstimateResponse {
        try await post(path: "/api/compiq/what-if", body: request, responseType: CardEstimateResponse.self)
    }

    func fetchGradePremium(request: GradePremiumRequest) async throws -> GradePremiumResponse {
        try await post(path: "/api/compiq/grade-premium", body: request, responseType: GradePremiumResponse.self)
    }

    func fetchSellWindow(request: SellWindowRequest) async throws -> SellWindowResponse {
        try await post(path: "/api/compiq/sell-window", body: request, responseType: SellWindowResponse.self)
    }

    func bulkEstimateAdvanced(request: AdvancedBulkEstimateRequest) async throws -> AdvancedBulkEstimateResponse {
        try await post(path: "/api/compiq/bulk", body: request, responseType: AdvancedBulkEstimateResponse.self)
    }

    func fetchCompsByPlayer(playerName: String, product: String? = nil, cardYear: Int? = nil) async throws -> CompsByPlayerResponse {
        var queryItems = [URLQueryItem(name: "playerName", value: playerName)]
        if let product { queryItems.append(URLQueryItem(name: "product", value: product)) }
        if let cardYear { queryItems.append(URLQueryItem(name: "cardYear", value: String(cardYear))) }
        return try await get(
            path: "/api/compiq/comps-by-player",
            queryItems: queryItems,
            responseType: CompsByPlayerResponse.self
        )
    }

    // MARK: - Portfolio Advanced Endpoints

    func fetchPortfolioHealth() async throws -> PortfolioHealthResponse {
        try await get(path: "/api/portfolio/health/score", responseType: PortfolioHealthResponse.self)
    }

    func fetchCalibration() async throws -> CalibrationReportResponse {
        try await get(path: "/api/portfolio/analytics/calibration", responseType: CalibrationReportResponse.self)
    }

    func fetchWeeklyBrief() async throws -> WeeklyBriefResponse {
        try await get(path: "/api/portfolio/insights/weekly-brief", responseType: WeeklyBriefResponse.self)
    }

    func submitRecommendationFeedback(request: RecommendationFeedbackRequest) async throws -> RecommendationFeedbackResponse {
        try await post(path: "/api/portfolio/feedback/recommendation", body: request, responseType: RecommendationFeedbackResponse.self)
    }

    func fetchHoldingHistory(holdingId: String) async throws -> HoldingPriceHistoryResponse {
        try await get(path: "/api/portfolio/holdings/\(holdingId)/history", responseType: HoldingPriceHistoryResponse.self)
    }

    func refreshHolding(holdingId: String) async throws -> RefreshHoldingResponse {
        try await post(path: "/api/portfolio/holdings/\(holdingId)/refresh", body: EmptyBody(), responseType: RefreshHoldingResponse.self)
    }

    func runBatchReprice() async throws -> BatchRepriceResponse {
        try await post(path: "/api/portfolio/reprice/batch", body: EmptyBody(), responseType: BatchRepriceResponse.self)
    }

    func requestCardPhotoSAS(fileExtension: String = "jpg") async throws -> SASUploadResponse {
        try await post(path: "/api/uploads/card-photo", body: SASUploadRequest(clientId: nil, fileExtension: fileExtension), responseType: SASUploadResponse.self)
    }

    func uploadImageToSAS(uploadUrl: String, imageData: Data, contentType: String) async throws {
        guard let url = URL(string: uploadUrl) else {
            throw APIServiceError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("BlockBlob", forHTTPHeaderField: "x-ms-blob-type")
        request.httpBody = imageData

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIServiceError.httpError(statusCode: code, body: String(data: data, encoding: .utf8) ?? "")
        }
    }

    func identifyCard(request: CardIdentifyRequest) async throws -> CardIdentifyResponse {
        try await post(path: "/api/portfolio/identify", body: request, responseType: CardIdentifyResponse.self)
    }

    func fetchIdentifiableSets(segment: String? = nil, skip: Int = 0, take: Int = 100) async throws -> IdentifiableSetsResponse {
        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "skip", value: String(skip)),
            URLQueryItem(name: "take", value: String(take)),
        ]
        if let segment { queryItems.append(URLQueryItem(name: "segment", value: segment)) }
        return try await get(path: "/api/portfolio/identifiable-sets", queryItems: queryItems, responseType: IdentifiableSetsResponse.self)
    }

    func checkSetSupported(setId: String) async throws -> SetSupportedResponse {
        try await get(
            path: "/api/portfolio/identify/set-supported",
            queryItems: [URLQueryItem(name: "setId", value: setId)],
            responseType: SetSupportedResponse.self
        )
    }

    // MARK: - ERP Endpoints

    func fetchUnreconciled() async throws -> UnreconciledListResponse {
        try await get(path: "/api/portfolio/erp/unreconciled", responseType: UnreconciledListResponse.self)
    }

    func fetchAgingBuckets() async throws -> AgingBucketsResponse {
        // Backend mounts this under /unreconciled/aging (not /aging).
        try await get(path: "/api/portfolio/erp/unreconciled/aging", responseType: AgingBucketsResponse.self)
    }

    func submitOverride(entryId: String, request: ERPOverrideRequest) async throws -> ERPOverrideResponse {
        try await post(path: "/api/portfolio/erp/override/\(entryId)", body: request, responseType: ERPOverrideResponse.self)
    }

    func refetchFinances() async throws -> ERPRefetchResponse {
        try await post(path: "/api/portfolio/erp/refetch", body: EmptyBody(), responseType: ERPRefetchResponse.self)
    }

    func fetchErpPnl(groupBy: String = "month", includeExpenses: Bool = false) async throws -> ERPPnlResponse {
        try await get(
            path: "/api/portfolio/erp/pnl",
            queryItems: [
                URLQueryItem(name: "groupBy", value: groupBy),
                URLQueryItem(name: "includeExpenses", value: includeExpenses ? "true" : "false"),
            ],
            responseType: ERPPnlResponse.self
        )
    }

    func fetchErpAnalytics(groupBy: String = "month") async throws -> ERPAnalyticsResponse {
        try await get(
            path: "/api/portfolio/erp/analytics",
            queryItems: [URLQueryItem(name: "groupBy", value: groupBy)],
            responseType: ERPAnalyticsResponse.self
        )
    }

    func fetchErpTimeseries(bucket: String = "month") async throws -> ERPTimeseriesResponse {
        // Backend mounts this under /analytics/timeseries with `bucket` query (month|quarter).
        try await get(
            path: "/api/portfolio/erp/analytics/timeseries",
            queryItems: [URLQueryItem(name: "bucket", value: bucket)],
            responseType: ERPTimeseriesResponse.self
        )
    }

    func fetchErpValuation() async throws -> ERPValuationResponse {
        try await get(path: "/api/portfolio/erp/valuation", responseType: ERPValuationResponse.self)
    }

    func fetchExpenses() async throws -> ERPExpenseListResponse {
        try await get(path: "/api/portfolio/erp/expenses", responseType: ERPExpenseListResponse.self)
    }

    func createExpense(request: ERPExpenseCreateRequest) async throws -> ERPExpenseResponse {
        try await post(path: "/api/portfolio/erp/expenses", body: request, responseType: ERPExpenseResponse.self)
    }

    func updateExpense(expenseId: String, request: ERPExpenseUpdateRequest) async throws -> ERPExpenseResponse {
        try await patch(path: "/api/portfolio/erp/expenses/\(expenseId)", body: request, responseType: ERPExpenseResponse.self)
    }

    func deleteExpense(expenseId: String) async throws -> ERPExpenseDeleteResponse {
        try await delete(path: "/api/portfolio/erp/expenses/\(expenseId)", responseType: ERPExpenseDeleteResponse.self)
    }

    func fetchExpenseReport(groupBy: String = "category") async throws -> ERPExpenseReportResponse {
        try await get(
            path: "/api/portfolio/erp/expenses/report",
            queryItems: [URLQueryItem(name: "groupBy", value: groupBy)],
            responseType: ERPExpenseReportResponse.self
        )
    }

    func recordTrade(request: ERPTradeRecordRequest) async throws -> ERPTradeRecordResponse {
        try await post(path: "/api/portfolio/erp/trades", body: request, responseType: ERPTradeRecordResponse.self)
    }

    func fetchTrades() async throws -> ERPTradeListResponse {
        try await get(path: "/api/portfolio/erp/trades", responseType: ERPTradeListResponse.self)
    }

    func fetchTradeDetail(tradeId: String) async throws -> ERPTradeRecordResponse {
        try await get(path: "/api/portfolio/erp/trades/\(tradeId)", responseType: ERPTradeRecordResponse.self)
    }

    func fetchTaxFilings(year: Int) async throws -> ERPTaxFilingsResponse {
        try await get(
            path: "/api/portfolio/erp/tax/filings",
            queryItems: [URLQueryItem(name: "year", value: String(year))],
            responseType: ERPTaxFilingsResponse.self
        )
    }

    func updateTaxFiling(year: Int, rail: String, request: ERPTaxFilingUpdateRequest) async throws -> ERPTaxFilingUpdateResponse {
        try await put(
            path: "/api/portfolio/erp/tax/filings/\(year)/\(rail)",
            body: request,
            responseType: ERPTaxFilingUpdateResponse.self
        )
    }

    func fetchAccountingExport(year: Int, format: String = "json") async throws -> ERPAccountingExportResponse {
        try await get(
            path: "/api/portfolio/erp/accounting-export",
            queryItems: [
                URLQueryItem(name: "year", value: String(year)),
                URLQueryItem(name: "format", value: format),
            ],
            responseType: ERPAccountingExportResponse.self
        )
    }

    func fetchTaxExport(year: Int, format: String = "json") async throws -> ERPTaxExportResponse {
        try await get(
            path: "/api/portfolio/erp/tax-export",
            queryItems: [
                URLQueryItem(name: "year", value: String(year)),
                URLQueryItem(name: "format", value: format),
            ],
            responseType: ERPTaxExportResponse.self
        )
    }

    func healthCheck() async throws -> HealthStatusResponse {
        try await get(path: "/api/health", responseType: HealthStatusResponse.self)
    }

    func signInWithApple(identityToken: String, email: String?, fullName: String?, username: String?) async throws -> AuthSignInResponse {
        let body = AppleSignInRequest(identityToken: identityToken, email: email, fullName: fullName, username: username)
        let response = try await post(path: "/api/auth/apple", body: body, responseType: AuthSignInResponse.self)
        try validateAuthResponse(response)
        return response
    }

    func signInWithEmail(email: String, password: String) async throws -> AuthSignInResponse {
        let request = AuthEmailSignInRequest(email: email, password: password)
        let response = try await post(path: "/api/auth/signin", body: request, responseType: AuthSignInResponse.self)
        try validateAuthResponse(response)
        return response
    }

    func signUpWithEmail(email: String, password: String, username: String) async throws -> AuthSignInResponse {
        // Try the register endpoint first
        let signUpRequest = AuthEmailSignUpRequest(username: username, email: email, password: password)
        do {
            let response = try await post(path: "/api/auth/register", body: signUpRequest, responseType: AuthSignInResponse.self)
            try validateAuthResponse(response)
            return response
        } catch let apiError as APIServiceError {
            // If register route doesn't exist (404), fall back to signin
            if case .httpError(let statusCode, _) = apiError, statusCode == 404 {
                let signInRequest = AuthEmailSignInRequest(email: email, password: password)
                let response = try await post(path: "/api/auth/signin", body: signInRequest, responseType: AuthSignInResponse.self)
                try validateAuthResponse(response)
                return response
            }
            throw apiError
        }
    }

    private func validateAuthResponse(_ response: AuthSignInResponse) throws {
        if response.success == false {
            let message = response.error ?? "Invalid credentials."
            throw APIServiceError.httpError(statusCode: 401, body: message)
        }
        guard response.user != nil, response.sessionId != nil else {
            throw APIServiceError.invalidResponse
        }
    }

    func fetchDailyBrief(userId _: String, date: String? = nil) async throws -> DailyIQResponse {
        let queryItems = date.map { [URLQueryItem(name: "date", value: $0)] } ?? []
        let data = try await fetchData(path: "/api/dailyiq/", queryItems: queryItems)
        let backend = try decoder.decode(DailyIQBackendBriefResponse.self, from: data)
        return backend.asAppResponse(dateFallback: date)
    }

    func fetchDailyTopMLBPlayers(date: String? = nil) async throws -> [DailyPlayerStat] {
        try await fetchDailyTopPlayers(path: "/api/dailyiq/players/top/mlb", date: date)
    }

    func fetchDailyTopMiLBPlayers(date: String? = nil) async throws -> [DailyPlayerStat] {
        try await fetchDailyTopPlayers(path: "/api/dailyiq/players/top/milb", date: date)
    }

    func fetchDailyWatchlist(date: String? = nil) async throws -> [WatchPlayerResult] {
        let queryItems = date.map { [URLQueryItem(name: "date", value: $0)] } ?? []
        let data = try await fetchData(path: "/api/dailyiq/watchlist", queryItems: queryItems)

        if let backend = try? decoder.decode(DailyIQBackendWatchlistEnvelope.self, from: data) {
            return backend.watchlist.map(Self.makeWatchlistResult(from:))
        }

        let envelope = try decoder.decode(DailyWatchlistEnvelope.self, from: data)
        return envelope.watchlist
    }

    func addDailyWatchlistEntry(
        userId: String = "",
        playerId: String,
        playerName: String,
        team: String? = nil,
        level: String? = nil,
        position: String? = nil,
        date: String? = nil
    ) async throws -> [WatchPlayerResult] {
        let body = DailyIQWatchlistAddRequest(playerId: playerId, playerName: playerName)
        _ = try await post(
            path: "/api/dailyiq/watchlist",
            body: body,
            responseType: DailyIQWatchlistAddResponse.self
        )
        return try await fetchDailyWatchlist(date: date)
    }

    func removeDailyWatchlistEntry(
        userId: String = "",
        playerId: String,
        playerName: String,
        team: String? = nil,
        level: String? = nil,
        position: String? = nil,
        date: String? = nil
    ) async throws -> [WatchPlayerResult] {
        let encoded = playerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? playerId
        _ = try await delete(
            path: "/api/dailyiq/watchlist/\(encoded)",
            responseType: DailyIQWatchlistRemoveResponse.self
        )
        return try await fetchDailyWatchlist(date: date)
    }

    // MARK: - DailyIQ Watchlist Search / Top / Suggest

    func watchlistSearch(query: String) async throws -> WatchlistSearchResponse {
        let body = DailyIQWatchlistSearchRequest(query: query)
        return try await post(path: "/api/dailyiq/watchlist/search", body: body, responseType: WatchlistSearchResponse.self)
    }

    func watchlistTop() async throws -> WatchlistTopResponse {
        try await get(path: "/api/dailyiq/watchlist/top", responseType: WatchlistTopResponse.self)
    }

    func watchlistSuggest() async throws -> WatchlistSuggestResponse {
        try await get(path: "/api/dailyiq/watchlist/suggest", responseType: WatchlistSuggestResponse.self)
    }

    // MARK: - DailyIQ Search (ungated)

    func dailyiqSearch(query: String, limit: Int = 10) async throws -> DailyIQSearchResponse {
        try await get(
            path: "/api/dailyiq/search",
            queryItems: [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "limit", value: String(limit)),
            ],
            responseType: DailyIQSearchResponse.self
        )
    }

    // MARK: - DailyIQ Full Brief (gated dailyIQBriefs / investor+)

    func fetchFullBrief() async throws -> DailyIQFullBriefResponse {
        try await get(path: "/api/dailyiq/brief", responseType: DailyIQFullBriefResponse.self)
    }

    // MARK: - Dashboard Player Stats (gated dailyIQBriefs)

    func fetchDashboardPlayerStats() async throws -> DashboardPlayerStatsResponse {
        try await get(path: "/api/dailyiq/dashboard/player-stats", responseType: DashboardPlayerStatsResponse.self)
    }

    func fetchPortfolioIQSummary(userId: String = "") async throws -> PortfolioIQBackendSummaryResponse {
        // Derive summary from holdings since /api/portfolioiq/summary doesn't exist
        let holdings = try await fetchPortfolioHoldings(userId: userId)
        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalPL = totalValue - totalCost
        let roi = totalCost > 0 ? (totalPL / totalCost) * 100 : 0
        return PortfolioIQBackendSummaryResponse(
            inventory: PortfolioInventorySummary(
                totalCost: totalCost,
                totalCurrentValue: totalValue,
                totalProfitLoss: totalPL,
                roi: roi,
                activeCount: holdings.count
            ),
            month: nil,
            year: nil
        )
    }

    func fetchPortfolioHoldings(userId: String = "") async throws -> [InventoryCard] {
        let envelope: PortfolioIQHoldingsEnvelope = try await get(
            path: "/api/portfolio",
            queryItems: portfolioUserQueryItems(userId: userId),
            responseType: PortfolioIQHoldingsEnvelope.self
        )
        return envelope.holdings
    }

    /// CF-ADD-TO-INVENTORY (2026-06-12): POST /api/portfolioiq/holdings.
    /// Identity-gated server-side; auto-prices the holding (the response is
    /// already comped, so the inventory view can render the new row at its
    /// estimated value without a refetch). `parallelId` is the load-bearing
    /// field for graded-scope valuation — without it the rail estimates
    /// fall back to base scope and the holding values at the wrong number.
    func addPortfolioHolding(_ body: AddHoldingRequest) async throws -> AddHoldingResponse {
        try await post(
            path: "/api/portfolioiq/holdings",
            body: body,
            responseType: AddHoldingResponse.self
        )
    }

    func fetchPortfolioLedger(userId: String = "") async throws -> PortfolioLedgerResponse {
        try await get(
            path: "/api/portfolio/ledger",
            queryItems: portfolioUserQueryItems(userId: userId),
            responseType: PortfolioLedgerResponse.self
        )
    }

    func updateLedgerEntry(id: String, body: LedgerPatchBody) async throws -> PortfolioLedgerEntry {
        let response: LedgerPatchResponse = try await patch(
            path: "/api/portfolio/ledger/\(id)",
            body: body,
            responseType: LedgerPatchResponse.self
        )
        return response.entry
    }

    func ebayConnectionStatus(sessionId: String? = nil) async throws -> EBayConnectionStatusResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await get(
            path: "/api/ebay/status",
            responseType: EBayConnectionStatusResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayConnectStart(sessionId: String? = nil) async throws -> EBayConnectStartResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await get(
            path: "/api/ebay/connect/start",
            responseType: EBayConnectStartResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayDisconnect(sessionId: String? = nil) async throws -> EBayDisconnectResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await delete(
            path: "/api/ebay/disconnect",
            responseType: EBayDisconnectResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayPreviewListing(body: PortfolioEbayListingRequest, sessionId: String? = nil) async throws -> PortfolioEbayListingResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await post(
            path: "/api/ebay/listings/preview",
            body: body,
            responseType: PortfolioEbayListingResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayPublishListing(body: PortfolioEbayListingRequest, sessionId: String? = nil) async throws -> PortfolioEbayListingResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await post(
            path: "/api/ebay/listings/publish",
            body: body,
            responseType: PortfolioEbayListingResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayReconnect(sessionId: String? = nil) async throws -> EBayReconnectResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await get(
            path: "/api/ebay/connect/restart",
            responseType: EBayReconnectResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayPolicies(sessionId: String? = nil) async throws -> EbayPoliciesResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await get(
            path: "/api/ebay/policies",
            responseType: EbayPoliciesResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayListingStatus(offerId: String, sessionId: String? = nil) async throws -> EbayListingStatusResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        let encoded = offerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? offerId
        return try await get(
            path: "/api/ebay/listings/\(encoded)/status",
            responseType: EbayListingStatusResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayReviseListing(offerId: String, body: PortfolioEbayListingRequest, sessionId: String? = nil) async throws -> EbayReviseResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        let encoded = offerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? offerId
        return try await put(
            path: "/api/ebay/listings/\(encoded)/revise",
            body: body,
            responseType: EbayReviseResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func ebayEndListing(offerId: String, sessionId: String? = nil) async throws -> EbayEndListingResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        let encoded = offerId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? offerId
        return try await post(
            path: "/api/ebay/listings/\(encoded)/end",
            body: EmptyBody(),
            responseType: EbayEndListingResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func fetchPSACertLookup(certNumber: String, sessionId: String? = nil) async throws -> PSACertLookupResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        let encoded = certNumber.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? certNumber
        let data = try await fetchData(
            path: "/api/psa/cert/\(encoded)",
            queryItems: [],
            sessionId: resolvedSessionId
        )

        // Strategy 1: Direct decode of our expected shape
        if let resp = try? JSONDecoder().decode(PSACertLookupResponse.self, from: data) {
            return resp
        }

        // Strategy 2: PascalCase keys (PSA public API format)
        let pascalDecoder = JSONDecoder()
        pascalDecoder.keyDecodingStrategy = .convertFromSnakeCase
        if let resp = try? pascalDecoder.decode(PSACertLookupResponse.self, from: data) {
            return resp
        }

        // Strategy 3: Backend returns PSA data as a flat card object (no wrapper)
        if let card = try? JSONDecoder().decode(PSACardInfo.self, from: data) {
            return PSACertLookupResponse(success: true, certNumber: certNumber, error: nil, card: card)
        }

        // Strategy 4: Wrapped in a "PSACert" key (PSA public API envelope)
        if let envelope = try? JSONDecoder().decode(PSACertEnvelope.self, from: data) {
            return PSACertLookupResponse(success: true, certNumber: certNumber, error: nil, card: envelope.psaCert)
        }
        let pascalEnvelopeDecoder = JSONDecoder()
        pascalEnvelopeDecoder.keyDecodingStrategy = .convertFromSnakeCase
        if let envelope = try? pascalEnvelopeDecoder.decode(PSACertEnvelope.self, from: data) {
            return PSACertLookupResponse(success: true, certNumber: certNumber, error: nil, card: envelope.psaCert)
        }

        // None worked — log raw body for debugging
        let raw = String(data: data, encoding: .utf8) ?? "<binary>"
        #if DEBUG
        print("[APIService] PSA cert decode failed. Raw response: \(raw)")
        #endif
        throw APIServiceError.decodingFailed(DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "PSA cert response format not recognized. Raw: \(raw.prefix(500))"
        )))
    }

    func portfolioEbayDraft(holdingId: String, body: PortfolioEbayListingRequest, sessionId: String? = nil) async throws -> PortfolioEbayListingResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await post(
            path: "/api/portfolio/holdings/\(holdingId)/ebay/draft",
            body: body,
            responseType: PortfolioEbayListingResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func portfolioEbayListing(holdingId: String, body: PortfolioEbayListingRequest, sessionId: String? = nil) async throws -> PortfolioEbayListingResponse {
        let resolvedSessionId = try requireSessionId(sessionId)
        return try await post(
            path: "/api/portfolio/holdings/\(holdingId)/ebay/listing",
            body: body,
            responseType: PortfolioEbayListingResponse.self,
            sessionId: resolvedSessionId
        )
    }

    func removePortfolioHolding(userId: String = "", cardId: String) async throws -> PortfolioIQActionResponse {
        try await delete(
            path: "/api/portfolio/holdings/\(cardId)",
            queryItems: portfolioUserQueryItems(userId: userId),
            responseType: PortfolioIQActionResponse.self
        )
    }

    func markPortfolioHoldingSold(
        userId: String = "",
        cardId: String,
        salePrice: Double,
        fees: Double,
        date: Date
    ) async throws -> PortfolioIQActionResponse {
        return try await post(
            path: "/api/portfolio/holdings/\(cardId)/sell",
            queryItems: portfolioUserQueryItems(userId: userId),
            body: PortfolioIQSellRequest(
                quantity: 1,
                salePrice: salePrice,
                fees: fees,
                tax: 0,
                shipping: 0,
                soldAt: ISO8601DateFormatter().string(from: date),
                source: "manual",
                notes: nil
            ),
            responseType: PortfolioIQActionResponse.self
        )
    }

    func addPortfolioHolding(_ card: InventoryCard) async throws -> PortfolioIQActionResponse {
        try await post(
            path: "/api/portfolio/holdings",
            body: card,
            responseType: PortfolioIQActionResponse.self
        )
    }

    func updatePortfolioHolding(_ card: InventoryCard) async throws -> PortfolioIQActionResponse {
        try await patch(
            path: "/api/portfolio/holdings/\(card.id.uuidString)",
            body: card,
            responseType: PortfolioIQActionResponse.self
        )
    }

    func deletePortfolioHolding(holdingId: String) async throws -> PortfolioIQActionResponse {
        try await delete(
            path: "/api/portfolio/holdings/\(holdingId)",
            responseType: PortfolioIQActionResponse.self
        )
    }

    // MARK: - Alerts

    func fetchAlerts() async throws -> AlertsAPIResponse {
        try await get(path: "/api/portfolio/alerts", responseType: AlertsAPIResponse.self)
    }

    func createAlert(_ alert: CreateAlertRequest) async throws -> AlertsAPIResponse {
        try await post(path: "/api/alerts/", body: alert, responseType: AlertsAPIResponse.self)
    }

    func deleteAlert(alertId: String) async throws -> AlertsAPIResponse {
        try await delete(path: "/api/alerts/\(alertId)", responseType: AlertsAPIResponse.self)
    }

    // MARK: - Price Alerts CRUD

    func fetchPriceAlerts() async throws -> PriceAlertListResponse {
        try await get(path: "/api/alerts/", responseType: PriceAlertListResponse.self)
    }

    func deletePriceAlert(alertId: String) async throws -> PriceAlertDeleteResponse {
        try await delete(path: "/api/alerts/\(alertId)", responseType: PriceAlertDeleteResponse.self)
    }

    // MARK: - Advanced Alert Rules CRUD (gated advancedAlerts / investor+)

    func fetchAdvancedRules() async throws -> AdvancedAlertListResponse {
        try await get(path: "/api/alerts/advanced/", responseType: AdvancedAlertListResponse.self)
    }

    func createAdvancedRule(_ request: AdvancedAlertCreateRequest) async throws -> AdvancedAlertResponse {
        try await post(path: "/api/alerts/advanced/", body: request, responseType: AdvancedAlertResponse.self)
    }

    func updateAdvancedRule(ruleId: String, request: AdvancedAlertUpdateRequest) async throws -> AdvancedAlertResponse {
        try await patch(path: "/api/alerts/advanced/\(ruleId)", body: request, responseType: AdvancedAlertResponse.self)
    }

    func deleteAdvancedRule(ruleId: String) async throws -> AdvancedAlertDeleteResponse {
        try await delete(path: "/api/alerts/advanced/\(ruleId)", responseType: AdvancedAlertDeleteResponse.self)
    }

    // MARK: - Device Token

    func registerDeviceToken(_ token: String) async throws -> DeviceTokenResponse {
        let body = DeviceTokenRequest(token: token, platform: "ios", bundleId: "Justtheboysandcards.HobbyIQ")
        return try await post(path: "/api/devices/token", body: body, responseType: DeviceTokenResponse.self)
    }

    func unregisterDeviceToken(_ token: String) async throws -> DeviceTokenResponse {
        let body = DeviceTokenRequest(token: token, platform: "ios", bundleId: "Justtheboysandcards.HobbyIQ")
        let bodyData = try encoder.encode(body)
        let request = try makeRequest(path: "/api/devices/token", method: "DELETE", bodyData: bodyData)
        return try await perform(request, responseType: DeviceTokenResponse.self)
    }

    // MARK: - Notification Preferences

    func fetchNotificationPreferences() async throws -> NotificationPreferencesResponse {
        try await get(path: "/api/alerts/preferences", responseType: NotificationPreferencesResponse.self)
    }

    func updateNotificationPreferences(_ prefs: NotificationPreferencesRequest) async throws -> NotificationPreferencesResponse {
        try await put(path: "/api/alerts/preferences", body: prefs, responseType: NotificationPreferencesResponse.self)
    }

    // MARK: - Auth Session

    func signOutSession() async throws -> AuthSignOutResponse {
        try await post(path: "/api/auth/signout", body: EmptyBody(), responseType: AuthSignOutResponse.self)
    }

    func fetchSession() async throws -> AuthSessionResponse {
        try await get(path: "/api/auth/session", responseType: AuthSessionResponse.self)
    }

    // MARK: - Unified Card Search

    func searchCards(input: String, hint: String? = nil) async throws -> UnifiedSearchResponse {
        let body = UnifiedSearchRequest(input: input, hint: hint)
        return try await post(path: "/api/search/cards", body: body, responseType: UnifiedSearchResponse.self)
    }

    // MARK: - Username Change

    func changeUsername(username: String) async throws -> UsernameChangeResponse {
        let body = UsernameChangeRequest(username: username)
        return try await post(path: "/api/auth/username", body: body, responseType: UsernameChangeResponse.self)
    }

    // MARK: - PlayerIQ Top / History

    func fetchPlayerIQTop(limit: Int = 20, direction: String? = nil) async throws -> PlayerIQTopResponse {
        var queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        if let direction { queryItems.append(URLQueryItem(name: "direction", value: direction)) }
        return try await get(path: "/api/playeriq/top", queryItems: queryItems, responseType: PlayerIQTopResponse.self)
    }

    func fetchPlayerIQHistory(name: String, limit: Int = 30) async throws -> PlayerIQHistoryResponse {
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        return try await get(
            path: "/api/playeriq/\(encoded)/history",
            queryItems: [URLQueryItem(name: "limit", value: String(limit))],
            responseType: PlayerIQHistoryResponse.self
        )
    }

    // MARK: - Account

    func deleteAccount() async throws -> AccountDeletionResponse {
        let body = AccountDeletionRequest(confirm: "DELETE_MY_ACCOUNT")
        let bodyData = try encoder.encode(body)
        let request = try makeRequest(path: "/api/account", method: "DELETE", bodyData: bodyData)
        return try await perform(request, responseType: AccountDeletionResponse.self)
    }

    // MARK: - Subscriptions

    func verifySubscription(jws: String) async throws -> VerifySubscriptionResponse {
        try await post(path: "/api/subscriptions/verify", body: VerifySubscriptionRequest(jwsRepresentation: jws), responseType: VerifySubscriptionResponse.self)
    }

    // MARK: - Entitlements

    func fetchEntitlements() async throws -> EntitlementResponse {
        try await get(path: "/api/entitlements/me", responseType: EntitlementResponse.self)
    }

    // MARK: - Health

    func fetchHealth(servicePath: String) async throws -> HealthStatusResponse {
        try await get(path: servicePath, responseType: HealthStatusResponse.self)
    }

    private func get<Response: Decodable>(path: String, queryItems: [URLQueryItem] = [], responseType: Response.Type, sessionId: String? = nil) async throws -> Response {
        let request = try makeRequest(path: path, queryItems: queryItems, method: "GET", bodyData: nil, sessionId: sessionId)
        return try await perform(request, responseType: responseType)
    }

    private func post<Request: Encodable, Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Request,
        responseType: Response.Type,
        sessionId: String? = nil,
        timeoutSeconds: TimeInterval? = nil
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        #if DEBUG
        if let bodyText = String(data: bodyData, encoding: .utf8) {
            print("Request Body:", bodyText)
        }
        #endif
        let request = try makeRequest(path: path, queryItems: queryItems, method: "POST", bodyData: bodyData, sessionId: sessionId, timeoutSeconds: timeoutSeconds)
        return try await perform(request, responseType: responseType)
    }

    private func patch<Request: Encodable, Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Request,
        responseType: Response.Type,
        sessionId: String? = nil
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        #if DEBUG
        if let bodyText = String(data: bodyData, encoding: .utf8) {
            print("Request Body:", bodyText)
        }
        #endif
        let request = try makeRequest(path: path, queryItems: queryItems, method: "PATCH", bodyData: bodyData, sessionId: sessionId)
        return try await perform(request, responseType: responseType)
    }

    private func put<Request: Encodable, Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        body: Request,
        responseType: Response.Type,
        sessionId: String? = nil
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        let request = try makeRequest(path: path, queryItems: queryItems, method: "PUT", bodyData: bodyData, sessionId: sessionId)
        return try await perform(request, responseType: responseType)
    }

    private func delete<Response: Decodable>(path: String, queryItems: [URLQueryItem] = [], responseType: Response.Type, sessionId: String? = nil) async throws -> Response {
        let request = try makeRequest(path: path, queryItems: queryItems, method: "DELETE", bodyData: nil, sessionId: sessionId)
        return try await perform(request, responseType: responseType)
    }

    private func multipartBody(boundary: String, parts: [MultipartFormPart], filePart: MultipartFilePart) -> Data {
        var body = Data()

        for part in parts {
            body.appendString("--\(boundary)\r\n")
            body.appendString("Content-Disposition: form-data; name=\"");
            body.appendString(part.name)
            body.appendString("\"\r\n\r\n")
            body.appendString(part.value)
            body.appendString("\r\n")
        }

        body.appendString("--\(boundary)\r\n")
        body.appendString("Content-Disposition: form-data; name=\"")
        body.appendString(filePart.name)
        body.appendString("\"; filename=\"")
        body.appendString(filePart.fileName)
        body.appendString("\"\r\n")
        body.appendString("Content-Type: \(filePart.mimeType)\r\n\r\n")
        body.append(filePart.data)
        body.appendString("\r\n")
        body.appendString("--\(boundary)--\r\n")

        return body
    }

    private func makeRequest(path: String, queryItems: [URLQueryItem] = [], method: String, bodyData: Data?, sessionId: String? = nil, timeoutSeconds: TimeInterval? = nil) throws -> URLRequest {
        guard let baseURL = URL(string: baseURLString) else {
            throw APIServiceError.invalidURL
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/" + path
        var components = URLComponents(url: baseURL.appending(path: normalizedPath), resolvingAgainstBaseURL: false)
        if queryItems.isEmpty == false {
            components?.queryItems = queryItems
        }

        guard let url = components?.url else {
            throw APIServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        // CF-FIND-CARDS-REGROUND: per-request timeout override. Default 10s
        // covers the vast majority of endpoints, but the cardsearch
        // dispatcher's Cardsight enrichment runs several seconds on a cold
        // cache for broad queries ("Mike Trout", "Bowman Chrome"). Callers
        // that need headroom pass `timeoutSeconds` explicitly so we don't
        // raise the floor for every endpoint.
        request.timeoutInterval = timeoutSeconds ?? 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let resolvedSessionId = sessionId ?? AuthService.shared.session?.token
        if let sessionId = resolvedSessionId?.trimmingCharacters(in: .whitespacesAndNewlines), sessionId.isEmpty == false {
            request.setValue(sessionId, forHTTPHeaderField: "x-session-id")
            request.setValue("Bearer \(sessionId)", forHTTPHeaderField: "Authorization")
        }

        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        #if DEBUG
        print("[APIService] Request", requestContext(request))
        #endif
        return request
    }

    private func requireSessionId(_ sessionId: String?) throws -> String {
        let candidates = [
            sessionId,
            AuthService.shared.session?.token,
            UserDefaults.standard.string(forKey: "auth.sessionId")
        ]

        for candidate in candidates {
            let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty == false {
                return value
            }
        }

        throw APIServiceError.authenticationRequired
    }

    private func perform<Response: Decodable>(_ request: URLRequest, responseType: Response.Type) async throws -> Response {
        let context = requestContext(request)
        do {
            let (data, response) = try await session.data(for: request)
            #if DEBUG
            let rawResponse = String(data: data, encoding: .utf8) ?? ""
            print("[APIService] Response", context, "body:", rawResponse)
            #else
            let rawResponse = String(data: data, encoding: .utf8) ?? ""
            #endif

            guard let httpResponse = response as? HTTPURLResponse else {
                #if DEBUG
                print("[APIService] Invalid response", context)
                #endif
                throw APIServiceError.invalidResponse
            }

            #if DEBUG
            print("[APIService] Status", context, httpResponse.statusCode)
            #endif

            guard 200..<300 ~= httpResponse.statusCode else {
                notifySessionInvalidatedIfNeeded(statusCode: httpResponse.statusCode, url: request.url)
                throw APIServiceError.httpError(statusCode: httpResponse.statusCode, body: rawResponse)
            }

            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                #if DEBUG
                print("[APIService] Decode error", context, error.localizedDescription)
                #endif
                throw APIServiceError.decodingFailed(error)
            }
        } catch let error as APIServiceError {
            #if DEBUG
            print("[APIService] API error", context, error.errorDescription ?? error.localizedDescription)
            #endif
            throw error
        } catch {
            #if DEBUG
            print("[APIService] Network error", context, error.localizedDescription)
            #endif
            throw APIServiceError.networkFailed(error)
        }
    }

    static func errorMessage(from error: Error) -> String {
        if let apiError = error as? APIServiceError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "Something went wrong." : message
    }

    static func backendMessage(from body: String) -> String {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return "" }

        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            return trimmed
        }

        for key in ["message", "error", "detail", "reason"] {
            if let value = dictionary[key] as? String, value.isEmpty == false {
                return value
            }
        }

        return trimmed
    }

    fileprivate static func joinMessages(_ primary: String, _ secondary: String) -> String {
        let trimmedSecondary = secondary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedSecondary.isEmpty == false else { return primary }
        return "\(primary) \(trimmedSecondary)"
    }

    private func fetchDailyTopPlayers(path: String, date: String? = nil) async throws -> [DailyPlayerStat] {
        let data = try await fetchData(path: path, queryItems: date.map { [URLQueryItem(name: "date", value: $0)] } ?? [])
        if let backend = try? decoder.decode(DailyIQBackendPlayerListEnvelope.self, from: data) {
            return backend.players.map(Self.makeDailyPlayerStat(from:))
        }

        if let direct = try? decoder.decode([DailyPlayerStat].self, from: data) {
            return direct
        }

        throw APIServiceError.decodingFailed(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unexpected DailyIQ player list payload")))
    }

    private func portfolioUserQueryItems(userId: String) -> [URLQueryItem] {
        let trimmed = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return [] }
        return [URLQueryItem(name: "userId", value: trimmed)]
    }

    fileprivate static func makeDailyPlayerStat(from backend: DailyIQBackendPlayerResponse) -> DailyPlayerStat {
        let daily = backend.dailyStats
        let season = backend.seasonStats
        let resolvedLevel = backend.level ?? (backend.league.uppercased() == "MLB" ? "MLB" : "MiLB")
        let isPitcher = backend.position.uppercased().hasPrefix("SP")
            || backend.position.uppercased().hasPrefix("RP")
            || backend.position.uppercased().hasPrefix("P")
            || backend.pitchingInningsPitched != nil
            || daily.inningsPitched != nil
        let pitchingInningsPitched = backend.pitchingInningsPitched ?? daily.inningsPitched
        let pitchingEarnedRuns = backend.pitchingEarnedRuns ?? daily.earnedRuns
        let pitchingHitsAllowed = backend.pitchingHitsAllowed ?? daily.pitchingHitsAllowed ?? daily.hitsAllowed
        let pitchingWalksAllowed = backend.pitchingWalksAllowed ?? daily.pitchingWalksAllowed
        let pitchingStrikeouts = backend.pitchingStrikeouts ?? daily.pitchingStrikeouts
        // Wire-typed era is String ("1.98"); parse to Double, else fall back to season-string-era, else derive from IP+ER.
        let resolvedEra = backend.era.flatMap(Double.init)
            ?? Double(season.era ?? "")
            ?? (isPitcher ? Self.derivePitchingEra(inningsPitched: pitchingInningsPitched, earnedRuns: pitchingEarnedRuns) : nil)
        let statLine = isPitcher
            ? [
                pitchingInningsPitched.map { "IP \($0)" },
                pitchingEarnedRuns.map { "ER \($0)" },
                resolvedEra.map { String(format: "ERA %.2f", $0) },
                pitchingStrikeouts.map { "K \($0)" },
                pitchingWalksAllowed.map { "BB \($0)" },
                pitchingHitsAllowed.map { "H \($0)" }
            ].compactMap { $0 }.joined(separator: " • ")
            : [
                "vs \(daily.opponent)",
                "\(daily.hits) H",
                "\(daily.rbi) RBI",
                daily.homeRuns > 0 ? "\(daily.homeRuns) HR" : nil,
                "OPS \(daily.ops)"
            ].compactMap { $0 }.joined(separator: " • ")
        let performanceNote = isPitcher
            ? [
                statLine,
                "\(season.gamesPlayed) G"
            ].joined(separator: " • ")
            : [
                "Season AVG \(season.battingAverage)",
                "OPS \(season.ops)",
                "\(season.gamesPlayed) G"
            ].joined(separator: " • ")

        return DailyPlayerStat(
            playerId: backend.playerId,
            rank: backend.rank,
            rankingScore: backend.rankingScore,
            league: backend.league,
            playerName: backend.playerName,
            team: backend.teamName,
            teamName: backend.teamName,
            teamAbbreviation: backend.teamAbbreviation,
            level: resolvedLevel,
            position: backend.position,
            gameDate: daily.gameDate,
            opponent: daily.opponent,
            atBats: daily.atBats,
            runs: daily.runs,
            statLine: statLine,
            performanceNote: performanceNote,
            trend: trendLabel(for: backend.rankingScore, league: backend.league, level: resolvedLevel),
            hr: daily.homeRuns,
            hits: daily.hits,
            rbi: daily.rbi,
            rbis: daily.rbis,
            walks: daily.walks,
            strikeouts: daily.strikeouts,
            stolenBases: daily.stolenBases,
            battingAverage: daily.battingAverage,
            ops: daily.ops,
            dailyStatsStatus: daily.dailyStatsStatus,
            gamesPlayed: season.gamesPlayed,
            seasonAtBats: season.atBats,
            seasonRuns: season.runs,
            seasonHits: season.hits,
            seasonHomeRuns: season.homeRuns,
            seasonRbi: season.rbi,
            seasonWalks: season.walks,
            seasonStrikeouts: season.strikeouts,
            seasonStolenBases: season.stolenBases,
            seasonBattingAverage: season.battingAverage,
            onBasePercentage: season.onBasePercentage,
            sluggingPercentage: season.sluggingPercentage,
            seasonOps: season.ops,
            obp: season.obp,
            slg: season.slg,
            lastUpdated: backend.lastUpdated,
            era: resolvedEra,
            pitchingInningsPitched: pitchingInningsPitched,
            pitchingEarnedRuns: pitchingEarnedRuns,
            pitchingHitsAllowed: pitchingHitsAllowed,
            pitchingWalksAllowed: pitchingWalksAllowed,
            pitchingStrikeouts: pitchingStrikeouts,
            isProspect: backend.league.uppercased() == "MILB",
            buySignal: backend.rankingScore >= 80 || backend.rank <= 10,
            isOnWatchlist: backend.isOnWatchlist ?? false,
            // Wire-typed fantasyPoints is Double; round to Int for the existing
            // DailyPlayerStat model contract (UI never reads precision below 1).
            fantasyPoints: backend.fantasyPoints.map { Int($0.rounded()) },
            dailyScore: backend.dailyScore,
            playerIQScore: backend.playerIQScore,
            playerIQDirection: backend.playerIQDirection,
            playerIQLabel: backend.playerIQLabel,
            movementDirection: backend.movement?.direction,
            movementLabel: backend.movement?.label,
            movementReason: backend.movement?.reason,
            sellSignal: deriveSellSignal(direction: backend.movement?.direction, dailyScore: backend.dailyScore)
        )
    }

    private static func derivePitchingEra(inningsPitched: String?, earnedRuns: Int?) -> Double? {
        guard let inningsPitched, inningsPitched.isEmpty == false else { return nil }
        let components = inningsPitched.split(separator: ".").map(String.init)
        guard let whole = components.first.flatMap(Double.init) else { return nil }
        let outs = components.count > 1 ? min(max(Double(components[1]) ?? 0, 0), 2) / 3 : 0
        let innings = whole + outs
        guard innings > 0 else { return nil }
        let runs = Double(earnedRuns ?? 0)
        return Double((runs * 9 / innings * 100).rounded() / 100)
    }

    private static func makeWatchlistResult(from backend: DailyIQBackendPlayerResponse) -> WatchPlayerResult {
        let stat = makeDailyPlayerStat(from: backend)
        return WatchPlayerResult(
            playerId: stat.playerId,
            rank: backend.rank,
            rankingScore: backend.rankingScore,
            league: backend.league,
            playerName: stat.playerName,
            teamName: stat.teamName,
            teamAbbreviation: stat.teamAbbreviation,
            lastGameDate: backend.dailyStats.gameDate,
            gameDate: stat.gameDate,
            opponent: stat.opponent,
            atBats: stat.atBats,
            runs: stat.runs,
            hits: stat.hits,
            homeRuns: stat.hr,
            rbi: stat.rbi,
            rbis: stat.rbis,
            walks: stat.walks,
            strikeouts: stat.strikeouts,
            stolenBases: stat.stolenBases,
            battingAverage: stat.battingAverage,
            ops: stat.ops,
            dailyStatsStatus: stat.dailyStatsStatus,
            gamesPlayed: stat.gamesPlayed,
            seasonAtBats: stat.seasonAtBats,
            seasonRuns: stat.seasonRuns,
            seasonHits: stat.seasonHits,
            seasonHomeRuns: stat.seasonHomeRuns,
            seasonRbi: stat.seasonRbi,
            seasonWalks: stat.seasonWalks,
            seasonStrikeouts: stat.seasonStrikeouts,
            seasonStolenBases: stat.seasonStolenBases,
            seasonBattingAverage: stat.seasonBattingAverage,
            onBasePercentage: stat.onBasePercentage,
            sluggingPercentage: stat.sluggingPercentage,
            seasonOps: stat.seasonOps,
            obp: stat.obp,
            slg: stat.slg,
            statLine: stat.statLine,
            played: backend.dailyStats.dailyStatsStatus.lowercased() != "no game",
            noGameMessage: backend.dailyStats.dailyStatsStatus.lowercased() == "no game" ? backend.dailyStats.dailyStatsStatus : nil,
            trend: stat.trend,
            buySignal: stat.buySignal,
            performanceNote: stat.performanceNote,
            team: stat.team,
            position: stat.position,
            level: stat.level,
            lastUpdated: backend.lastUpdated,
            era: stat.era,
            pitchingInningsPitched: stat.pitchingInningsPitched,
            pitchingEarnedRuns: stat.pitchingEarnedRuns,
            pitchingHitsAllowed: stat.pitchingHitsAllowed,
            pitchingWalksAllowed: stat.pitchingWalksAllowed,
            pitchingStrikeouts: stat.pitchingStrikeouts,
            isOnWatchlist: backend.isOnWatchlist ?? true,
            fantasyPoints: stat.fantasyPoints,
            dailyScore: stat.dailyScore,
            playerIQScore: stat.playerIQScore,
            playerIQDirection: stat.playerIQDirection,
            playerIQLabel: stat.playerIQLabel,
            movementDirection: stat.movementDirection,
            movementLabel: stat.movementLabel,
            movementReason: stat.movementReason,
            sellSignal: stat.sellSignal
        )
    }

    private static func trendLabel(for score: Double, league: String, level: String) -> String {
        let isMiLB = league.uppercased() == "MILB" || level != "MLB"
        if isMiLB {
            if score >= 88 { return "Hot" }
            if score >= 76 { return "Up" }
            if score >= 62 { return "Flat" }
            return "Down"
        }

        if score >= 90 { return "Hot" }
        if score >= 78 { return "Up" }
        if score >= 64 { return "Flat" }
        return "Down"
    }

    private func fetchData(path: String, queryItems: [URLQueryItem] = [], sessionId: String? = nil) async throws -> Data {
        try await sendData(path: path, queryItems: queryItems, method: "GET", bodyData: nil, sessionId: sessionId)
    }

    private func sendData(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String,
        bodyData: Data?,
        sessionId: String? = nil
    ) async throws -> Data {
        let request = try makeRequest(path: path, queryItems: queryItems, method: method, bodyData: bodyData, sessionId: sessionId)
        do {
            let (data, response) = try await session.data(for: request)
            #if DEBUG
            let rawResponse = String(data: data, encoding: .utf8) ?? ""
            print("[APIService] Response", requestContext(request), "body:", rawResponse)
            #endif

            guard let httpResponse = response as? HTTPURLResponse else {
                #if DEBUG
                print("[APIService] Invalid response", requestContext(request))
                #endif
                throw APIServiceError.invalidResponse
            }

            #if DEBUG
            print("[APIService] Status", requestContext(request), httpResponse.statusCode)
            #endif

            guard 200..<300 ~= httpResponse.statusCode else {
                let rawResponse = String(data: data, encoding: .utf8) ?? ""
                notifySessionInvalidatedIfNeeded(statusCode: httpResponse.statusCode, url: request.url)
                throw APIServiceError.httpError(statusCode: httpResponse.statusCode, body: rawResponse)
            }

            return data
        } catch let error as APIServiceError {
            #if DEBUG
            print("[APIService] API error", requestContext(request), error.errorDescription ?? error.localizedDescription)
            #endif
            throw error
        } catch {
            #if DEBUG
            print("[APIService] Network error", requestContext(request), error.localizedDescription)
            #endif
            throw APIServiceError.networkFailed(error)
        }
    }

    private func requestContext(_ request: URLRequest) -> String {
        let method = request.httpMethod ?? "GET"
        let url = request.url?.absoluteString ?? "<invalid-url>"
        return "\(method) \(url)"
    }

    /// CF-401-DOWNGRADE: global session-revocation hook. Called from BOTH
    /// `perform()` and `sendData()` immediately before they throw
    /// `.httpError(401, ...)`. Posts `hobbyIQAuthSessionInvalidated` so
    /// AppSessionViewModel can clear the local session + route to
    /// `.signedOut`, closing the TTL-skip window where a server-revoked
    /// session leaves the user stranded on a signed-in UI up to 90s.
    ///
    /// Excludes the auth flow itself — sign-in/sign-up return 401 on bad
    /// credentials (handled inline as `errorMessage`); validateSession
    /// already clears the session at AuthService.swift's 401 branch; signout
    /// is moot. Letting any of those re-fire the global downgrade would
    /// either double-route (validateSession) or wrongly sign-out the
    /// already-signed-out flow (sign-in/sign-up).
    private static let authFlowPaths: Set<String> = [
        "/api/auth/apple",
        "/api/auth/signin",
        "/api/auth/register",
        "/api/auth/session",
        "/api/auth/signout"
    ]

    private func notifySessionInvalidatedIfNeeded(statusCode: Int, url: URL?) {
        guard statusCode == 401 else { return }
        let path = url?.path ?? ""
        guard Self.authFlowPaths.contains(path) == false else { return }
        NotificationCenter.default.post(name: .hobbyIQAuthSessionInvalidated, object: nil)
    }
}

struct CompIQAnalyzeRequest: Codable {
    let query: String
    let player: String
    let cardType: String
    let parallel: String
    let grade: String
    let recentComps: [Int]
}

struct CardEstimateRequest: Encodable {
    let playerName: String
    let cardYear: Int?
    let product: String?
    let parallel: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Double?

    private enum CodingKeys: String, CodingKey {
        case query
        case player
        case set
        case parallel
        case gradeTarget
        case isAuto
        case gradeCompany
        case gradeValue
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        let queryBits = [
            playerName,
            cardYear.map(String.init),
            product,
            parallel,
            gradeTarget,
            isAuto == true ? "Auto" : nil
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }

        try container.encode(queryBits.joined(separator: " "), forKey: .query)
        try container.encode(playerName, forKey: .player)
        try container.encodeIfPresent(product, forKey: .set)
        try container.encodeIfPresent(parallel, forKey: .parallel)
        try container.encodeIfPresent(isAuto, forKey: .isAuto)
        try container.encodeIfPresent(gradeCompany, forKey: .gradeCompany)
        try container.encodeIfPresent(gradeValue, forKey: .gradeValue)
        try container.encodeIfPresent(gradeTarget, forKey: .gradeTarget)
    }

    private var gradeTarget: String? {
        guard let gradeCompany, let gradeValue else { return nil }
        let company = gradeCompany.trimmingCharacters(in: .whitespacesAndNewlines)
        guard company.isEmpty == false else { return nil }
        return "\(company) \(gradeValue)"
    }
}

struct CardEstimateMarketDNA: Decodable {
    let trend: String?
    let liquidity: String?
    let speed: String?
    let marketCondition: String?
    let regime: String?
    let normalization: String?
}

struct CardEstimatePricingAnalytics: Decodable {
    let compsUsed: Int?
    let rSquared: Double?
    let parallelDetected: String?
    let projectedNextSale: Double?
    let compQuality: String?
    let dataSufficiency: String?
}

struct CardEstimateExitStrategy: Decodable {
    let recommendedMethod: String?
    let expectedDaysToSell: Int?
    let timingRecommendation: String?
}

struct CardEstimateConfidence: Decodable {
    let pricingConfidence: Double?
    let liquidityConfidence: Double?
    let timingConfidence: Double?
    let confidenceInterval: [Double]?
}

struct CardEstimateIdentity: Decodable {
    let player: String?
    let set: String?
    let number: String?
    let variant: String?
}

struct CardEstimateRecentComp: Decodable {
    let price: Double?
    let title: String?
    let soldDate: String?
}

struct CardEstimateMarketTier: Decodable {
    let value: Double?
    let high: Double?
}

struct CardEstimateBuyWindow: Decodable {
    let score: Double?
    let label: String?
    let reasons: [String]?
}

struct CardEstimateFreshness: Decodable {
    let status: String?
    let lastUpdated: String?
    let daysSinceNewestComp: Int?
}

struct CardEstimateBroaderTrend: Decodable {
    let direction: String?
    let label: String?
    let note: String?
}

struct SellingGuidance: Codable, Hashable {
    struct Range: Codable, Hashable { let low: Double; let high: Double }
    struct Assumptions: Codable, Hashable { let feePct: Double; let shippingCost: Double }
    let sellRange: Range?
    let quickSale: Double?
    let fair: Double?
    let ebayListingPrice: Double?
    let bestOfferFloor: Double?
    let auctionStartPrice: Double?
    let breakEven: Double?
    let recommendedPlatform: String
    let notes: [String]
    let assumptions: Assumptions
}

// MARK: - Phase 3 Engine Contract Types (2026-05-17, SHA c75aa258)

/// Price range with low/high bounds. Used for `predictedPriceRange` and attribution `multiplierRange`.
struct CompIQPriceRange: Codable, Hashable {
    let low: Double?
    let high: Double?
}

/// Attribution metadata for a predicted price. Shape varies by engine code path:
/// - multiplier-anchored: mechanism, anchorProduct, anchorParallel, anchorComps, anchorPrice, multiplierRange, crossProductAnchor, confidence
/// - trendiq-projection: mechanism, forwardProjectionFactor, trendIQComposite, trendIQDirection, trendIQCoverage
/// - Failure: mechanism, failureReason (e.g. "uncurated-subject-parallel", "insufficient-curated-peer-parallels")
/// All fields are optional to tolerate every shape.
struct CompIQPredictedPriceAttribution: Codable, Hashable {
    let mechanism: String?
    let anchorProduct: String?
    let anchorParallel: String?
    let anchorComps: Int?
    let anchorPrice: Double?
    let multiplierRange: CompIQPriceRange?
    let crossProductAnchor: Bool?
    let confidence: Double?
    let failureReason: String?
    // CF-COMP-DETAIL-EXPAND (2026-06-07): trendiq-projection mechanism
    // fields. Present when mechanism == "trendiq-projection".
    let forwardProjectionFactor: Double?
    let trendIQComposite: Double?
    let trendIQDirection: String?
    let trendIQCoverage: String?
}

// Note: TrendIQ structs (TrendIQResponse + components + weights) already
// exist in CompIQSearchModels.swift. The comp page reads them via
// `CompIQPriceByIdResponse.trendIQ` directly — no Swift-side wrapper
// needed.

// CF-COMP-DETAIL-EXPAND (2026-06-07): regime classifier diagnostics.
// The regime classifier (stable/volatile/trending) tells the user how
// noisy the comp set is. The diagnostics surface WHY a regime label
// landed — slope %/mo, R², CoV — so iOS can show a 1-line summary
// without re-deriving it.
struct CompIQRegimeDiagnostics: Codable, Hashable {
    let compsUsedForClassification: Int?
    let windowDays: Int?
    let slopePctPerMonth: Double?
    let r2: Double?
    let coefficientOfVariation: Double?
    let recentMeanLast14d: Double?
    let olderMean14to90d: Double?
    let pctChangeRecentVsOlder: Double?
    let classificationReason: String?
}

/// Backend `dataSufficiency` changed from a plain string to an object in Phase 3.
/// This struct decodes the new shape: `{ sufficient: Bool, level: String, message: String }`.
struct CompIQDataSufficiency: Codable, Hashable {
    let sufficient: Bool?
    let level: String?
    let message: String?
}

struct CardEstimateResponse: Decodable {
    let cardTitle: String?
    let verdict: String?
    let recommendation: String?
    let action: String?
    let fairMarketValue: Double?
    /// Phase 3: renamed from `fmv`. The canonical market value from the engine.
    let marketValue: Double?
    /// Phase 3: predicted price from multiplier-anchored mechanism (nullable).
    let predictedPrice: Double?
    /// Phase 3: predicted price range (nullable AND may be absent from JSON — both decode as nil).
    let predictedPriceRange: CompIQPriceRange?
    /// Phase 3: attribution metadata for predictedPrice (shape varies by engine path).
    let predictedPriceAttribution: CompIQPredictedPriceAttribution?
    let quickSaleValue: Double?
    let premiumValue: Double?
    let explanation: [String]?
    let marketDNA: CardEstimateMarketDNA?
    let exitStrategy: CardEstimateExitStrategy?
    let pricingAnalytics: CardEstimatePricingAnalytics?
    let source: String?
    let estimate: Double?
    let compsUsed: Int?
    let confidence: CardEstimateConfidence?
    let confidenceScore: Double?
    let marketTier: CardEstimateMarketTier?
    let cardIdentity: CardEstimateIdentity?
    let gradeUsed: String?
    let recentComps: [CardEstimateRecentComp]?
    let graderPremium: Double?
    let buyWindow: CardEstimateBuyWindow?
    let freshness: CardEstimateFreshness?
    let broaderTrend: CardEstimateBroaderTrend?
    let dealScore: Double?
    let variantWarning: String?
    let sellingGuidance: SellingGuidance?
    /// Phase 3: dataSufficiency changed from String to object `{ sufficient, level, message }`.
    /// Decoded as structured type; legacy string path preserved via `dataSufficiencyLabel`.
    let dataSufficiencyObj: CompIQDataSufficiency?

    /// Compatibility: returns the `message` field from the structured dataSufficiency,
    /// or falls back to pricingAnalytics.dataSufficiency (the legacy string path).
    var dataSufficiencyLabel: String? {
        dataSufficiencyObj?.message ?? pricingAnalytics?.dataSufficiency
    }

    /// Phase 3: engine's resolved FMV (same value as fairMarketValue).
    let effectiveFmv: Double?
    /// Phase 3: hold zone bounds [fmvLow, fmvHigh].
    let holdZone: [Double?]?
    /// Phase 3: sell zone bounds [premiumLow, premiumHigh].
    let sellZone: [Double?]?

    private enum CodingKeys: String, CodingKey {
        case cardTitle, verdict, recommendation, action
        case fairMarketValue, marketValue, predictedPrice, predictedPriceRange, predictedPriceAttribution
        case quickSaleValue, premiumValue
        case explanation, marketDNA, exitStrategy, pricingAnalytics
        case source, estimate, compsUsed, confidence
        case marketTier, cardIdentity, gradeUsed, recentComps
        case graderPremium, buyWindow, freshness, broaderTrend
        case dealScore, variantWarning, sellingGuidance
        case dataSufficiencyObj = "dataSufficiency"
        case effectiveFmv, holdZone, sellZone
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cardTitle = try? container.decodeIfPresent(String.self, forKey: .cardTitle)
        verdict = try? container.decodeIfPresent(String.self, forKey: .verdict)
        recommendation = try? container.decodeIfPresent(String.self, forKey: .recommendation)
        action = try? container.decodeIfPresent(String.self, forKey: .action)
        fairMarketValue = try? container.decodeIfPresent(Double.self, forKey: .fairMarketValue)
        marketValue = try? container.decodeIfPresent(Double.self, forKey: .marketValue)
        predictedPrice = try? container.decodeIfPresent(Double.self, forKey: .predictedPrice)
        predictedPriceRange = try? container.decodeIfPresent(CompIQPriceRange.self, forKey: .predictedPriceRange)
        predictedPriceAttribution = try? container.decodeIfPresent(CompIQPredictedPriceAttribution.self, forKey: .predictedPriceAttribution)
        quickSaleValue = try? container.decodeIfPresent(Double.self, forKey: .quickSaleValue)
        premiumValue = try? container.decodeIfPresent(Double.self, forKey: .premiumValue)
        // explanation can be [String] or a single String — try array first, then wrap single string
        if let arr = try? container.decodeIfPresent([String].self, forKey: .explanation) {
            explanation = arr
        } else if let single = try? container.decodeIfPresent(String.self, forKey: .explanation) {
            explanation = [single]
        } else {
            explanation = nil
        }
        marketDNA = try? container.decodeIfPresent(CardEstimateMarketDNA.self, forKey: .marketDNA)
        exitStrategy = try? container.decodeIfPresent(CardEstimateExitStrategy.self, forKey: .exitStrategy)
        pricingAnalytics = try? container.decodeIfPresent(CardEstimatePricingAnalytics.self, forKey: .pricingAnalytics)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        estimate = try? container.decodeIfPresent(Double.self, forKey: .estimate)
        compsUsed = try? container.decodeIfPresent(Int.self, forKey: .compsUsed)
        // confidence can be a dict or a plain number — try both
        confidence = try? container.decodeIfPresent(CardEstimateConfidence.self, forKey: .confidence)
        confidenceScore = try? container.decodeIfPresent(Double.self, forKey: .confidence)
        marketTier = try? container.decodeIfPresent(CardEstimateMarketTier.self, forKey: .marketTier)
        cardIdentity = try? container.decodeIfPresent(CardEstimateIdentity.self, forKey: .cardIdentity)
        gradeUsed = try? container.decodeIfPresent(String.self, forKey: .gradeUsed)
        recentComps = try? container.decodeIfPresent([CardEstimateRecentComp].self, forKey: .recentComps)
        graderPremium = try? container.decodeIfPresent(Double.self, forKey: .graderPremium)
        buyWindow = try? container.decodeIfPresent(CardEstimateBuyWindow.self, forKey: .buyWindow)
        freshness = try? container.decodeIfPresent(CardEstimateFreshness.self, forKey: .freshness)
        broaderTrend = try? container.decodeIfPresent(CardEstimateBroaderTrend.self, forKey: .broaderTrend)
        dealScore = try? container.decodeIfPresent(Double.self, forKey: .dealScore)
        variantWarning = try? container.decodeIfPresent(String.self, forKey: .variantWarning)
        sellingGuidance = try? container.decodeIfPresent(SellingGuidance.self, forKey: .sellingGuidance)
        dataSufficiencyObj = try? container.decodeIfPresent(CompIQDataSufficiency.self, forKey: .dataSufficiencyObj)
        effectiveFmv = try? container.decodeIfPresent(Double.self, forKey: .effectiveFmv)
        holdZone = try? container.decodeIfPresent([Double?].self, forKey: .holdZone)
        sellZone = try? container.decodeIfPresent([Double?].self, forKey: .sellZone)
    }

    // Memberwise init for local construction
    init(cardTitle: String?, verdict: String?, recommendation: String?, action: String?,
         fairMarketValue: Double?, marketValue: Double? = nil,
         predictedPrice: Double? = nil, predictedPriceRange: CompIQPriceRange? = nil,
         predictedPriceAttribution: CompIQPredictedPriceAttribution? = nil,
         quickSaleValue: Double?, premiumValue: Double?,
         explanation: [String]?, marketDNA: CardEstimateMarketDNA?,
         exitStrategy: CardEstimateExitStrategy?, pricingAnalytics: CardEstimatePricingAnalytics?,
         source: String?, estimate: Double?, compsUsed: Int?,
         confidence: CardEstimateConfidence? = nil, confidenceScore: Double? = nil,
         marketTier: CardEstimateMarketTier? = nil,
         cardIdentity: CardEstimateIdentity? = nil, gradeUsed: String? = nil,
         recentComps: [CardEstimateRecentComp]? = nil,
         graderPremium: Double? = nil, buyWindow: CardEstimateBuyWindow? = nil,
         freshness: CardEstimateFreshness? = nil, broaderTrend: CardEstimateBroaderTrend? = nil,
         dealScore: Double? = nil, variantWarning: String? = nil,
         sellingGuidance: SellingGuidance? = nil,
         dataSufficiencyObj: CompIQDataSufficiency? = nil,
         effectiveFmv: Double? = nil, holdZone: [Double?]? = nil, sellZone: [Double?]? = nil) {
        self.cardTitle = cardTitle; self.verdict = verdict
        self.recommendation = recommendation; self.action = action
        self.fairMarketValue = fairMarketValue; self.marketValue = marketValue
        self.predictedPrice = predictedPrice; self.predictedPriceRange = predictedPriceRange
        self.predictedPriceAttribution = predictedPriceAttribution
        self.quickSaleValue = quickSaleValue
        self.premiumValue = premiumValue; self.explanation = explanation
        self.marketDNA = marketDNA; self.exitStrategy = exitStrategy
        self.pricingAnalytics = pricingAnalytics; self.source = source
        self.estimate = estimate; self.compsUsed = compsUsed
        self.confidence = confidence; self.confidenceScore = confidenceScore
        self.marketTier = marketTier
        self.cardIdentity = cardIdentity; self.gradeUsed = gradeUsed
        self.recentComps = recentComps
        self.graderPremium = graderPremium; self.buyWindow = buyWindow
        self.freshness = freshness; self.broaderTrend = broaderTrend
        self.dealScore = dealScore; self.variantWarning = variantWarning
        self.sellingGuidance = sellingGuidance
        self.dataSufficiencyObj = dataSufficiencyObj
        self.effectiveFmv = effectiveFmv
        self.holdZone = holdZone
        self.sellZone = sellZone
    }
}


struct HealthStatusResponse: Codable {
    let status: String?
    let message: String?
}

private struct DailyIQBackendBriefResponse: Decodable {
    let date: String
    let generatedAt: String?
    let lastUpdated: String?
    let mlb: [DailyIQBackendPlayerResponse]
    let milb: [DailyIQBackendPlayerResponse]
    let byLevel: [String: [DailyIQBackendPlayerResponse]]?
    let risers: [DailyIQBackendPlayerResponse]?
    let fallers: [DailyIQBackendPlayerResponse]?
    let breakouts: [DailyIQBackendPlayerResponse]?

    private enum CodingKeys: String, CodingKey {
        case date, generatedAt, lastUpdated, mlb, milb, byLevel
        case risers, fallers, breakouts
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.date = try container.decode(String.self, forKey: .date)
        self.generatedAt = try? container.decodeIfPresent(String.self, forKey: .generatedAt)
        self.lastUpdated = try? container.decodeIfPresent(String.self, forKey: .lastUpdated)
        // LOSSY: a 50+ player live-stats feed will hit messy rows; one bad
        // row must not blank the whole feed. Decode each element through
        // LossyArray which skips undecodable entries instead of aborting
        // the whole array.
        self.mlb = (try? container.decode(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .mlb).elements) ?? []
        self.milb = (try? container.decode(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .milb).elements) ?? []
        self.risers = (try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .risers))?.elements
        self.fallers = (try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .fallers))?.elements
        self.breakouts = (try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .breakouts))?.elements
        if let map = try? container.decodeIfPresent([String: LossyArray<DailyIQBackendPlayerResponse>].self, forKey: .byLevel) {
            self.byLevel = map.mapValues { $0.elements }
        } else {
            self.byLevel = nil
        }
    }
}

/// Decodes a JSON array element-by-element, silently dropping entries that
/// fail to decode. Used by the DailyIQ brief / player-list / watchlist
/// envelopes so a single malformed player row can't blank the whole feed.
///
/// In DEBUG builds, per-row failures print the underlying DecodingError
/// (case + codingPath + details) so we can attribute remaining row
/// drift without re-instrumenting the call sites. Release builds skip
/// silently — no extra observability surface.
private struct LossyArray<Element: Decodable>: Decodable {
    let elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var result: [Element] = []
        result.reserveCapacity(container.count ?? 0)
        #if DEBUG
        var droppedCount = 0
        let elementName = String(describing: Element.self)
        let startIndex = container.currentIndex
        #endif
        while !container.isAtEnd {
            do {
                let element = try container.decode(Element.self)
                result.append(element)
            } catch {
                #if DEBUG
                let rowIndex = container.currentIndex - startIndex
                let summary = LossyArray.summarize(error)
                print("[LossyArray<\(elementName)>] dropped row[\(rowIndex)]: \(summary)")
                droppedCount += 1
                #endif
                // The unkeyed container does NOT advance on a thrown decode,
                // so consume the slot with an always-accepting throwaway so
                // the iterator moves on. Guard against the throwaway also
                // failing (e.g. truncated JSON) to avoid an infinite loop.
                do {
                    _ = try container.decode(LossySkip.self)
                } catch {
                    break
                }
            }
        }
        #if DEBUG
        if droppedCount > 0 {
            print("[LossyArray<\(elementName)>] kept \(result.count) / dropped \(droppedCount)")
        }
        #endif
        self.elements = result
    }

    #if DEBUG
    private static func summarize(_ error: Error) -> String {
        guard let decodingError = error as? DecodingError else {
            return String(describing: error)
        }
        switch decodingError {
        case let .keyNotFound(key, context):
            return "keyNotFound(\"\(key.stringValue)\") at \(LossyArray.formatPath(context.codingPath + [key])) — \(context.debugDescription)"
        case let .typeMismatch(type, context):
            return "typeMismatch(\(type)) at \(LossyArray.formatPath(context.codingPath)) — \(context.debugDescription)"
        case let .valueNotFound(type, context):
            return "valueNotFound(\(type)) at \(LossyArray.formatPath(context.codingPath)) — \(context.debugDescription)"
        case let .dataCorrupted(context):
            return "dataCorrupted at \(LossyArray.formatPath(context.codingPath)) — \(context.debugDescription)"
        @unknown default:
            return String(describing: decodingError)
        }
    }

    private static func formatPath(_ path: [CodingKey]) -> String {
        guard !path.isEmpty else { return "<root>" }
        var result = ""
        for key in path {
            if let i = key.intValue {
                result += "[\(i)]"
            } else {
                if !result.isEmpty { result += "." }
                result += key.stringValue
            }
        }
        return result
    }
    #endif

    private struct LossySkip: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

private struct DailyIQBackendPlayerListEnvelope: Decodable {
    let players: [DailyIQBackendPlayerResponse]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // LOSSY at each key probe: one bad row inside the array must not
        // blank the whole 50-row feed (was strict-decoding to nil and
        // falling through to the next key, ending in `players = []`).
        let candidates: [LossyArray<DailyIQBackendPlayerResponse>?] = [
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .players),
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .items),
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .data),
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .results),
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .topMLB),
            try? container.decodeIfPresent(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .topMiLB),
        ]
        self.players = candidates.compactMap { $0?.elements }.first(where: { !$0.isEmpty }) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case players
        case items
        case data
        case results
        case topMLB
        case topMiLB
    }
}

private struct DailyIQBackendWatchlistEnvelope: Decodable {
    let watchlist: [DailyIQBackendPlayerResponse]

    private enum CodingKeys: String, CodingKey {
        case watchlist
        case items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Lossy per element: one drift-bearing row must not blank the
        // whole watchlist tab.
        if let list = try? container.decode(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .watchlist) {
            self.watchlist = list.elements
        } else if let list = try? container.decode(LossyArray<DailyIQBackendPlayerResponse>.self, forKey: .items) {
            self.watchlist = list.elements
        } else {
            self.watchlist = []
        }
    }
}

private struct DailyIQWatchlistSearchRequest: Encodable {
    let query: String
}

private struct DailyIQWatchlistAddRequest: Encodable {
    let playerId: String?
    let playerName: String?
}

private struct DailyIQWatchlistAddResponse: Decodable {
    let message: String?
    let watchlistItemId: String?
    let playerId: String?
    let playerName: String?
}

private struct DailyIQWatchlistRemoveResponse: Decodable {
    let message: String?
    let playerId: String?
}

private struct DailyIQBackendPlayerResponse: Decodable {
    let playerId: String
    let rank: Int
    let rankingScore: Double
    let league: String
    let level: String?
    let playerName: String
    let team: String
    let teamName: String
    let teamAbbreviation: String
    let position: String
    // Legacy top-level pitching fields (removed from production, kept optional for cached responses).
    // Wire emits era as a STRING ("1.98"), not a Double — was the prime decode killer on every pitcher row.
    let era: String?
    let pitchingInningsPitched: String?
    let pitchingEarnedRuns: Int?
    let pitchingHitsAllowed: Int?
    let pitchingWalksAllowed: Int?
    let pitchingStrikeouts: Int?
    let dailyStats: DailyIQBackendDailyStats
    let seasonStats: DailyIQBackendSeasonStats
    let lastUpdated: String
    let isOnWatchlist: Bool?
    // New fields from production response. fantasyPoints is Double on the
    // wire (37.6 alongside integer rows) — was Int? and threw on every
    // fractional row.
    let fantasyPoints: Double?
    let dailyScore: Double?
    let playerIQScore: Int?
    let playerIQDirection: String?
    let playerIQLabel: String?
    let movement: DailyIQBackendMovement?
}

private struct DailyIQBackendMovement: Decodable {
    let direction: String?
    let label: String?
    let reason: String?
    let performanceDelta: Double?
    let marketDelta: DailyIQBackendMarketDelta?
}

private struct DailyIQBackendMarketDelta: Decodable {
    let pct1d: Double?
    let pct7d: Double?
    let pct30d: Double?
}

private struct DailyIQBackendDailyStats: Decodable {
    let gameDate: String
    let opponent: String
    let atBats: Int
    let runs: Int
    let hits: Int
    let homeRuns: Int
    let rbi: Int
    let rbis: Int
    let walks: Int
    let strikeouts: Int
    let stolenBases: Int
    let battingAverage: String
    let ops: String
    let dailyStatsStatus: String
    let statsType: String?
    let inningsPitched: String?
    let earnedRuns: Int?
    // Legacy field names (kept for cached responses)
    let pitchingHitsAllowed: Int?
    let pitchingWalksAllowed: Int?
    let pitchingStrikeouts: Int?
    // New field names from production
    let hitsAllowed: Int?
    let runsAllowed: Int?
    let homeRunsAllowed: Int?
    let pitchCount: Int?
    let decision: String?
    let qualityStart: Bool?
    let pitched: Bool?
}

private struct DailyIQBackendSeasonStats: Decodable {
    let gamesPlayed: Int
    let atBats: Int
    let runs: Int
    let hits: Int
    let homeRuns: Int
    let rbi: Int
    let rbis: Int
    let walks: Int
    let strikeouts: Int
    let stolenBases: Int
    let battingAverage: String
    let onBasePercentage: String
    let sluggingPercentage: String
    let ops: String
    let obp: String
    let slg: String
    let statsType: String?
    // Pitcher season fields (sent as String by backend, e.g. "1.98")
    let era: String?
    let wins: Int?
    let losses: Int?
    let saves: Int?
    let gamesStarted: Int?
    let whip: String?
}

private extension DailyIQBackendBriefResponse {
    func asAppResponse(dateFallback: String?) -> DailyIQResponse {
        let mlbPlayers = mlb.map { APIService.makeDailyPlayerStat(from: $0) }
        let milbPlayers = milb.map { APIService.makeDailyPlayerStat(from: $0) }
        let combinedPlayers = Array((mlbPlayers + milbPlayers).prefix(6))
        let hotPlayers = Array(Set(combinedPlayers.map { $0.playerName })).sorted()
        let mappedByLevel: [String: [DailyPlayerStat]]? = byLevel?.mapValues { players in
            players.map { APIService.makeDailyPlayerStat(from: $0) }
        }

        return DailyIQResponse(
            date: dateFallback ?? date,
            portfolioHighlights: [],
            buyTargets: [],
            topMLB: mlbPlayers,
            topMiLB: milbPlayers,
            hotPlayers: hotPlayers,
            byLevel: mappedByLevel
        )
    }
}

private struct DailyWatchlistEnvelope: Decodable {
    let watchlist: [WatchPlayerResult]

    private enum CodingKeys: String, CodingKey {
        case watchlist
        case items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let list = try? container.decode([WatchPlayerResult].self, forKey: .watchlist) {
            self.watchlist = list
        } else if let list = try? container.decode([WatchPlayerResult].self, forKey: .items) {
            self.watchlist = list
        } else {
            self.watchlist = []
        }
    }
}
struct PortfolioIQBackendSummaryResponse: Decodable {
    let inventory: PortfolioInventorySummary?
    let month: SummaryPeriod?
    let year: SummaryPeriod?
}

/// CF-ADD-TO-INVENTORY (2026-06-12): wire body for POST
/// /api/portfolioiq/holdings. parallelId is required for parallels so the
/// server-side auto-price runs in graded scope (matching the rail
/// estimate the user just saw on the comp page). purchasePrice is
/// optional; nil means "I haven't entered a cost basis yet" — backend
/// stores null and the dashboard's observed-gain line stays blank for
/// this holding.
struct AddHoldingRequest: Encodable {
    let playerName: String
    let cardsightCardId: String
    let parallel: String?
    let parallelId: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let purchasePrice: Double?
    let quantity: Int
}

/// CF-ADD-TO-INVENTORY (2026-06-12): backend returns 201 with the
/// auto-priced holding inline so the iOS sheet can confirm with the
/// real valuation in hand (no double-fetch).
struct AddHoldingResponse: Decodable {
    let holding: InventoryCard?
    let success: Bool?
}

struct PortfolioIQHoldingsEnvelope: Decodable {
    let holdings: [InventoryCard]

    private enum CodingKeys: String, CodingKey {
        case holdings
        case items
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let holdings = try? container.decode([InventoryCard].self, forKey: .holdings) {
            self.holdings = holdings
        } else if let items = try? container.decode([InventoryCard].self, forKey: .items) {
            self.holdings = items
        } else {
            self.holdings = []
        }
    }
}

private struct PortfolioIQSellRequest: Codable {
    let quantity: Int
    let salePrice: Double
    let fees: Double
    let tax: Double
    let shipping: Double
    let soldAt: String
    let source: String
    let notes: String?
}

struct PortfolioEbayListingRequest: Codable {
    let title: String
    let description: String
    let askingPrice: Double
    let quantity: Int
    let ebayUser: String?
    let cardId: String
    let playerName: String
    let cardName: String
    let year: String
    let setName: String
    let parallel: String
    let grade: String
    let condition: String?
    let brand: String?
    let cardNumber: String?
    let imageFrontUrl: String?
    let imageBackUrl: String?
    let purchasePrice: Double
    let purchasePlatform: String?
    let purchaseDate: String?
    let notes: String?
    let summary: String?
    let isAuto: Bool?
    let listingFormat: String?
    let auctionStartDate: String?
    let paymentPolicyId: String?
    let fulfillmentPolicyId: String?
    let returnPolicyId: String?

    init(
        title: String, description: String, askingPrice: Double, quantity: Int,
        ebayUser: String?, cardId: String, playerName: String, cardName: String,
        year: String, setName: String, parallel: String, grade: String,
        condition: String? = nil, brand: String? = nil, cardNumber: String? = nil,
        imageFrontUrl: String? = nil, imageBackUrl: String? = nil,
        purchasePrice: Double, purchasePlatform: String? = nil, purchaseDate: String? = nil,
        notes: String? = nil, summary: String? = nil, isAuto: Bool? = nil,
        listingFormat: String? = nil, auctionStartDate: String? = nil,
        paymentPolicyId: String? = nil, fulfillmentPolicyId: String? = nil, returnPolicyId: String? = nil
    ) {
        self.title = title; self.description = description; self.askingPrice = askingPrice
        self.quantity = quantity; self.ebayUser = ebayUser; self.cardId = cardId
        self.playerName = playerName; self.cardName = cardName; self.year = year
        self.setName = setName; self.parallel = parallel; self.grade = grade
        self.condition = condition; self.brand = brand; self.cardNumber = cardNumber
        self.imageFrontUrl = imageFrontUrl; self.imageBackUrl = imageBackUrl
        self.purchasePrice = purchasePrice; self.purchasePlatform = purchasePlatform
        self.purchaseDate = purchaseDate; self.notes = notes; self.summary = summary
        self.isAuto = isAuto; self.listingFormat = listingFormat
        self.auctionStartDate = auctionStartDate
        self.paymentPolicyId = paymentPolicyId; self.fulfillmentPolicyId = fulfillmentPolicyId
        self.returnPolicyId = returnPolicyId
    }
}

private struct AuthAppleSignInRequest: Codable {}

private struct AuthEmailSignInRequest: Codable {
    let email: String
    let password: String
}

private struct AuthEmailSignUpRequest: Codable {
    let username: String
    let email: String
    let password: String
}

private struct AppleSignInRequest: Encodable {
    let identityToken: String
    let email: String?
    let fullName: String?
    let username: String?
}

struct AlertsAPIResponse: Decodable {
    let success: Bool?
    let alerts: [AlertAPIItem]?
    let message: String?
}

struct AlertAPIItem: Decodable, Identifiable {
    let id: String
    let type: String?
    let playerName: String?
    let cardName: String?
    let message: String?
    let severity: String?
    let createdAt: String?
    let triggeredAt: String?
}

struct CreateAlertRequest: Encodable {
    let type: String
    let playerName: String?
    let cardName: String?
    let threshold: Double?
}

private struct TriggerAlertRequest: Encodable {
    let alertId: String
}

private extension Optional where Wrapped == String {
    var nonEmptyTrimmed: String? {
        guard let value = self?.trimmingCharacters(in: .whitespacesAndNewlines), value.isEmpty == false else {
            return nil
        }
        return value
    }
}

struct AuthSignInResponse: Decodable {
    let success: Bool
    let user: BackendAuthUser?
    let sessionId: String?
    let error: String?
}

struct BackendAuthUser: Decodable {
    let userId: String
    let email: String
    let plan: String
    let createdAt: String
}

struct PortfolioIQActionResponse: Decodable {
    let success: Bool?
    let message: String?
    let holding: InventoryCard?
    let id: String?
}

struct EBayConnectionStatusResponse: Decodable {
    let connected: Bool?
    let connectedUser: String?
    let status: String?
    let message: String?
    let lastCheckedAt: String?
}

struct EBayConnectStartResponse: Decodable {
    let authUrl: String?
    let authorizationUrl: String?
    let url: String?
    let message: String?

    var authURL: String? { authUrl }
    var authorizationURL: String? { authorizationUrl }
}

struct EBayDisconnectResponse: Decodable {
    let success: Bool?
    let connected: Bool?
    let message: String?
}

struct EBayReconnectResponse: Decodable {
    let success: Bool?
    let authUrl: String?
    let reconnected: Bool?
}

struct EbayPolicy: Decodable, Identifiable {
    let policyId: String
    let name: String?
    let isDefault: Bool?
    var id: String { policyId }
}

struct EbayPoliciesResponse: Decodable {
    let success: Bool?
    let paymentPolicies: [EbayPolicy]?
    let fulfillmentPolicies: [EbayPolicy]?
    let returnPolicies: [EbayPolicy]?
}

struct EbayListingStatusResponse: Decodable {
    let success: Bool?
    let offerId: String?
    let status: String?
    let listingId: String?
    let listingUrl: String?
    let price: Double?
    let quantity: Int?
    let categoryId: String?
    let marketplaceId: String?
}

struct EbayMissingPolicy: Decodable {
    let policyType: String?
    let reason: String?
}

struct EbayReviseResponse: Decodable {
    let success: Bool?
    let offerId: String?
    let inventoryItemKey: String?
    let error: String?
    let missingPolicy: EbayMissingPolicy?
}

struct EbayEndListingResponse: Decodable {
    let success: Bool?
}

struct CardPhotoUploadResponse: Decodable {
    let success: Bool?
    let url: String?
    let path: String?
    let mimeType: String?
    let size: Int?
    let message: String?

    var resolvedURL: String? {
        url ?? path
    }
}

extension CardPhotoUploadResponse {
    init(sasUrl: String) {
        self.success = true
        self.url = sasUrl
        self.path = nil
        self.mimeType = "image/jpeg"
        self.size = nil
        self.message = nil
    }
}

struct EbayListingResponse: Decodable {
    let success: Bool?
    let message: String?
    let listingId: String?
    let listingUrl: String?
    let status: String?

    var listingURL: String? { listingUrl }
}

typealias PortfolioEbayListingResponse = EbayListingResponse

// MARK: - Unified Card Search Models

private struct UnifiedSearchRequest: Encodable {
    let input: String
    let hint: String?
}

struct UnifiedSearchInput: Decodable {
    let raw: String?
    let detectedMode: String?
    let recognizingGraders: [String]?
}

struct SearchCandidate: Decodable, Hashable {
    let candidateId: String?
    let source: String?
    let attribution: String?
    let confidence: Double?
    let player: String?
    let year: String?
    let brand: String?
    let setName: String?
    let cardNumber: String?
    let parallel: String?
    let variation: String?
    let isAuto: Bool?
    let serialNumber: String?
    let grade: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let certNumber: String?
    let totalPopulation: Int?
    let populationHigher: Int?
    let title: String?
    let imageUrl: String?
    let raw: String?

    var stableId: String { candidateId ?? title ?? UUID().uuidString }
}

struct UnifiedSearchResponse: Decodable {
    let input: UnifiedSearchInput?
    let candidates: [SearchCandidate]?
    let warnings: [String]?
}

// MARK: - Username Change Models

private struct UsernameChangeRequest: Encodable {
    let username: String
}

struct UsernameChangeResponse: Decodable {
    let success: Bool?
    let user: BackendAuthUser?
    let sessionId: String?
    let error: String?
}

// MARK: - PlayerIQ Top / History Models

struct PlayerIQTopEntry: Decodable, Hashable {
    let entryId: String?
    let playerId: String?
    let playerName: String?
    let mlbPlayerId: Int?
    let team: String?
    let position: String?
    let league: String?
    let level: String?
    let market: PlayerIQMarket?
    let performance: PlayerIQPerformance?
    let playerIQScore: Int?
    let playerIQLabel: String?
    let playerIQDirection: String?
    let updatedAt: String?
    let dataSource: String?
    let confidence: String?

    var stableId: String { entryId ?? playerId ?? playerName ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case entryId = "id"
        case playerId, playerName, mlbPlayerId, team, position, league, level
        case market, performance
        case playerIQScore, playerIQLabel, playerIQDirection
        case updatedAt, dataSource, confidence
    }
}

struct PlayerIQTopResponse: Decodable {
    let players: [PlayerIQTopEntry]?
    let count: Int?
    let generatedAt: String?
}

struct PlayerIQHistoryPoint: Decodable, Hashable {
    let playerIQScore: Int?
    let playerIQDirection: String?
    let playerIQLabel: String?
    let marketScore: Int?
    let performanceScore: Int?
    let updatedAt: String?
    let dataSource: String?
}

struct PlayerIQHistoryResponse: Decodable {
    let playerName: String?
    let playerId: String?
    let points: [PlayerIQHistoryPoint]?
    let count: Int?
}

private struct MultipartFormPart {
    let name: String
    let value: String
}

private struct MultipartFilePart {
    let name: String
    let fileName: String
    let mimeType: String
    let data: Data
}

struct DeviceTokenRequest: Encodable {
    let token: String
    let platform: String
    let bundleId: String
}

struct DeviceTokenResponse: Decodable {
    let success: Bool?
    let message: String?
}

struct NotificationPreferencesResponse: Decodable {
    let dailyIQAlerts: Bool?
    let priceAlerts: Bool?
    let portfolioMovementAlerts: Bool?
    let portfolioMovementMinValue: Double?
}

struct NotificationPreferencesRequest: Encodable {
    var dailyIQAlerts: Bool?
    var priceAlerts: Bool?
    var portfolioMovementAlerts: Bool?
    var portfolioMovementMinValue: Double?
}

// MARK: - Subscription / Entitlement Models

struct VerifySubscriptionRequest: Encodable {
    let jwsRepresentation: String
}

struct VerifySubscriptionResponse: Decodable {
    let success: Bool
    let plan: String?
    let expiresAt: String?
    let error: String?
}

enum CapValue: Decodable, Equatable {
    case limited(Int)
    case unlimited

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let str = try? container.decode(String.self), str == "unlimited" {
            self = .unlimited
        } else if let num = try? container.decode(Int.self) {
            self = .limited(num)
        } else {
            self = .limited(0)
        }
    }
}

struct EntitlementCaps: Decodable, Equatable {
    let priceChecksPerDay: CapValue
    let holdingsCap: CapValue
    let scansPerMonth: CapValue
    let priceAlerts: CapValue
}

struct EntitlementResponse: Decodable {
    let success: Bool
    let plan: String
    let features: [String]
    let caps: EntitlementCaps
}

// MARK: - Auth Session / Account Models

private struct EmptyBody: Encodable {}

struct AuthSignOutResponse: Decodable {
    let success: Bool
    let error: String?
}

struct AuthSessionResponse: Decodable {
    let success: Bool
    let user: BackendAuthUser?
}

private struct AccountDeletionRequest: Encodable {
    let confirm: String
}

struct AccountDeletionResponse: Decodable {
    let success: Bool
    let userId: String?
    let deletedAt: String?
    let failures: [String]?
    let appleSubscription: AccountDeletionAppleSubscription?
}

struct AccountDeletionAppleSubscription: Decodable {
    let wasLinked: Bool?
    let billingActionRequired: Bool?
    let message: String?
    let cancellationInstructionsUrl: String?
}

private extension Data {
    mutating func appendString(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}
