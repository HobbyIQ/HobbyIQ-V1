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

    /// CF-ALIAS-LEARNING (2026-07-09): fire-and-forget telemetry. Every
    /// time a user picks a specific result from search / typeahead /
    /// dropdown, POST the (query, cardId, source) triple so the nightly
    /// alias-learning job can grow the 722-entry alias corpus. Callers
    /// wrap in `Task { _ = try? await ... }` — never awaited on the
    /// navigation path, no UI on failure, no retries. The response
    /// shape is intentionally minimal; we don't consult it.
    @discardableResult
    func logCompIQSelection(_ body: CompIQLogSelectionRequest) async throws -> CompIQLogSelectionResponse {
        try await post(
            path: "/api/compiq/log-selection",
            body: body,
            responseType: CompIQLogSelectionResponse.self
        )
    }

    /// CF-COMPIQ-SCAN-ROUTE (2026-06-30 / PR #215+#217): POST /api/compiq/scan.
    /// Two paths in one endpoint — cert-OCR on graded slabs and image-match
    /// on raw cards. `hint` steers routing: `"graded"` cert-OCR only,
    /// `"raw"` image-match only, `"auto"` (default) tries cert-OCR then
    /// falls back to image-match. Rate-limited on the same `priceChecksPerDay`
    /// budget as `/price` and `/price-by-id`. Backend emits a
    /// `compiq_scan_attempt` telemetry event with matchPath +
    /// matchConfidence + hadCertInfo (no image content).
    ///
    /// One of `imageUrl` / `imageBase64` is required; sending both is
    /// permitted but backend prefers `imageUrl` when present (10-min cache).
    /// Longer timeout (30s) than the default 10s because the CV matcher on
    /// a cold instance can take several seconds.
    func scanCard(imageUrl: String? = nil, imageBase64: String? = nil, hint: String = "auto") async throws -> CompIQScanResponse {
        let body = CompIQScanRequest(imageUrl: imageUrl, imageBase64: imageBase64, hint: hint)
        return try await post(
            path: "/api/compiq/scan",
            body: body,
            responseType: CompIQScanResponse.self,
            timeoutSeconds: 30
        )
    }

    /// CF-FIND-CARDS-PHASE-B: typeahead suggestions for the Find Cards
    /// field. GET /api/compiq/suggest?q=<text>. Cardsight ignores `take`
    /// (always returns ~10) and ignores `segment`, so we cap the display
    /// list client-side via `.prefix(n)` at the call site. Returns an
    /// empty array on a defensive-decode miss — the dropdown is advisory
    /// only; a typeahead failure must NEVER block the literal search.
    func fetchSearchSuggestions(q: String) async throws -> [String] {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return [] }
        let response = try await get(
            path: "/api/compiq/suggest",
            queryItems: [URLQueryItem(name: "q", value: trimmed)],
            responseType: CompIQSuggestResponse.self
        )
        return response.suggestions ?? []
    }

    /// CF-LIVE-SUGGEST (2026-07-06): richer live-suggest driver for the
    /// Find Cards search bar. Hits the same `/api/search/cards`
    /// dispatcher as `searchVariantList` so results are the same rows
    /// the full-search picker would render, but with a tighter timeout
    /// so a slow dispatcher call can't gum up a per-keystroke debounce.
    /// Failure is swallowed at the call site — live suggestions are
    /// advisory only.
    func fetchLiveCardSuggestions(q: String, limit: Int = 8) async throws -> [CompIQVariantHit] {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return [] }
        let body = CompIQVariantSearchRequest(input: trimmed, hint: "freetext")
        let response = try await post(
            path: "/api/search/cards",
            body: body,
            responseType: CompIQVariantListResponse.self,
            timeoutSeconds: 6
        )
        return Array((response.results ?? []).prefix(limit))
    }

    /// CF-LIVE-SUGGEST (2026-07-06): parse-preview endpoint driving the
    /// "We understood: year=…" hint line. Advisory only — a fetch
    /// failure hides the line silently and does NOT block the literal
    /// search. Tight timeout for per-keystroke debounce.
    func fetchParsePreview(q: String) async throws -> CompIQParsePreviewResponse {
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await get(
            path: "/api/compiq/parse-preview",
            queryItems: [URLQueryItem(name: "q", value: trimmed)],
            responseType: CompIQParsePreviewResponse.self,
            timeoutSeconds: 6
        )
    }

    func searchVariantList(query: String, hint: String = "freetext") async throws -> CompIQVariantListResponse {
        let body = CompIQVariantSearchRequest(input: query, hint: hint)
        // CF-UNIFIED-SEARCH-ENDPOINT (2026-07-01): switched from the legacy
        // `/api/compiq/cardsearch` to the canonical unified-search route
        // `/api/search/cards`. Per compiq.routes.ts:784, "Drew's operational
        // picker use during the gap routes through /api/search/cards directly."
        // Same internal dispatcher, but the wire field is `input` (not `query`).
        // 30s timeout kept for cold-cache broad queries; picker shimmer still
        // lets the user cancel.
        return try await post(
            path: "/api/search/cards",
            body: body,
            responseType: CompIQVariantListResponse.self,
            timeoutSeconds: 30
        )
    }

    func priceByCardId(
        cardId: String,
        query: String?,
        gradeCompany: String?,
        gradeValue: Double?,
        parallelId: String? = nil,
        parallelName: String? = nil,
        isBlackLabel: Bool? = nil
    ) async throws -> CompIQPriceByIdResponse {
        // CF-PRICE-BY-ID-ROUTE (2026-06-07): when a candidate id is pinned,
        // send id + grade ONLY — omit a meaningful query. Backend treats a
        // non-empty `query` alongside `cardId` as free-text intent
        // and routes through findCompsRouted, which bypasses the pinned-card
        // schema fix and the returned-id consistency guard shipped in
        // f7d2f97 (resulting in Frazier $1 / 4-of-4 instead of Trout $377 /
        // 20-of-26 for fda530ab…). Forcing query=nil here drops
        // hasMeaningfulQuery=true on the backend so the request lands on
        // the pinned path. Callers keep their query string for ergonomics;
        // we only strip it on the wire when an id is actually present.
        let pinnedQuery: String? = cardId.isEmpty ? query : nil
        // CF-PARALLEL-SUBMARKET (2026-06-10): when a parallel is selected,
        // backend wants `cardId = parent base UUID` PLUS
        // `parallelId = parallel UUID` so the comp filter narrows to the
        // matched sub-market (vs the parallel UUID landing on
        // cardId alone, which doesn't resolve as a pricing key).
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
            cardId: cardId,
            query: pinnedQuery,
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            parallelId: cleanParallelId,
            parallelName: cleanParallelName,
            isBlackLabel: isBlackLabel
        )
        // CF-FIND-CARDS-REGROUND: price-by-id needs headroom too. With a
        // `query` + `parallelId` + `parallelName` (the natural shape a
        // comp-page tap produces for a graded auto parallel), backend
        // routes through findCompsRouted, which aggregates comps from
        // multiple sources and can run several seconds on a cold cache.
        // The 10s default URLRequest timeout was firing before the
        // dispatcher could finish on broader queries (observed: "2024
        // bowman CHROME BLUE AUTO LEO DE VRIES" → 10s timeout).
        return try await post(
            path: "/api/compiq/price-by-id",
            body: body,
            responseType: CompIQPriceByIdResponse.self,
            timeoutSeconds: 30
        )
    }

    // MARK: - CompIQ Bulk Grade Curves (backend batch 2026-07-04)

    /// POST /api/compiq/observed-grade-curves-bulk — batched observed
    /// grade curves for portfolio-scale flows (grade-breakdown column,
    /// portfolio reprice preview, watchlist refresh). Server bounds:
    /// max 500 cardIds per HTTP request. This wrapper chunks larger
    /// sets and merges the responses into a single result.
    ///
    /// Server-side: gated behind `requireEntitlement("predictions")`
    /// (compute-heavy). Server also dedups cardIds and caches 12h,
    /// so re-firing with the same set is cheap.
    func fetchBulkGradeCurves(cardIds: [String]) async throws -> BulkGradeCurvesResponse {
        let trimmed = cardIds
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.isEmpty == false }
        guard trimmed.isEmpty == false else {
            return BulkGradeCurvesResponse(success: true, count: 0, curves: [])
        }
        let chunkSize = 500
        // Fast path: one chunk, one request.
        if trimmed.count <= chunkSize {
            return try await postBulkGradeCurvesChunk(trimmed)
        }
        // Slow path: parallel chunks, merged. Concurrency bounded by
        // Swift structured concurrency's task group scheduler; server
        // is already capped at 8 in-flight per session so this is safe.
        var merged: [BulkGradeCurve] = []
        try await withThrowingTaskGroup(of: BulkGradeCurvesResponse.self) { group in
            for start in stride(from: 0, to: trimmed.count, by: chunkSize) {
                let end = min(start + chunkSize, trimmed.count)
                let chunk = Array(trimmed[start..<end])
                group.addTask {
                    try await self.postBulkGradeCurvesChunk(chunk)
                }
            }
            for try await response in group {
                if let curves = response.curves {
                    merged.append(contentsOf: curves)
                }
            }
        }
        return BulkGradeCurvesResponse(success: true, count: merged.count, curves: merged)
    }

    private func postBulkGradeCurvesChunk(_ cardIds: [String]) async throws -> BulkGradeCurvesResponse {
        let body = BulkGradeCurvesRequest(cardIds: cardIds)
        return try await post(
            path: "/api/compiq/observed-grade-curves-bulk",
            body: body,
            responseType: BulkGradeCurvesResponse.self,
            timeoutSeconds: 60
        )
    }

    // MARK: - CompIQ New Releases (backend batch 2026-07-04)

    /// GET /api/compiq/new-releases — recently added catalog sets.
    /// All params optional; backend defaults to a 30-day window,
    /// page=1, pageSize=50. `category` omitted here means "All".
    func fetchNewReleases(
        startDate: String? = nil,
        endDate: String? = nil,
        category: String? = nil,
        page: Int = 1,
        pageSize: Int = 50
    ) async throws -> NewReleasesResponse {
        var items: [URLQueryItem] = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize))
        ]
        if let startDate, startDate.isEmpty == false {
            items.append(URLQueryItem(name: "startDate", value: startDate))
        }
        if let endDate, endDate.isEmpty == false {
            items.append(URLQueryItem(name: "endDate", value: endDate))
        }
        if let category, category.isEmpty == false {
            items.append(URLQueryItem(name: "category", value: category))
        }
        return try await get(
            path: "/api/compiq/new-releases",
            queryItems: items,
            responseType: NewReleasesResponse.self,
            timeoutSeconds: 30
        )
    }

    // MARK: - CompIQ Cert Lookup (backend batch 2026-07-04)

    /// POST /api/compiq/lookup-by-cert — direct cert-number → card
    /// resolution. Complements the image-scan /api/compiq/scan flow.
    /// The response envelope carries `success: false` + `error` on the
    /// not-found path; callers should branch on `response.success` and
    /// treat this as a semantic, not a thrown, failure.
    func fetchCertLookup(
        cert: String,
        grader: String,
        days: Int? = 90
    ) async throws -> LookupByCertResponse {
        let body = LookupByCertRequest(cert: cert, grader: grader, days: days)
        return try await post(
            path: "/api/compiq/lookup-by-cert",
            body: body,
            responseType: LookupByCertResponse.self,
            timeoutSeconds: 30
        )
    }

    // MARK: - CompIQ Card Panel (backend batch 2026-07-04)

    /// GET /api/compiq/card-panel/:cardId — single-round-trip payload
    /// containing identity, the 10-canonical-grade curve, and the
    /// reference-price array. Preferred over the split
    /// /observed-grade-curve and /all-grade-prices routes when the
    /// caller needs multiple pieces. Replaces the earlier
    /// /api/compiq/card-grades endpoint.
    func fetchCardPanel(cardId: String) async throws -> CardPanelResponse {
        let trimmed = cardId.trimmingCharacters(in: .whitespacesAndNewlines)
        // CF-EMPTY-CARDID-GUARD (2026-07-09): sibling-fallback +
        // product-family-projection responses set `cardIdentity.card_id`
        // to "" (real card_id only exists once CH indexes the SKU).
        // GET /api/compiq/card-panel/ (empty path segment) 400s on the
        // backend, so refuse to make the call in the first place.
        // Callers already wrap this in `try?` for defensive rendering.
        guard trimmed.isEmpty == false else {
            throw APIServiceError.invalidURL
        }
        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trimmed
        // CF-CARD-PANEL-DECODE (2026-07-04): the shared JSONDecoder has no
        // key-decoding strategy, so a backend that emits snake_case
        // (grade_curve, sample_count, weighted_median_price,
        // value_source, estimated_multiplier) would silently produce
        // an all-nil-fields response, leaving every pill blank. Fetch
        // raw bytes, try both key strategies, and pick the response
        // that decoded the most entries so we don't silently return
        // an empty panel.
        let data = try await fetchData(path: "/api/compiq/card-panel/\(encoded)")

        #if DEBUG
        let sniff = String(data: data.prefix(600), encoding: .utf8) ?? "<binary>"
        print("[card-panel-raw] cardId=\(cardId) first600=\(sniff)")
        #endif

        let snakeCase = JSONDecoder()
        snakeCase.keyDecodingStrategy = .convertFromSnakeCase
        let snakeResp = try? snakeCase.decode(CardPanelResponse.self, from: data)
        let plainResp = try? JSONDecoder().decode(CardPanelResponse.self, from: data)

        let snakeEntries = snakeResp?.gradeCurve?.entries?.count ?? 0
        let plainEntries = plainResp?.gradeCurve?.entries?.count ?? 0
        #if DEBUG
        print("[card-panel-raw] decoded entries — snakeCase=\(snakeEntries) plain=\(plainEntries)")
        #endif

        if snakeEntries >= plainEntries, let r = snakeResp { return r }
        if let r = plainResp { return r }
        if let r = snakeResp { return r }
        return try JSONDecoder().decode(CardPanelResponse.self, from: data)
    }

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

    // CF-PHASE-5-COLLECTION-VALUE (2026-06-18): collection-value card data.
    // Headline (`totalDisplayable`, range, counts) is computed LIVE from
    // the user doc; `historySeries` is the persisted daily trail.
    // Off the hot inventory path — the card loads independently.
    func fetchCollectionValueHistory() async throws -> PortfolioValueHistoryResponse {
        try await get(path: "/api/portfolio/value-history", responseType: PortfolioValueHistoryResponse.self)
    }

    func submitRecommendationFeedback(request: RecommendationFeedbackRequest) async throws -> RecommendationFeedbackResponse {
        try await post(path: "/api/portfolio/feedback/recommendation", body: request, responseType: RecommendationFeedbackResponse.self)
    }

    func fetchHoldingHistory(holdingId: String) async throws -> HoldingPriceHistoryResponse {
        try await get(path: "/api/portfolio/holdings/\(holdingId)/history", responseType: HoldingPriceHistoryResponse.self)
    }

    // MARK: - PR #425: Supply/Demand portfolio aggregates

    /// Portfolio-wide bias + per-holding movers. Powers the
    /// Supply/Demand Dashboard card on Portfolio Home.
    func fetchSupplyDemandSummary() async throws -> SupplyDemandSummaryResponse {
        try await get(path: "/api/portfolio/supply-demand-summary", responseType: SupplyDemandSummaryResponse.self)
    }

    /// Three-column portfolio totals (gross / trend-adjusted / net after
    /// fees) plus a breakdown by verdict class. Powers the
    /// Signal-Weighted Totals card on Portfolio Home.
    func fetchSignalWeightedTotals() async throws -> SignalWeightedTotalsResponse {
        try await get(path: "/api/portfolio/signal-weighted-totals", responseType: SignalWeightedTotalsResponse.self)
    }

    /// Watchlisted players whose supply/demand verdict is bullish.
    /// Powers the Buy Candidates section on DailyIQ.
    func fetchWatchlistBullCandidates() async throws -> WatchlistBullCandidatesResponse {
        try await get(path: "/api/portfolio/watchlist-bull-candidates", responseType: WatchlistBullCandidatesResponse.self)
    }

    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): batch mirror
    /// for the inventory-row freshness dot. Backend enforces 1..200
    /// `players` and 1..30 `days`; iOS batches larger portfolios before
    /// calling. Returns `flips: []` when the underlying Cosmos read fails
    /// so callers can treat any error as "no dot".
    func fetchPortfolioFlips(players: [String], days: Int = 7) async throws -> PortfolioFlipsResponse {
        let body = PortfolioFlipsRequest(players: players, days: days)
        return try await post(
            path: "/api/compiq/portfolio/flips",
            body: body,
            responseType: PortfolioFlipsResponse.self
        )
    }

    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): per-player
    /// verdict snapshot history + detected flips for the holding-detail
    /// history strip. Backend normalizes the player name server-side, so
    /// callers pass the raw display string. `days` is 1..180 (default 90).
    func fetchVerdictHistory(player: String, days: Int = 90) async throws -> VerdictHistoryResponse {
        let encoded = player.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? player
        return try await get(
            path: "/api/compiq/players/\(encoded)/verdict-history",
            queryItems: [URLQueryItem(name: "days", value: String(days))],
            responseType: VerdictHistoryResponse.self
        )
    }

    // MARK: - Corpus Signals (PR #517-#520, 2026-07-17)

    /// PR #517: matched-cohort momentum for a single player. Path segment
    /// is the raw display name; backend slugs internally (lowercase +
    /// hyphens). `raw` / `graded` sub-objects arrived in PR #519 —
    /// callers must treat them as optional.
    func fetchPlayerTrend(player: String) async throws -> PlayerTrendResponse {
        let encoded = player.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? player
        return try await get(
            path: "/api/portfolio/player-trend/\(encoded)",
            responseType: PlayerTrendResponse.self
        )
    }

    /// PR #518: per-holding grade-worthy analysis (best tier + all tiers +
    /// diagnostics). Raw-only signal — pointless to fetch for holdings
    /// that are already graded; caller should gate on
    /// `gradeCompany == nil` before firing.
    func fetchGradeAnalysis(holdingId: String) async throws -> GradeAnalysisResponse {
        try await get(
            path: "/api/portfolio/holdings/\(holdingId)/grade-analysis",
            responseType: GradeAnalysisResponse.self
        )
    }

    /// PR #518: portfolio-wide scan returning only `grade_now`
    /// candidates, sorted by best-tier `expectedGain` DESC. Feeds the
    /// portfolio-home banner + list view.
    func fetchGradeWorthyAlerts() async throws -> GradeWorthyAlertsResponse {
        try await get(
            path: "/api/portfolio/grade-worthy-alerts",
            responseType: GradeWorthyAlertsResponse.self
        )
    }

    /// PR #520: observed family multipliers (grader-tier premium curves
    /// blended by product family). `family` accepts either the human
    /// string or the slug; backend slugs idempotently. Optional
    /// `tier` filter narrows to a single graded rung.
    func fetchFamilyMultipliers(family: String, tier: String? = nil) async throws -> FamilyMultipliersResponse {
        let encodedFamily = family.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? family
        var path = "/api/portfolio/family-multipliers/\(encodedFamily)"
        if let tier {
            let encodedTier = tier.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tier
            path += "/\(encodedTier)"
        }
        return try await get(path: path, responseType: FamilyMultipliersResponse.self)
    }

    /// PR #529: value-weighted portfolio-level momentum. Feeds the
    /// Portfolio Momentum hero on the Portfolio Home tab.
    func fetchPortfolioMomentum() async throws -> PortfolioMomentumResponse {
        try await get(path: "/api/portfolio/momentum", responseType: PortfolioMomentumResponse.self)
    }

    /// PR #529: top players by momentum × velocity for the DailyIQ tab's
    /// "Hot Right Now" surface. `limit` bounded 1..25 backend-side.
    func fetchHotRightNow(limit: Int = 25) async throws -> HotRightNowResponse {
        try await get(
            path: "/api/dailyiq/hot-right-now",
            queryItems: [URLQueryItem(name: "limit", value: String(limit))],
            responseType: HotRightNowResponse.self
        )
    }

    /// PR #546: sorted per-holding verdict feed for the DailyIQ tab's
    /// Action Plan hero. Empty `actions` when the portfolio has none
    /// (freshly onboarded users) — UI suppresses the block.
    func fetchActionPlan() async throws -> ActionPlanResponse {
        try await get(path: "/api/dailyiq/action-plan", responseType: ActionPlanResponse.self)
    }

    // PR #526's fetchTimingForecast removed 2026-07-17 — the standalone
    // 30-day timing forecast was consolidated into PREDICTED (7d) which
    // now sources the same matched-cohort math after backend PR #543.

    /// PR #527: recent cascade events for players in the user's portfolio.
    /// Empty when nothing fires — banner suppresses.
    func fetchCascadeAlerts() async throws -> CascadeAlertsResponse {
        try await get(path: "/api/portfolio/cascade-alerts", responseType: CascadeAlertsResponse.self)
    }

    /// PR #533: shareable "I Called It" flex moments — cards the user
    /// bought that appreciated meaningfully. Empty when the portfolio has
    /// no qualifying moments.
    func fetchICalledIt() async throws -> ICalledItResponse {
        try await get(path: "/api/portfolio/i-called-it", responseType: ICalledItResponse.self)
    }

    /// PR #544 (2026-07-17): GET /api/compiq/cards/:cardId/active-listings.
    /// Returns eBay active listings ranked against the card + grade context.
    /// `gradeCompany` + `gradeValue` are optional — omit them for the
    /// CompIQ tab's un-owned card path (backend defaults to Raw).
    func fetchActiveListings(
        cardId: String,
        gradeCompany: String? = nil,
        gradeValue: String? = nil
    ) async throws -> ActiveListingsResponse {
        let encoded = cardId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? cardId
        var query: [URLQueryItem] = []
        if let gradeCompany, gradeCompany.isEmpty == false {
            query.append(URLQueryItem(name: "gradeCompany", value: gradeCompany))
        }
        if let gradeValue, gradeValue.isEmpty == false {
            query.append(URLQueryItem(name: "gradeValue", value: gradeValue))
        }
        return try await get(
            path: "/api/compiq/cards/\(encoded)/active-listings",
            queryItems: query,
            responseType: ActiveListingsResponse.self,
            timeoutSeconds: 15
        )
    }

    /// PR #533: annual/quarterly recap. Full-screen retrospective on the
    /// Profile menu after Dec 15 each year. `year` required; optional
    /// `quarter` narrows to a quarter (`Q1`..`Q4`).
    func fetchYearbook(year: Int, quarter: String? = nil) async throws -> YearbookResponse {
        var query: [URLQueryItem] = [URLQueryItem(name: "year", value: String(year))]
        if let quarter {
            query.append(URLQueryItem(name: "quarter", value: quarter))
        }
        return try await get(
            path: "/api/portfolio/yearbook",
            queryItems: query,
            responseType: YearbookResponse.self
        )
    }

    // MARK: - Corpus Signals — Second batch (PR #538/#539/#531, 2026-07-17)

    /// PR #538: observed parallel-tier multipliers for a
    /// (player, year, cardSet) bucket. Key is `"player::year::cardSet"`,
    /// URL-encoded once as the path segment. Empty ladder + a
    /// `suppressedReason` when the base pool is thin.
    func fetchParallelLadder(player: String, year: Int, cardSet: String) async throws -> ParallelLadderResponse {
        let composed = "\(player)::\(year)::\(cardSet)"
        let encoded = composed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? composed
        return try await get(
            path: "/api/portfolio/parallel-ladder/\(encoded)",
            responseType: ParallelLadderResponse.self
        )
    }

    /// PR #538: pHash-cluster attribution health across the user's
    /// portfolio. Suspects have `attributionScore < 0.85`.
    func fetchAttributionHealth() async throws -> AttributionHealthResponse {
        try await get(path: "/api/portfolio/attribution-health", responseType: AttributionHealthResponse.self)
    }

    /// PR #539: sell-now candidates — SKUs trading at ≥ 2× baseline
    /// velocity AND player momentum up ≥ 10%. Sorted by urgencyScore DESC.
    func fetchSellNowRadar() async throws -> SellNowRadarResponse {
        try await get(path: "/api/portfolio/sell-now-radar", responseType: SellNowRadarResponse.self)
    }

    /// PR #539: top-dollar sales in the requested window. Defaults —
    /// minPrice $100k, days 30, limit 20. Sorted saleDate DESC.
    func fetchNotableSales(minPrice: Double? = nil, days: Int? = nil, limit: Int? = nil) async throws -> NotableSalesResponse {
        var query: [URLQueryItem] = []
        if let minPrice { query.append(URLQueryItem(name: "minPrice", value: String(minPrice))) }
        if let days { query.append(URLQueryItem(name: "days", value: String(days))) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get(
            path: "/api/portfolio/notable-sales",
            queryItems: query,
            responseType: NotableSalesResponse.self
        )
    }

    /// PR #531/#541/#542: raw cards trading well below expected PSA 10
    /// value. Optional query gates match the backend's
    /// SubRawDiscoveryOptions type.
    func fetchSubRawDiscovery(
        maxRawPrice: Double? = nil,
        minExpectedGain: Double? = nil,
        minExpectedGainMultiple: Double? = nil,
        minFamilyConfidence: String? = nil,
        topN: Int? = nil
    ) async throws -> SubRawDiscoveryResponse {
        var query: [URLQueryItem] = []
        if let maxRawPrice { query.append(URLQueryItem(name: "maxRawPrice", value: String(maxRawPrice))) }
        if let minExpectedGain { query.append(URLQueryItem(name: "minGain", value: String(minExpectedGain))) }
        if let minExpectedGainMultiple { query.append(URLQueryItem(name: "minMultiple", value: String(minExpectedGainMultiple))) }
        if let minFamilyConfidence { query.append(URLQueryItem(name: "minConfidence", value: minFamilyConfidence)) }
        if let topN { query.append(URLQueryItem(name: "topN", value: String(topN))) }
        return try await get(
            path: "/api/portfolio/sub-raw-discovery",
            queryItems: query,
            responseType: SubRawDiscoveryResponse.self
        )
    }

    /// PR #531: every (player, year, cardSet) bucket the user has ≥1
    /// card in, with the parallels they DON'T own.
    func fetchMissingParallels() async throws -> MissingParallelsResponse {
        try await get(path: "/api/portfolio/missing-parallels", responseType: MissingParallelsResponse.self)
    }

    /// PR #531: single-bucket read for the card-detail Missing
    /// Parallels block. Key is `"player::year::cardSet"`, URL-encoded.
    func fetchMissingParallels(player: String, year: Int, cardSet: String) async throws -> MissingParallelsBucketResponse {
        let composed = "\(player)::\(year)::\(cardSet)"
        let encoded = composed.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? composed
        return try await get(
            path: "/api/portfolio/missing-parallels/\(encoded)",
            responseType: MissingParallelsBucketResponse.self
        )
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
        // CF-PR-E-IOS-PHASE-1A (2026-06-16): backend mounts override at
        // /api/portfolio/erp/unreconciled/:id/override. Pre-CF iOS path
        // was /api/portfolio/erp/override/:id which 404s; correcting here
        // so the new ReconcileDetailView's fee-edit state lands correctly
        // (the legacy ERPOverrideSheet retires in Phase 2 — this path was
        // unreachable in practice without that fix).
        try await post(path: "/api/portfolio/erp/unreconciled/\(entryId)/override", body: request, responseType: ERPOverrideResponse.self)
    }

    // CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16): save cost basis on an
    // unreconciled eBay entry. Response.entry is server-enriched
    // (costsStatus + missingFields populated). 409 with
    // `code: "ALREADY_FINALIZED"` propagates as APIServiceError.httpError
    // — caller renders it as a calm info banner.
    func saveLedgerCosts(entryId: String, request: ERPSaveCostsRequest) async throws -> ERPSaveCostsResponse {
        try await post(path: "/api/portfolio/erp/unreconciled/\(entryId)/save-costs", body: request, responseType: ERPSaveCostsResponse.self)
    }

    // PATCH /api/portfolio/ledger/:id — the dismiss ("Quiet for now")
    // path. Backend whitelist accepts dismissedAt/dismissedReason +
    // gradingCost/suppliesCost; here we only send the dismiss pair.
    // Response is the legacy `{ message, entry }` shape (NOT enriched
    // with costsStatus/missingFields — dismissed rows leave the inbox).
    func dismissLedgerEntry(entryId: String, reason: String?) async throws -> LedgerEntryUpdateResponse {
        let body = LedgerDismissRequest(
            dismissedAt: ISO8601DateFormatter().string(from: Date()),
            dismissedReason: reason
        )
        return try await patch(path: "/api/portfolio/ledger/\(entryId)", body: body, responseType: LedgerEntryUpdateResponse.self)
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

    // MARK: Scope 3 — Purchases / Held Expenses / Inventory Analytics
    //
    // Backend routes shipped 2026-07-12 via PRs #377-#381. All hang off the
    // established `/api/portfolio/erp/*` (and `/holdings/:id/expenses`) namespace.

    /// Imports the user's recent eBay purchase orders into the ERP
    /// purchases store. Backend caps `days` at 90 and rejects `< 1`.
    /// Idempotent on `ebayOrderId` — safe to re-run.
    func importEbayPurchases(days: Int) async throws -> EbayImportSummary {
        try await post(
            path: "/api/portfolio/erp/purchases/import/ebay",
            queryItems: [URLQueryItem(name: "days", value: String(days))],
            body: EmptyBody(),
            responseType: EbayImportSummary.self,
            timeoutSeconds: 60
        )
    }

    /// Lists purchases in the given window. Empty query = last 90 days.
    /// `source` filters to `"ebay"` or `"manual"`; nil returns both.
    func fetchPurchases(from: String? = nil, to: String? = nil, source: String? = nil) async throws -> PortfolioPurchaseListResponse {
        var items: [URLQueryItem] = []
        if let from { items.append(URLQueryItem(name: "from", value: from)) }
        if let to { items.append(URLQueryItem(name: "to", value: to)) }
        if let source { items.append(URLQueryItem(name: "source", value: source)) }
        return try await get(
            path: "/api/portfolio/erp/purchases",
            queryItems: items,
            responseType: PortfolioPurchaseListResponse.self
        )
    }

    /// Creates a manual purchase entry. Non-idempotent (each POST = new row).
    func createPurchase(_ request: PortfolioPurchaseCreateRequest) async throws -> PortfolioPurchaseCreateResponse {
        try await post(
            path: "/api/portfolio/erp/purchases",
            body: request,
            responseType: PortfolioPurchaseCreateResponse.self
        )
    }

    /// Attaches (Set-union merge, idempotent) the given holdings to a
    /// purchase. Used to attribute cataloged holdings back to an
    /// auto-imported eBay purchase whose `holdingIds[]` came in empty.
    func linkPurchaseHoldings(purchaseId: String, holdingIds: [String]) async throws -> PortfolioPurchaseLinkHoldingsResponse {
        try await patch(
            path: "/api/portfolio/erp/purchases/\(purchaseId)/link-holdings",
            body: PortfolioPurchaseLinkHoldingsRequest(holdingIds: holdingIds),
            responseType: PortfolioPurchaseLinkHoldingsResponse.self
        )
    }

    /// Adds an expense incurred while holding a card (grading, supplies,
    /// insurance, storage, etc). Backend rolls this into the holding's
    /// `totalCostBasis` and returns the fresh value — do NOT double-subtract
    /// on the client.
    func createHoldingExpense(holdingId: String, request: HoldingHeldExpenseCreateRequest) async throws -> HoldingHeldExpenseCreateResponse {
        try await post(
            path: "/api/portfolio/holdings/\(holdingId)/expenses",
            body: request,
            responseType: HoldingHeldExpenseCreateResponse.self
        )
    }

    func fetchHoldingExpenses(holdingId: String) async throws -> HoldingHeldExpenseListResponse {
        try await get(
            path: "/api/portfolio/holdings/\(holdingId)/expenses",
            responseType: HoldingHeldExpenseListResponse.self
        )
    }

    func deleteHoldingExpense(holdingId: String, expenseId: String) async throws -> HoldingHeldExpenseDeleteResponse {
        try await delete(
            path: "/api/portfolio/holdings/\(holdingId)/expenses/\(expenseId)",
            responseType: HoldingHeldExpenseDeleteResponse.self
        )
    }

    /// Inventory turnover + aging analytics. `from`/`to` scope the
    /// turnover window; the aging + oldestHoldings tables are always
    /// as-of-now (not window-scoped).
    func fetchInventoryAnalytics(from: String? = nil, to: String? = nil) async throws -> InventoryAnalyticsResponse {
        var items: [URLQueryItem] = []
        if let from { items.append(URLQueryItem(name: "from", value: from)) }
        if let to { items.append(URLQueryItem(name: "to", value: to)) }
        return try await get(
            path: "/api/portfolio/erp/inventory-analytics",
            queryItems: items,
            responseType: InventoryAnalyticsResponse.self
        )
    }

    // MARK: Scope 3.5 — eBay auto-import Review Queue (backend PRs #383-#388)
    //
    // Auto-imported eBay holdings land in `status = "pending-review"` and
    // stay OUT of inventory / P&L / dashboard totals until the user
    // confirms them. iOS surfaces a "Review needed (N)" queue at the top
    // of the inventory home; confirm/reject flow drains it.

    /// Returns holdings the user hasn't approved yet. Backend has been
    /// seen returning either a bare `[InventoryCard]` array OR the
    /// same envelope shape the main `/holdings` endpoint uses
    /// (`{ holdings: [...] }` / `{ items: [...] }` / `{ pending: [...] }`).
    /// The `PendingReviewEnvelope` decoder tries each in order.
    func fetchPendingReviewHoldings() async throws -> [InventoryCard] {
        let envelope: PendingReviewEnvelope = try await get(
            path: "/api/portfolio/holdings/pending-review",
            responseType: PendingReviewEnvelope.self,
            timeoutSeconds: 20
        )
        return envelope.holdings
    }

    /// Confirms a pending-review holding. Body carries ONLY the fields the
    /// user edited during review — unchanged fields must not be resent.
    /// Server flips `status → active`, records `correctionCount`, and
    /// makes the holding visible to every downstream reader.
    ///
    /// PR #425 aftermath (2026-07-14): backend runs autoPriceHolding +
    /// Cardsight rescue on the confirm round-trip, which pushes the
    /// response past the default ~10s URLRequest timeout on cold hits.
    /// Matches the 30s ceiling `updatePortfolioHolding` already uses
    /// for the same reason.
    func confirmPendingHolding(id: String, patch: HoldingConfirmRequest) async throws -> HoldingConfirmResponse {
        try await post(
            path: "/api/portfolio/erp/holdings/\(id)/confirm",
            body: patch,
            responseType: HoldingConfirmResponse.self,
            timeoutSeconds: 30
        )
    }

    /// 2026-07-15: best-effort moderation — flags a comp as wrong so
    /// the backend soft-deletes it from the shared pool. Returns
    /// `true` on success, `false` on 404 (comp already gone / not
    /// found). Any other error bubbles up to the caller, but the
    /// UI wires this as a fire-and-forget so callers can safely
    /// swallow the throw. Reason is capped to 200 chars in the UI.
    func flagCompAsWrong(cardId: String, compId: String, reason: String?) async throws -> Bool {
        struct FlagRequest: Encodable {
            let cardId: String
            let compId: String
            let reason: String?
        }
        struct FlagResponse: Decodable {
            let success: Bool?
            let status: String?
        }
        do {
            let response: FlagResponse = try await post(
                path: "/api/portfolioiq/comps/flag-wrong",
                body: FlagRequest(cardId: cardId, compId: compId, reason: reason),
                responseType: FlagResponse.self,
                timeoutSeconds: 15
            )
            if response.status == "not-found" { return false }
            return response.success ?? true
        } catch let APIServiceError.httpError(statusCode, _) where statusCode == 404 {
            return false
        }
    }

    /// 2026-07-15: dedicated Price History screen — long-window
    /// bucketed sales history for a single cardId. Backend returns
    /// pre-bucketed rows (weekly / monthly / quarterly) so iOS just
    /// plots them. Optional `minConfidence` filter isn't exposed on
    /// the UI yet; wire the param for future filtering surfaces.
    func fetchPriceHistory(
        cardId: String,
        window: String,
        bucket: String,
        minConfidence: Double? = nil
    ) async throws -> PriceHistoryResponse {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "window", value: window),
            URLQueryItem(name: "bucket", value: bucket)
        ]
        if let minConfidence {
            query.append(URLQueryItem(name: "minConfidence", value: String(minConfidence)))
        }
        let encoded = cardId
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? cardId
        return try await get(
            path: "/api/compiq/cards/\(encoded)/price-history",
            queryItems: query,
            responseType: PriceHistoryResponse.self,
            timeoutSeconds: 30
        )
    }

    /// PR #441 (2026-07-14): dry-run suggester used by the Verify Card
    /// sheet. iOS debounces field edits and re-hits this endpoint to
    /// get a fresh normalized-fields diff + best catalog match +
    /// alternatives. Never commits — that's what `confirmPendingHolding`
    /// does after the user hits Confirm with the picked cardId.
    func dryRunSuggest(_ request: DryRunSuggestRequest) async throws -> DryRunSuggestResponse {
        try await post(
            path: "/api/portfolio/holdings/dry-run-suggest",
            body: request,
            responseType: DryRunSuggestResponse.self,
            timeoutSeconds: 20
        )
    }

    /// Rejects a pending-review holding (auto-import misfire). Server
    /// deletes the holding and unlinks it from its source purchase.
    func rejectPendingHolding(id: String) async throws -> HoldingRejectResponse {
        try await post(
            path: "/api/portfolio/erp/holdings/\(id)/reject",
            body: EmptyBody(),
            responseType: HoldingRejectResponse.self
        )
    }

    /// CF-CARDID-SUGGEST (backend PR #389) + CF-PROGRESSIVE-BUCKETS
    /// (PR #393): kick a suggestion pass across pending-review
    /// holdings. `force=true` recomputes even rows that already have a
    /// suggestion — used when the user pulls to refresh the queue.
    /// Default `false` skips already-suggested rows for a fast pass.
    func generateHoldingSuggestions(force: Bool = false) async throws -> HoldingSuggestionGenerateResponse {
        try await post(
            path: "/api/portfolio/erp/holdings/generate-suggestions",
            body: HoldingSuggestionGenerateRequest(force: force),
            responseType: HoldingSuggestionGenerateResponse.self,
            timeoutSeconds: 60
        )
    }

    /// CF-RECONCILE-FINALIZE (backend PR #390): unconditional finalize for
    /// eBay entries stuck without fee data. Body carries a free-text
    /// `reason` (audit only) and optional `netPayout`. Backend flips
    /// both axes to finalized, zero-fills only null granular fees, and
    /// returns `entry.needsReconciliation: false` so the VM drops the
    /// row from the queue.
    func finalizeReconcileEntry(entryId: String, reason: String, netPayout: Double?) async throws -> ERPFinalizeResponse {
        let body = ERPFinalizeRequest(reason: reason, netPayout: netPayout)
        return try await post(
            path: "/api/portfolio/erp/unreconciled/\(entryId)/finalize",
            body: body,
            responseType: ERPFinalizeResponse.self
        )
    }

    // MARK: Scope 3.5 — Sold-Comps for card detail (backend PR #386)

    /// Filter-based sold-comps lookup for the card detail "Recent comps"
    /// section. Grade accepts either "PSA 10" or "PSA10". Every filter
    /// is optional; the backend narrows the population based on what's
    /// supplied, then returns median/count/stats.
    func fetchSoldComps(
        year: String? = nil,
        set: String? = nil,
        parallel: String? = nil,
        grade: String? = nil,
        playerName: String? = nil,
        cardNumber: String? = nil,
        isAuto: Bool? = nil,
        cardId: String? = nil,
        limit: Int? = nil
    ) async throws -> SoldCompsResponse {
        var items: [URLQueryItem] = []
        if let year { items.append(URLQueryItem(name: "year", value: year)) }
        if let set { items.append(URLQueryItem(name: "set", value: set)) }
        if let parallel { items.append(URLQueryItem(name: "parallel", value: parallel)) }
        if let grade { items.append(URLQueryItem(name: "grade", value: grade)) }
        if let playerName { items.append(URLQueryItem(name: "playerName", value: playerName)) }
        if let cardNumber { items.append(URLQueryItem(name: "cardNumber", value: cardNumber)) }
        if let isAuto { items.append(URLQueryItem(name: "isAuto", value: isAuto ? "true" : "false")) }
        if let cardId { items.append(URLQueryItem(name: "cardId", value: cardId)) }
        if let limit { items.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get(
            path: "/api/portfolio/sold-comps",
            queryItems: items,
            responseType: SoldCompsResponse.self
        )
    }

    // CF-IOS-EXPORT-BUILD (2026-06-21): holdings export.
    //
    // GET /api/portfolio/export?format=xlsx|csv — backend responds with
    // a BINARY xlsx or text/csv file, not JSON. Two response-shape facts
    // make this distinct from the surrounding ERP exports:
    //
    //   1. Body is raw file bytes, transport-only. iOS does NOT parse
    //      the contents — the file is written verbatim to a temp URL
    //      and handed off to UIActivityViewController.
    //   2. Custom response header `X-Holdings-Count: <int>` carries the
    //      row count and `Content-Disposition: attachment; filename="..."`
    //      carries the backend-chosen filename. Both are best-effort —
    //      missing values return nil and the caller falls back to a
    //      default filename.
    //
    // `sendData` at :1515 dropped HTTPURLResponse after the status check.
    // `sendDataWithResponse` below mirrors its flow but exposes the
    // response so the export call site can read these headers. The
    // existing `sendData` / `fetchData` signatures and their four callers
    // (:548, :563, :808, :1286) are untouched.
    func fetchExportFile(format: String = "xlsx") async throws -> HoldingsExportPayload {
        let (data, response) = try await sendDataWithResponse(
            path: "/api/portfolio/export",
            queryItems: [URLQueryItem(name: "format", value: format)],
            method: "GET",
            bodyData: nil
        )
        return HoldingsExportPayload(
            data: data,
            holdingsCount: HoldingsExportHeaderParser.parseHoldingsCount(
                from: response.value(forHTTPHeaderField: "X-Holdings-Count")
            ),
            suggestedFilename: HoldingsExportHeaderParser.parseFilename(
                fromContentDisposition: response.value(forHTTPHeaderField: "Content-Disposition")
            )
        )
    }

    // CF-IOS-IMPORT-BUILD (2026-06-21): holdings import — preview / poll / commit.
    //
    // POST /import/preview is JSON {file:<base64>, format} (NOT multipart).
    // Backend dispatches inline (≤40 rows) vs async (>40 rows) via the
    // `async:true` discriminator on the response — decoded by
    // PreviewResponseEnvelope into a Swift enum so the caller switches
    // on `.inline` vs `.asyncJob`.
    //
    // POST /import/commit is JSON; 402 carries the capacity-exceeded
    // payload as a DISTINCT branch (not a generic error) — callers must
    // route to PaywallView, not the generic .failed state.

    func importPreview(body: ImportPreviewRequest) async throws -> PreviewResponse {
        let envelope: PreviewResponseEnvelope = try await post(
            path: "/api/portfolio/import/preview",
            body: body,
            responseType: PreviewResponseEnvelope.self
        )
        return envelope.payload
    }

    func fetchImportJob(jobId: String) async throws -> ImportJobDoc {
        try await get(
            path: "/api/portfolio/import/jobs/\(jobId)",
            responseType: ImportJobDoc.self
        )
    }

    func importCommit(body: ImportCommitRequest) async throws -> ImportCommitResponse {
        try await post(
            path: "/api/portfolio/import/commit",
            body: body,
            responseType: ImportCommitResponse.self
        )
    }

    /// Header-aware variant of `sendData`. Returns the `(Data, HTTPURLResponse)`
    /// pair so callers can read custom response headers
    /// (`X-Holdings-Count`, `Content-Disposition`, etc.) that the JSON-
    /// decoding helpers throw away. Same status-validation + 401 hook as
    /// `sendData` so revoked sessions still surface globally.
    private func sendDataWithResponse(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String,
        bodyData: Data?,
        sessionId: String? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        let request = try makeRequest(path: path, queryItems: queryItems, method: method, bodyData: bodyData, sessionId: sessionId)
        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIServiceError.invalidResponse
            }
            guard 200..<300 ~= httpResponse.statusCode else {
                let rawResponse = String(data: data, encoding: .utf8) ?? ""
                notifySessionInvalidatedIfNeeded(statusCode: httpResponse.statusCode, url: request.url)
                throw APIServiceError.httpError(statusCode: httpResponse.statusCode, body: rawResponse)
            }
            return (data, httpResponse)
        } catch let error as APIServiceError {
            throw error
        } catch let urlError as URLError where urlError.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIServiceError.networkFailed(error)
        }
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

    /// CF-DAILYIQ-MARKET-PLAYERS (2026-07-01 / PR #235): matched-cohort
    /// momentum lists (trending / fading / most-traded / supply-squeeze).
    /// Investor-tier gated via `dailyIQBriefs`. Backend cache TTL 26h;
    /// iOS should NOT poll — one fetch per tab visit is sufficient.
    /// Empty payload (generatedAt == nil) is expected before the
    /// backend job populates; do NOT retry aggressively.
    func fetchMarketSignals() async throws -> DailyIQMarketSignalsResponse {
        try await get(path: "/api/dailyiq/market/players", responseType: DailyIQMarketSignalsResponse.self)
    }

    /// CF-DAILYIQ-MY-PLAYERS (2026-07-01): personal cohort momentum —
    /// one entry per player the user has holdings for, pre-sorted
    /// DESC by holdingCount. Same Investor-tier gate + no-polling
    /// contract as `fetchMarketSignals`. First-day production reality:
    /// most `matchedCohort` values return nil until the background job
    /// cycles reach the user's players (~4-24h).
    func fetchMyPlayersMarket() async throws -> DailyIQMyPlayersResponse {
        try await get(path: "/api/dailyiq/market/my-players", responseType: DailyIQMyPlayersResponse.self)
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
        // Azure App Service cold-start on /api/portfolio routinely exceeds the
        // default 10s budget, surfacing as URLError.cancelled (-999) and the
        // "Live holdings unavailable" banner. 30s mirrors the cardsearch /
        // price-by-id headroom and is the longest single-request override.
        let envelope: PortfolioIQHoldingsEnvelope = try await get(
            path: "/api/portfolio",
            queryItems: portfolioUserQueryItems(userId: userId),
            responseType: PortfolioIQHoldingsEnvelope.self,
            timeoutSeconds: 30
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
        date: Date,
        notes: String? = nil,
        salesChannel: String? = nil,
        channelNote: String? = nil,
        paymentMethod: String? = nil,
        paymentNote: String? = nil,
        saleLocation: PortfolioIQSaleLocation? = nil
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
                notes: notes,
                salesChannel: salesChannel,
                channelNote: channelNote,
                paymentMethod: paymentMethod,
                paymentNote: paymentNote,
                saleLocation: (saleLocation?.isEmpty ?? true) ? nil : saleLocation
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
        // PR #425 aftermath (2026-07-14): the edit-save PATCH now
        // threads every backend-owned field back through the body so
        // the local cache doesn't lose fmv / heldExpenses / ebay*
        // fields after an edit. Backend can trigger autoPriceHolding
        // + a Cardsight rescue on the round-trip, which pushes the
        // response past the default 15s URLRequest timeout. Matches
        // the 30s ceiling other write endpoints already use.
        try await patch(
            path: "/api/portfolio/holdings/\(card.id.uuidString)",
            body: card,
            responseType: PortfolioIQActionResponse.self,
            timeoutSeconds: 30
        )
    }

    /// CF-CERT-ADD-TO-INVENTORY (2026-07-06): compose the two
    /// backend endpoints into a "user typed a cert → holding
    /// created" flow. This method fires step 2 (the create) after
    /// the caller has previewed step 1 (`/lookup-by-cert`).
    /// Response = 201 Created with `{ message, id }` — decoded by
    /// the existing `PortfolioIQActionResponse` shape.
    func addHoldingByCert(_ request: AddHoldingByCertRequest) async throws -> PortfolioIQActionResponse {
        try await post(
            path: "/api/portfolio/holdings",
            body: request,
            responseType: PortfolioIQActionResponse.self,
            timeoutSeconds: 30
        )
    }

    /// CF-HOLDING-REGRADE (2026-07-06, backend PR #294): atomic
    /// four-field commit for raw → graded conversion. Backend
    /// atomically updates grade + cert + rolls `gradingCost` into
    /// `totalCostBasis` and re-fires `autoPriceHolding` for the new
    /// grade. Returns the fresh holding wire shape with a recomputed
    /// `actionRecommendation`.
    ///
    /// Semantics per the backend spec:
    ///   certNumber:
    ///     - trimmed non-empty String → set / update
    ///     - nil                       → leave existing cert alone
    ///     - explicit JSON null        → clear (rare "wrong cert" flow;
    ///                                    not exposed on iOS yet)
    ///   gradingCost:
    ///     - positive Double           → roll into cost basis
    ///     - nil or 0                  → grade-only update, cost basis
    ///                                    unchanged
    func regradeHolding(
        holdingId: UUID,
        gradeCompany: String,
        gradeValue: Double,
        certNumber: String? = nil,
        gradingCost: Double? = nil,
        gradingTierId: String? = nil
    ) async throws -> RegradeResponse {
        let trimmedCert: String? = {
            guard let raw = certNumber?.trimmingCharacters(in: .whitespacesAndNewlines),
                  raw.isEmpty == false else { return nil }
            return raw
        }()
        let normalizedCost: Double? = {
            guard let g = gradingCost, g > 0, g.isFinite else { return nil }
            return g
        }()
        let normalizedTierId: String? = {
            guard let raw = gradingTierId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  raw.isEmpty == false else { return nil }
            return raw
        }()
        let body = RegradeRequest(
            gradeCompany: gradeCompany,
            gradeValue: gradeValue,
            certNumber: trimmedCert,
            gradingCost: normalizedCost,
            gradingTierId: normalizedTierId
        )
        return try await post(
            path: "/api/portfolio/holdings/\(holdingId.uuidString)/regrade",
            body: body,
            responseType: RegradeResponse.self,
            timeoutSeconds: 30
        )
    }

    /// CF-GRADING-TIERS (2026-07-06, backend PR #300): reference-data
    /// read for the Mark-as-Graded tier dropdown. No rate limit; catalog
    /// changes only on backend redeploys. Cache in `GradingTierCatalog`
    /// for the session and refresh on cold start.
    func fetchGradingTiers() async throws -> GradingTierCatalogResponse {
        return try await get(
            path: "/api/portfolio/grading-tiers",
            queryItems: [],
            responseType: GradingTierCatalogResponse.self,
            timeoutSeconds: 20
        )
    }

    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): narrow PATCH that mutates only
    /// the grader-status bucket. Backend PATCH /api/portfolio/holdings/:id
    /// accepts arbitrary fields via `...rest` spread, so a single-field
    /// body lands without touching the rest of the holding doc.
    func updateHoldingGraderStatus(holdingId: UUID, status: GraderStatus) async throws -> PortfolioIQActionResponse {
        let body = GraderStatusUpdateRequest(graderStatus: status.rawValue)
        return try await patch(
            path: "/api/portfolio/holdings/\(holdingId.uuidString)",
            body: body,
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

    // MARK: - Portfolio Preferences (P0.7 delta, backend PR #500 + #501)

    /// P0.7 delta (2026-07-16, backend PR #501): GET the user's portfolio-
    /// preferences doc. Feeds the Settings toggle initial state + the APNs
    /// registration-status caption. Best-effort: 401 during a stale-deploy
    /// window must NOT sign the user out (path added to bestEffortPaths).
    func fetchPortfolioPreferences() async throws -> PortfolioPreferencesResponse {
        try await get(path: "/api/portfolio/preferences", responseType: PortfolioPreferencesResponse.self)
    }

    /// P0.7 delta (2026-07-16): PATCH just the `pushOnMajorFlip` field.
    /// Sends only that key so a concurrent APNs-token update doesn't
    /// stomp on the toggle state.
    func updatePortfolioFlipPreference(pushOnMajorFlip: Bool) async throws -> PortfolioPreferencesResponse {
        let body = PortfolioFlipPreferenceUpdate(pushOnMajorFlip: pushOnMajorFlip)
        return try await patch(
            path: "/api/portfolio/preferences",
            body: body,
            responseType: PortfolioPreferencesResponse.self
        )
    }

    /// Phase 3.9 (2026-07-17, PR #531): PATCH the `pushOnCascade` field
    /// alone. Cascade default is OFF — this is an explicit opt-in.
    func updatePortfolioCascadePreference(pushOnCascade: Bool) async throws -> PortfolioPreferencesResponse {
        let body = PortfolioCascadePreferenceUpdate(pushOnCascade: pushOnCascade)
        return try await patch(
            path: "/api/portfolio/preferences",
            body: body,
            responseType: PortfolioPreferencesResponse.self
        )
    }

    /// P0.7 delta (2026-07-16): PATCH the `apnsDeviceToken` field with the
    /// current hex token. Backend stamps `apnsDevice.registeredAt`.
    /// Called after APNs registration succeeds AND when the cached token
    /// diverges from the last-registered one.
    func registerAPNsToken(_ token: String) async throws -> PortfolioPreferencesResponse {
        let body = PortfolioAPNsTokenUpdate(token: token)
        return try await patch(
            path: "/api/portfolio/preferences",
            body: body,
            responseType: PortfolioPreferencesResponse.self
        )
    }

    /// P0.7 delta (2026-07-16): PATCH `apnsDeviceToken: null` to un-register.
    /// Fires on iOS-side permission revoke and on sign-out so the backend
    /// stops targeting a stale token in the fan-out worker. The explicit
    /// `encodeNil` (vs. `encodeIfPresent`) is required — omitting the key
    /// would leave the token untouched.
    func unregisterAPNsToken() async throws -> PortfolioPreferencesResponse {
        let body = PortfolioAPNsTokenUpdate.clear
        return try await patch(
            path: "/api/portfolio/preferences",
            body: body,
            responseType: PortfolioPreferencesResponse.self
        )
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

    private func get<Response: Decodable>(path: String, queryItems: [URLQueryItem] = [], responseType: Response.Type, sessionId: String? = nil, timeoutSeconds: TimeInterval? = nil) async throws -> Response {
        let request = try makeRequest(path: path, queryItems: queryItems, method: "GET", bodyData: nil, sessionId: sessionId, timeoutSeconds: timeoutSeconds)
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
        sessionId: String? = nil,
        timeoutSeconds: TimeInterval? = nil
    ) async throws -> Response {
        let bodyData = try encoder.encode(body)
        #if DEBUG
        if let bodyText = String(data: bodyData, encoding: .utf8) {
            print("Request Body:", bodyText)
        }
        #endif
        let request = try makeRequest(path: path, queryItems: queryItems, method: "PATCH", bodyData: bodyData, sessionId: sessionId, timeoutSeconds: timeoutSeconds)
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
        } catch let urlError as URLError where urlError.code == .cancelled {
            throw CancellationError()
        } catch is CancellationError {
            throw CancellationError()
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

    /// CF-SELL-TRACKING (2026-07-11): extracts a user-friendly reason
    /// from a 400 Bad Request without the noisy "The server returned
    /// status 400." prefix `errorMessage(from:)` produces. Returns nil
    /// when the error isn't a 400 or the body carries no readable
    /// message — caller should then fall back to the generic path.
    static func validationErrorMessage(from error: Error) -> String? {
        guard case let APIServiceError.httpError(statusCode, body) = error, statusCode == 400 else {
            return nil
        }
        let message = APIService.backendMessage(from: body).trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? nil : message
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

    /// PR #425 (2026-07-13): best-effort discovery/aggregate endpoints.
    /// These fire on tab appearance and every pull-to-refresh; a 401
    /// (backend not yet deployed, permission gap, or a transient
    /// gateway hiccup) MUST NOT log the user out. Callers already
    /// treat any error as "hide the card" — the notification bypass
    /// keeps that contract honest.
    private static let bestEffortPaths: Set<String> = [
        "/api/portfolio/supply-demand-summary",
        "/api/portfolio/signal-weighted-totals",
        "/api/portfolio/watchlist-bull-candidates",
        // P0.7 (2026-07-16): verdict-flip inventory dot fires on every
        // portfolio open — a stale-deploy 401 must not sign the user out.
        "/api/compiq/portfolio/flips",
        // P0.7 delta (2026-07-16, backend PR #501): preferences GET/PATCH
        // fires on Settings load + APNs registration. Same reasoning —
        // transient 401 during a deploy gap must not evict the session.
        "/api/portfolio/preferences",
        // Corpus signals (2026-07-17, PR #518): grade-worthy scan fires
        // on portfolio open. Same reasoning.
        "/api/portfolio/grade-worthy-alerts",
        // Phase 2-4 (2026-07-17): portfolio-momentum + cascade + hot +
        // social all fire on portfolio / dailyiq open. Same reasoning.
        "/api/portfolio/momentum",
        "/api/portfolio/cascade-alerts",
        "/api/portfolio/i-called-it",
        "/api/dailyiq/hot-right-now",
        // Corpus signals batch 2 (2026-07-17, PR #538/#539/#531):
        // attribution health + sell-radar + notable sales + sub-raw +
        // missing-parallels — all fire on tab-open. Same reasoning.
        "/api/portfolio/attribution-health",
        "/api/portfolio/sell-now-radar",
        "/api/portfolio/notable-sales",
        "/api/portfolio/sub-raw-discovery",
        "/api/portfolio/missing-parallels",
        // PR #546 (2026-07-17): action-plan feed for DailyIQ hero.
        // Same reasoning — transient 401 must not evict the session.
        "/api/dailyiq/action-plan"
    ]

    /// P0.7 (2026-07-16): variable-segment best-effort paths (e.g. the
    /// per-player verdict-history route has an inline `:player` slug).
    /// Matched by `hasPrefix` in `notifySessionInvalidatedIfNeeded`.
    private static let bestEffortPathPrefixes: [String] = [
        "/api/compiq/players/",
        // Corpus signals (2026-07-17): per-player trend + per-family
        // multipliers fan out on portfolio open. A transient 401 must
        // never evict the session.
        "/api/portfolio/player-trend/",
        "/api/portfolio/family-multipliers/",
        // Phase 3-4 (2026-07-17): yearbook parameterized by year.
        // Session-safe read.
        "/api/portfolio/yearbook",
        // Corpus signals batch 2 (2026-07-17, PR #538/#531): parallel-
        // ladder + missing-parallels-by-bucket have variable
        // :playerYearSet keys.
        "/api/portfolio/parallel-ladder/",
        "/api/portfolio/missing-parallels/"
    ]

    /// Corpus signals (2026-07-17): the grade-analysis route sits under
    /// `/api/portfolio/holdings/{id}/…` but the parent slug is also used
    /// for user-facing PATCH updates that MUST sign out on 401. So we
    /// suffix-match this variable-`{id}` case instead of prefix-matching
    /// the whole /holdings/ namespace.
    private static let bestEffortPathSuffixes: [String] = [
        "/grade-analysis",
        // PR #544 (2026-07-17): eBay active listings fetch on the card
        // detail page. Section hides on any error, and iOS shouldn't
        // sign out during a stale-deploy window.
        "/active-listings"
    ]

    private func notifySessionInvalidatedIfNeeded(statusCode: Int, url: URL?) {
        guard statusCode == 401 else { return }
        let path = url?.path ?? ""
        guard Self.authFlowPaths.contains(path) == false else { return }
        guard Self.bestEffortPaths.contains(path) == false else { return }
        guard Self.bestEffortPathPrefixes.contains(where: path.hasPrefix) == false else { return }
        guard Self.bestEffortPathSuffixes.contains(where: path.hasSuffix) == false else { return }
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

/// CF-ALIAS-LEARNING (2026-07-09): telemetry body for POST
/// /api/compiq/log-selection. Feeds the nightly
/// `promote-learned-aliases` job that grows the alias corpus from
/// real user selections.
struct CompIQLogSelectionRequest: Encodable {
    /// Raw query the user typed, lowercased + trimmed. Send it
    /// verbatim beyond that — the backend expects the raw shape so
    /// alias matching survives punctuation quirks.
    let queryNormalized: String
    /// The cardId of whichever result the user picked (e.g.
    /// `"cardsight:1778542173652x303328120692600800"`).
    let cardId: String
    /// Optional — populated when the surface has the player-name
    /// separately (search dropdown items usually do).
    let playerName: String?
    /// Origin surface. Known values: `"search-dropdown"`,
    /// `"search-results"`, `"typeahead"`. Free-form so new surfaces
    /// can enrich the corpus without a backend deploy.
    let source: String
}

/// Minimal response shape. iOS never consults the body; the endpoint
/// is fire-and-forget.
struct CompIQLogSelectionResponse: Decodable {
    let success: Bool?
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
    // CF-REGIME-RECONCILED (2026-07-09, backend PR #333): when a regime
    // was passed into the projection call, the backend floors/ceilings
    // the predicted price against the regime classifier's read. All
    // three fields are optional — legacy responses (or responses where
    // no regime was supplied) omit them entirely.
    //
    // Direction icons app-wide MUST read `regime` for the arrow (up /
    // down / flat) rather than diffing marketValue vs lastSale — the
    // regime is the reconciled authority now.
    //
    // NOTE: `regime` / `regimeReconciled` / `regimeReconcileReason` are
    // also nil on the product-family-projection path (see below) —
    // that path bypasses the live pricing engine that produces regime.
    let regime: String?
    let regimeReconciled: Bool?
    let regimeReconcileReason: String?
    // CF-PRODUCT-FAMILY-PROJECTION (2026-07-09): fires when a card's
    // product line isn't yet indexed by CardHedge (launch case: 2026
    // Bowman Sapphire before CH ingests it). Engine anchors off the
    // equivalent parent product's live comps × family multiplier ×
    // parallel floor. Populated ONLY when
    // `mechanism == "product-family-projection"`. `forwardProjectionFactor`,
    // `trendIQ*` fields are all nil on this path — never force-unwrap
    // them assuming a specific mechanism.
    let familyName: String?
    let parentProduct: String?
    let familyMultiplier: Double?
    let parallelMultiplier: Double?
    let parentBaseMedian: Double?
    let parentComps: Int?
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
    let cardId: String
    let parallel: String?
    let parallelId: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Double?
    let purchasePrice: Double?
    let quantity: Int
    /// CF-IOS-GRADER-STATUS-UI (2026-06-28): grader-status bucket raw value
    /// ("at_psa" / "pending_redemption"). Nil for the .available default
    /// keeps the wire body minimal — backend defaults missing field to
    /// available on persist.
    let graderStatus: String?
    /// CF-IOS-HOLDING-METADATA-CAPTURE (2026-06-25): structured card-
    /// identity fields captured at add-time so the holding renders as
    /// "{Year} · {Set}" subtitle + real player title instead of a raw
    /// UUID. Sourced (in priority order) from
    /// CompIQPriceByIdResponse.cardIdentity, then CompIQVariantHit
    /// fields. Backend persists these onto the holding record and
    /// returns them in the auto-priced response. All three are
    /// optional — older clients omit them and the backend treats the
    /// fields as nil (no behavior change for legacy callers).
    let year: String?
    let setName: String?
    let cardNumber: String?
    /// Composed display title (e.g. "2026 Bowman Baseball Eric Hartman
    /// CPA-EHA Speckle Refractor"). Without this the holding's `cardName`
    /// persists as empty and the inventory hero subtitle / mark-sold sheet
    /// / edit form render with a blank Card Title.
    let cardTitle: String?
}

/// CF-IOS-GRADER-STATUS-UI (2026-06-28): single-field PATCH body for the
/// detail-view Status dropdown. Backend spreads body fields into the
/// holding doc, so a one-field body mutates only `graderStatus`.
struct GraderStatusUpdateRequest: Encodable {
    let graderStatus: String
}

/// CF-HOLDING-REGRADE (2026-07-06, backend PR #294 + #300).
/// Only encodes non-nil fields — backend spec: absent `certNumber`
/// means "don't touch"; absent `gradingCost` means "grade-only";
/// absent `gradingTierId` means "manual cost / no tier".
struct RegradeRequest: Encodable {
    let gradeCompany: String
    let gradeValue: Double
    let certNumber: String?
    let gradingCost: Double?
    let gradingTierId: String?

    private enum CodingKeys: String, CodingKey {
        case gradeCompany, gradeValue, certNumber, gradingCost, gradingTierId
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(gradeCompany, forKey: .gradeCompany)
        try c.encode(gradeValue, forKey: .gradeValue)
        try c.encodeIfPresent(certNumber, forKey: .certNumber)
        try c.encodeIfPresent(gradingCost, forKey: .gradingCost)
        try c.encodeIfPresent(gradingTierId, forKey: .gradingTierId)
    }
}

struct RegradeResponse: Decodable {
    let message: String?
    let id: String?
    /// Legacy field — still on the wire pre-PR #395.
    let updatedHolding: InventoryCard?
    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395): universal
    /// `holding` + `entry.holding` cover for new callers. Prefer
    /// `resolvedHolding` which cascades through all three keys.
    let holding: InventoryCard?
    let entry: HoldingMutationEntry?

    var resolvedHolding: InventoryCard? {
        entry?.holding ?? holding ?? updatedHolding
    }
}

// MARK: - Grading Tier Catalog (backend PR #300, 2026-07-06)

/// CF-GRADING-TIERS: GET /api/portfolio/grading-tiers wire shape.
/// `pricePerCard: nil` = variable-price tier (Premium 2+); user MUST
/// enter a gradingCost manually. `active: false` = paused for new
/// submissions, but kept in the catalog so historical entries can log
/// accurately.
struct GradingTier: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    let grader: String
    let name: String
    let pricePerCard: Double?
    let maxDeclaredValue: Int?
    let turnaround: String
    let active: Bool
    let note: String?
}

struct GradingTierCatalogResponse: Decodable {
    let success: Bool
    let tiers: [GradingTier]
    let cachedUntil: String
}

/// CF-CERT-ADD-TO-INVENTORY (2026-07-06): body shape for
/// POST /api/portfolio/holdings when the caller composed the holding
/// from a `/lookup-by-cert` response. Uses the canonical wire field
/// names the backend expects (`cardTitle`, `cardYear`, `product`,
/// `purchaseSource`, `totalCostBasis`, `certGrader`, `certNumber`)
/// so the field-spread ingest path lands them without going through
/// InventoryCard's local aliases.
struct AddHoldingByCertRequest: Encodable {
    let id: String
    let cardId: String
    let playerName: String
    let cardYear: Int?
    let product: String
    let cardTitle: String
    let cardNumber: String?
    let parallel: String?
    let gradeCompany: String
    let gradeValue: Double
    let certNumber: String
    let certGrader: String
    let quantity: Double
    let purchasePrice: Double
    let totalCostBasis: Double
    let purchaseDate: String
    let purchaseSource: String?
    let notes: String?

    private enum CodingKeys: String, CodingKey {
        case id, cardId, playerName, cardYear, product, cardTitle, cardNumber
        case parallel, gradeCompany, gradeValue, certNumber, certGrader
        case quantity, purchasePrice, totalCostBasis, purchaseDate
        case purchaseSource, notes
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(cardId, forKey: .cardId)
        try c.encode(playerName, forKey: .playerName)
        try c.encodeIfPresent(cardYear, forKey: .cardYear)
        try c.encode(product, forKey: .product)
        try c.encode(cardTitle, forKey: .cardTitle)
        try c.encodeIfPresent(cardNumber, forKey: .cardNumber)
        try c.encodeIfPresent(parallel, forKey: .parallel)
        try c.encode(gradeCompany, forKey: .gradeCompany)
        try c.encode(gradeValue, forKey: .gradeValue)
        try c.encode(certNumber, forKey: .certNumber)
        try c.encode(certGrader, forKey: .certGrader)
        try c.encode(quantity, forKey: .quantity)
        try c.encode(purchasePrice, forKey: .purchasePrice)
        try c.encode(totalCostBasis, forKey: .totalCostBasis)
        try c.encode(purchaseDate, forKey: .purchaseDate)
        try c.encodeIfPresent(purchaseSource, forKey: .purchaseSource)
        try c.encodeIfPresent(notes, forKey: .notes)
    }
}

/// CF-ADD-TO-INVENTORY (2026-06-12): backend returns 201 with the
/// auto-priced holding inline so the iOS sheet can confirm with the
/// real valuation in hand (no double-fetch).
struct AddHoldingResponse: Decodable {
    let holding: InventoryCard?
    let success: Bool?
}

// MARK: - CF-COMPIQ-SCAN-ROUTE (2026-06-30) — /api/compiq/scan wire models

/// Request body for POST /api/compiq/scan. One of `imageUrl` /
/// `imageBase64` is required. `hint` steers backend routing:
/// `"raw"` (image-match only), `"graded"` (cert-OCR only), or
/// `"auto"` (default; cert-OCR first, image-match fallback).
struct CompIQScanRequest: Encodable {
    let imageUrl: String?
    let imageBase64: String?
    let hint: String
}

/// Response envelope for /api/compiq/scan. Every field is Optional
/// because backend emits sparse shapes: `cardId == nil` when nothing
/// matched, `certInfo == nil` when `matchPath != "cert-ocr"`. iOS
/// callers should branch on `cardId` first, then bucket the
/// `matchConfidence` against 0.7 / 0.5 thresholds for UI messaging.
struct CompIQScanResponse: Decodable {
    let success: Bool?
    let cardId: String?
    let player: String?
    let set: String?
    let number: String?
    let variant: String?
    /// `"cert-ocr"` when the slab-label OCR path resolved the card,
    /// `"image-match"` when the CV matcher resolved it, `nil` when
    /// neither path returned a match.
    let matchPath: String?
    /// 0.0–1.0. Below 0.7 warrants a disambiguation nudge; below 0.5
    /// should be treated as an unmatched result.
    let matchConfidence: Double?
    /// Populated only when `matchPath == "cert-ocr"`. Pre-fill the
    /// add-holding form's grader / grade / cert-number fields.
    let certInfo: CompIQScanCertInfo?
}

struct CompIQScanCertInfo: Decodable, Hashable {
    let certNumber: String?
    let grader: String?
    let grade: String?
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

/// CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388) + CF-PROGRESSIVE-BUCKETS
/// (PR #393): `GET /api/portfolio/holdings/pending-review` canonical
/// shape is `{ userId, count, holdings: [] }`. Historically iOS saw
/// bare arrays and `{items|pending: [...]}` variants too — this
/// decoder still accepts them defensively so a wire-shape drift
/// doesn't break the queue.
struct PendingReviewEnvelope: Decodable {
    let holdings: [InventoryCard]

    private enum CodingKeys: String, CodingKey {
        case holdings, items, pending, count, userId
    }

    init(from decoder: Decoder) throws {
        // Try raw array first (legacy shape).
        if let single = try? decoder.singleValueContainer(),
           let bare = try? single.decode([InventoryCard].self) {
            self.holdings = bare
            return
        }
        // Preferred envelope keys.
        if let container = try? decoder.container(keyedBy: CodingKeys.self) {
            if let holdings = try? container.decode([InventoryCard].self, forKey: .holdings) {
                self.holdings = holdings
                return
            }
            if let items = try? container.decode([InventoryCard].self, forKey: .items) {
                self.holdings = items
                return
            }
            if let pending = try? container.decode([InventoryCard].self, forKey: .pending) {
                self.holdings = pending
                return
            }
        }
        self.holdings = []
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
    /// CF-SELL-TRACKING (2026-07-11): closed-enum sales channel accepted
    /// by `parseSalesTrackingFields` (portfolioStore.service.ts:693).
    /// `salesChannel == "other"` REQUIRES a non-empty `channelNote`.
    let salesChannel: String?
    let channelNote: String?
    let paymentMethod: String?
    let paymentNote: String?
    let saleLocation: PortfolioIQSaleLocation?
}

/// CF-SELL-TRACKING (2026-07-11): structured location on a sale.
/// Backend interface at portfolioStore.service.ts:602 —
/// `venue` ≤80 chars, `city` ≤60 chars, `state` is US 2-letter uppercase.
/// Any subset may be present; all-nil means no location tag.
struct PortfolioIQSaleLocation: Codable, Hashable {
    let venue: String?
    let city: String?
    let state: String?

    var isEmpty: Bool {
        (venue?.isEmpty ?? true) && (city?.isEmpty ?? true) && (state?.isEmpty ?? true)
    }
}

/// CF-EBAY-PUBLISH-400-FIX (2026-06-17): wire shape matches backend's
/// `HoldingListingInput` (ebayListing.service.ts:26-66). Pre-fix iOS sent
/// `cardId`/`askingPrice`/`cardName`/`year: String` — route validation at
/// `ebay.routes.ts:166` truthiness-checks `holdingId`/`playerName`/
/// `listingPrice` and rejected the payload as 400. Renames + retypes
/// applied here; legacy unused fields (`title`, `ebayUser`,
/// `purchase*`, `condition`, `listingFormat`, `auctionStartDate`) dropped
/// because the backend never reads them (`buildTitle` recomposes from
/// structured fields; session auth identifies the user).
struct PortfolioEbayListingRequest: Codable {
    // Required by HoldingListingInput + the route validator
    let holdingId: String
    let playerName: String
    let cardTitle: String
    let cardYear: Int
    let brand: String
    let setName: String
    let product: String
    let isAuto: Bool
    let isPatch: Bool
    let isRookie: Bool
    let quantity: Int
    let listingPrice: Double
    let bestOfferEnabled: Bool

    // Optional structured fields — passed through when set
    let sport: String?
    let cardNumber: String?
    let parallel: String?
    let serialNumber: String?
    let printRun: Int?
    let variation: String?
    let grade: String?
    let gradingCompany: String?
    let certNumber: String?
    let conditionNotes: String?
    let conditionEstimate: String?
    let bestOfferMinPrice: Double?
    let imageFrontUrl: String?
    let imageBackUrl: String?
    let description: String?

    // Optional seller-side overrides
    let categoryId: String?
    let paymentPolicyId: String?
    let returnPolicyId: String?
    let fulfillmentPolicyId: String?

    init(
        holdingId: String,
        playerName: String,
        cardTitle: String,
        cardYear: Int,
        brand: String,
        setName: String,
        product: String,
        isAuto: Bool = false,
        isPatch: Bool = false,
        isRookie: Bool = false,
        quantity: Int,
        listingPrice: Double,
        bestOfferEnabled: Bool = false,
        sport: String? = nil,
        cardNumber: String? = nil,
        parallel: String? = nil,
        serialNumber: String? = nil,
        printRun: Int? = nil,
        variation: String? = nil,
        grade: String? = nil,
        gradingCompany: String? = nil,
        certNumber: String? = nil,
        conditionNotes: String? = nil,
        conditionEstimate: String? = nil,
        bestOfferMinPrice: Double? = nil,
        imageFrontUrl: String? = nil,
        imageBackUrl: String? = nil,
        description: String? = nil,
        categoryId: String? = nil,
        paymentPolicyId: String? = nil,
        returnPolicyId: String? = nil,
        fulfillmentPolicyId: String? = nil
    ) {
        self.holdingId = holdingId
        self.playerName = playerName
        self.cardTitle = cardTitle
        self.cardYear = cardYear
        self.brand = brand
        self.setName = setName
        self.product = product
        self.isAuto = isAuto
        self.isPatch = isPatch
        self.isRookie = isRookie
        self.quantity = quantity
        self.listingPrice = listingPrice
        self.bestOfferEnabled = bestOfferEnabled
        self.sport = sport
        self.cardNumber = cardNumber
        self.parallel = parallel
        self.serialNumber = serialNumber
        self.printRun = printRun
        self.variation = variation
        self.grade = grade
        self.gradingCompany = gradingCompany
        self.certNumber = certNumber
        self.conditionNotes = conditionNotes
        self.conditionEstimate = conditionEstimate
        self.bestOfferMinPrice = bestOfferMinPrice
        self.imageFrontUrl = imageFrontUrl
        self.imageBackUrl = imageBackUrl
        self.description = description
        self.categoryId = categoryId
        self.paymentPolicyId = paymentPolicyId
        self.returnPolicyId = returnPolicyId
        self.fulfillmentPolicyId = fulfillmentPolicyId
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
    /// CF-UNIVERSAL-MUTATION-ENVELOPE (backend PR #395): every write
    /// route (PATCH, /sell, /regrade, /refresh) also stamps the
    /// persisted holding under `entry.holding`, plus sell-specific
    /// fields when the row was fully or partially sold.
    let entry: HoldingMutationEntry?
    let holdingRemoved: Bool?
    let remainingQuantity: Int?
    let sold: PortfolioLedgerEntry?

    /// Freshest holding representation: `entry.holding` beats top-level
    /// `holding`. Nil when the full quantity was sold (`holdingRemoved`).
    var updatedHolding: InventoryCard? {
        entry?.holding ?? holding
    }
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

// MARK: - Portfolio Preferences (P0.7 delta, backend PR #500 + #501)

/// GET /api/portfolio/preferences response envelope. The two fields iOS
/// consumes are `pushOnMajorFlip` (drives the Settings toggle) and
/// `apnsDevice.{ registered, registeredAt }` (drives the caption below the
/// toggle). Every field decodes defensively — a shape drift degrades to
/// "unknown" state rather than a crash.
struct PortfolioPreferencesResponse: Decodable {
    let success: Bool?
    let preferences: Preferences?

    struct Preferences: Decodable {
        let pushOnMajorFlip: Bool?
        /// Phase 3.9 (2026-07-17, PR #531): cascade signal push opt-in.
        /// Defaults false on the backend — user explicitly opts in.
        let pushOnCascade: Bool?
        /// Phase 3.9 alt shape: backend PR #531 returns
        /// `deviceTokenRegistered: bool` alongside the older
        /// `apnsDevice.registered/registeredAt`. Decode both defensively.
        let deviceTokenRegistered: Bool?
        let apnsDevice: APNsDeviceStatus?
    }

    struct APNsDeviceStatus: Decodable, Hashable {
        let registered: Bool?
        /// ISO timestamp when the current token was last written. Nil when
        /// no token is on file (fresh account, un-registered, or cleared).
        let registeredAt: String?
    }
}

/// PATCH /api/portfolio/preferences body — flip-preference update.
/// One field, sent alone so a concurrent APNs-token update on another
/// device doesn't race with the toggle write.
struct PortfolioFlipPreferenceUpdate: Encodable {
    let pushOnMajorFlip: Bool
}

/// Phase 3.9 (2026-07-17, PR #531): cascade-preference PATCH body. Same
/// singularity rule — one field per request keeps concurrent updates
/// from stomping each other.
struct PortfolioCascadePreferenceUpdate: Encodable {
    let pushOnCascade: Bool
}

/// PATCH /api/portfolio/preferences body — APNs token update. When the
/// token is set (`token` non-nil), we send `apnsDeviceToken: <hex>`.
/// When clearing on revoke/logout, `.clear` sends explicit `null` via
/// `encodeNil` — `encodeIfPresent` would silently drop the key and
/// leave the stale token on the server.
struct PortfolioAPNsTokenUpdate: Encodable {
    let token: String?

    static let clear = PortfolioAPNsTokenUpdate(token: nil)

    enum CodingKeys: String, CodingKey {
        case apnsDeviceToken
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let token {
            try container.encode(token, forKey: .apnsDeviceToken)
        } else {
            try container.encodeNil(forKey: .apnsDeviceToken)
        }
    }
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
