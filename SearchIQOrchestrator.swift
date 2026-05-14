// SearchIQOrchestrator.swift
// Unified search brain. Classifies a natural-language query through the MCP
// /api/search-intent endpoint, then fans out in parallel to the relevant IQ
// modules based on the returned intents.
//
// Public surface:
//   @MainActor final class SearchIQOrchestrator: ObservableObject
//     - @Published var result: SearchResult?
//     - @Published var isLoading: Bool
//     - @Published var lastError: String?
//     - func search(_ query: String) async
//
// Rules followed (per PART 2 Step 2 spec):
// 1. POSTs to {MCP_BASE_URL}/api/search-intent first.
// 2. Fans out in parallel via `async let` only for intents returned.
// 3. Each module is wrapped with a 3 s timeout — slow modules return nil
//    rather than blocking the SearchResult.
// 4. New searches set isLoading=true but DO NOT wipe the existing result.
//    Result is replaced atomically once the new payload is assembled.

import Foundation
import SwiftData

// MARK: - Public Models

struct SearchIntent: Codable, Equatable {
    let intents: [String]
    let playerName: String?
    let year: Int?
    let setName: String?
    let cardNumber: String?
    let variant: String?
    let grade: String?
    let isGradingQuestion: Bool
    let isOwnedCard: Bool
    let confidence: Double
}

struct SearchPriceModule: Equatable {
    let predicted72h: Double?
    let predicted7d: Double?
    let direction: String?
    let confidence: Int?
    let keyDrivers: [String]
    let riskFlags: [String]
    let bestTimeToSell: String?
}

struct SearchStatsModule: Equatable {
    let playerName: String
    let last10Games: [StatLine]
    struct StatLine: Equatable {
        let date: String
        let summary: String
        let avg: Double?
    }
}

struct SearchInventoryModule: Equatable {
    struct Match: Equatable, Identifiable {
        let id: String
        let title: String
        let year: Int?
        let setName: String?
        let cardNumber: String?
        let imageURL: String?
        let costBasis: Double?
    }
    let matches: [Match]
}

struct SearchGradeModule: Equatable {
    let rawPrice: Double?
    let psa10Price: Double?
    let psa9Price: Double?
    let upliftPct: Double?
    let recommendation: String   // "grade" | "hold" | "sell-raw" | "unknown"
    let reasoning: String
}

struct SearchCatalogModule: Equatable {
    struct Hit: Equatable, Identifiable {
        let id: String
        let title: String
        let imageURL: String?
        let setName: String?
        let year: Int?
        let cardNumber: String?
    }
    let hits: [Hit]
}

/// PlayerIQ blended score (60% market + 40% performance) served by the
/// /api/playeriq/{playerName} backend endpoint. All fields are optional so
/// SearchIQ degrades gracefully when the backend hasn't seen this player yet.
struct SearchPlayerIQModule: Equatable {
    let playerName: String
    let playerId: String?
    let playerIQScore: Double?         // 0-100
    let playerIQDirection: String?     // "rising" | "falling" | "stable"
    let playerIQLabel: String?         // "Heating Up ↑" etc
    let marketScore: Double?
    let marketDirection: String?       // "up" | "down" | "flat"
    let marketTrendPct: Double?
    let cardCount: Int?
    let topCardName: String?
    let performanceScore: Double?
    let performanceDirection: String?  // "hot" | "cold" | "neutral"
    let statLine: String?
    let momentumRatio: Double?
    let confidence: String?            // "high" | "medium" | "low"
    let updatedAt: String?
    let dataSource: String?
}

struct SearchResult: Equatable {
    let query: String
    let intent: SearchIntent
    let catalog: SearchCatalogModule?
    let price: SearchPriceModule?
    let stats: SearchStatsModule?
    let grade: SearchGradeModule?
    let inventory: SearchInventoryModule?
    let playerIQ: SearchPlayerIQModule?
    let timestamp: Date
}

enum SearchIQError: LocalizedError {
    case emptyQuery
    case classifierHTTP(Int)
    case classifierDecoding
    case network(String)

    var errorDescription: String? {
        switch self {
        case .emptyQuery:               return "Type a search query."
        case .classifierHTTP(let c):    return "Search service returned HTTP \(c)."
        case .classifierDecoding:       return "Search service sent a bad response."
        case .network(let m):           return m
        }
    }
}

// MARK: - Orchestrator

@MainActor
final class SearchIQOrchestrator: ObservableObject {

    // Endpoints
    private let mcpBaseURL: String
    private let backendBaseURL: String
    private let cardHedgeBaseURL: String
    private let mlbStatsBaseURL: String
    private let playerIQBaseURL: String
    /// Live Azure Functions endpoint for intent classification.
    /// Override via SEARCH_INTENT_URL env if needed.
    private let searchIntentURL: String
    /// Function key for fn-search-intent. Set SEARCH_INTENT_FUNCTION_KEY in
    /// the app environment / Info.plist; without it the call will 401.
    private let searchIntentKey: String

    private let session: URLSession
    private let moduleTimeout: TimeInterval = 3.0

    // SwiftData context for local inventory matching. The owning view should
    // call `attach(modelContext:)` from `.task` (or similar) so fetchInventory
    // can run a real query. If nil, the inventory section is simply skipped.
    private var modelContext: ModelContext?

    /// Inject the SwiftData ModelContext used by `fetchInventory`. Safe to
    /// call repeatedly; idempotent.
    func attach(modelContext: ModelContext) {
        self.modelContext = modelContext
    }

    // Tracks the most recently issued search to discard stale results.
    private var currentSearchID: UUID?

    // MARK: Published state

    @Published private(set) var result: SearchResult?
    @Published private(set) var isLoading: Bool = false
    @Published private(set) var lastError: String?

    // MARK: Init

    init(
        mcpBaseURL: String = SearchIQOrchestrator.envOrDefault(
            "MCP_BASE_URL",
            default: "https://compiq-mcp.azurewebsites.net"
        ),
        backendBaseURL: String = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net",
        cardHedgeBaseURL: String = "https://api.cardhedger.com/v1",
        mlbStatsBaseURL: String = "https://statsapi.mlb.com/api/v1",
        playerIQBaseURL: String = "https://compiq-mcp.azurewebsites.net",
        searchIntentURL: String = SearchIQOrchestrator.envOrDefault(
            "SEARCH_INTENT_URL",
            default: "https://fn-compiq.azurewebsites.net/api/search-intent"
        ),
        searchIntentKey: String = SearchIQOrchestrator.envOrDefault(
            "SEARCH_INTENT_FUNCTION_KEY",
            default: ""
        ),
        session: URLSession = .shared
    ) {
        self.mcpBaseURL = mcpBaseURL.trimmingTrailingSlash()
        self.backendBaseURL = backendBaseURL.trimmingTrailingSlash()
        self.cardHedgeBaseURL = cardHedgeBaseURL.trimmingTrailingSlash()
        self.mlbStatsBaseURL = mlbStatsBaseURL.trimmingTrailingSlash()
        self.playerIQBaseURL = playerIQBaseURL.trimmingTrailingSlash()
        self.searchIntentURL = searchIntentURL.trimmingTrailingSlash()
        self.searchIntentKey = searchIntentKey
        self.session = session
    }

    private static func envOrDefault(_ key: String, default fallback: String) -> String {
        ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespaces).nonEmpty ?? fallback
    }

    // MARK: Entry point

    /// Run a unified search. Never wipes `result` to nil during the call —
    /// the previous result stays on screen until the new one is assembled.
    func search(_ rawQuery: String) async {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            self.lastError = SearchIQError.emptyQuery.errorDescription
            return
        }

        let searchID = UUID()
        self.currentSearchID = searchID
        self.isLoading = true
        self.lastError = nil

        do {
            let intent: SearchIntent
            do {
                intent = try await classify(query: query)
            } catch {
                // Classifier outage must NOT block the catalog — degrade to a
                // bare "search" intent so fetchCatalog still fires and the
                // user sees thumbnails even when intent classification fails.
                #if DEBUG
                print("🟧 [SearchIQ.search] classifier failed (\(error)); falling back to bare search intent")
                #endif
                intent = SearchIntent(
                    intents: ["search"],
                    playerName: nil, year: nil, setName: nil, cardNumber: nil,
                    variant: nil, grade: nil,
                    isGradingQuestion: false, isOwnedCard: false, confidence: 0.0
                )
            }
            // Stale-check: a newer search has already been kicked off.
            guard self.currentSearchID == searchID else { return }

            let assembled = await fanOut(query: query, intent: intent)

            // Stale-check again after the fan-out.
            guard self.currentSearchID == searchID else { return }

            self.result = assembled
            self.isLoading = false
        } catch {
            // Even on classifier failure, keep the previous result visible.
            guard self.currentSearchID == searchID else { return }
            self.lastError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            self.isLoading = false
        }
    }

    // MARK: Step 1 — Intent classification

    private func classify(query: String) async throws -> SearchIntent {
        guard let url = URL(string: searchIntentURL) else {
            throw SearchIQError.classifierDecoding
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !searchIntentKey.isEmpty {
            req.setValue(searchIntentKey, forHTTPHeaderField: "x-functions-key")
        }
        req.timeoutInterval = 6.0
        req.httpBody = try JSONSerialization.data(withJSONObject: ["query": query])

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SearchIQError.classifierDecoding }
        guard (200..<300).contains(http.statusCode) else {
            throw SearchIQError.classifierHTTP(http.statusCode)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SearchIQError.classifierDecoding
        }
        var intents = (json["intents"] as? [String]) ?? ["search"]
        let entities = (json["entities"] as? [String: Any]) ?? [:]
        let confidence = (json["confidence"] as? Double) ?? 0.0

        // Force-include "inventory" whenever the classifier flags this as an
        // owned-card query. The MCP intent model is inconsistent about
        // emitting "inventory" itself, and without it the SwiftData fan-out
        // never runs — so the local match would silently disappear even when
        // is_owned_card=true. Belt-and-suspenders: also include it whenever a
        // player name was extracted AND a ModelContext is attached, since
        // that is the only case where fetchInventory can possibly produce a
        // result. Cheap to add; fetchInventory returns nil if nothing matches.
        let isOwnedFlag = (entities["is_owned_card"] as? Bool) ?? false
        let hasPlayer = (entities["playerName"] as? String)?.isEmpty == false
        if (isOwnedFlag || (hasPlayer && self.modelContext != nil)) && !intents.contains("inventory") {
            intents.append("inventory")
        }

        return SearchIntent(
            intents: intents,
            playerName: entities["playerName"] as? String,
            year: entities["year"] as? Int,
            setName: entities["set"] as? String,
            cardNumber: entities["cardNumber"] as? String,
            variant: entities["variant"] as? String,
            grade: entities["grade"] as? String,
            isGradingQuestion: (entities["is_grading_question"] as? Bool) ?? false,
            isOwnedCard: (entities["is_owned_card"] as? Bool) ?? false,
            confidence: confidence
        )
    }

    // MARK: Step 2 — Parallel fan-out

    private func fanOut(query: String, intent: SearchIntent) async -> SearchResult {
        let intentSet = Set(intent.intents)

        async let catalogTask: SearchCatalogModule? =
            Self.timed(seconds: moduleTimeout) { [self] in
                await fetchCatalog(query: query, intent: intent)
            }

        async let priceTask: SearchPriceModule? = intentSet.contains("price")
            ? Self.timed(seconds: moduleTimeout) { [self] in
                await fetchPrice(intent: intent)
            }
            : Self.nilModule()

        async let statsTask: SearchStatsModule? = intentSet.contains("stats")
            ? Self.timed(seconds: moduleTimeout) { [self] in
                await fetchStats(intent: intent)
            }
            : Self.nilModule()

        async let gradeTask: SearchGradeModule? = intentSet.contains("grade")
            ? Self.timed(seconds: moduleTimeout) { [self] in
                await fetchGrade(intent: intent)
            }
            : Self.nilModule()

        async let inventoryTask: SearchInventoryModule? = intentSet.contains("inventory")
            ? Self.timed(seconds: moduleTimeout) { [self] in
                await fetchInventory(intent: intent)
            }
            : Self.nilModule()

        // PlayerIQ runs whenever we have a player name — it's the unified
        // score (market + performance) and dirt cheap (single Cosmos read).
        async let playerIQTask: SearchPlayerIQModule? = (intent.playerName?.nonEmpty != nil)
            ? Self.timed(seconds: moduleTimeout) { [self] in
                await fetchPlayerIQ(intent: intent)
            }
            : Self.nilModule()

        let (catalog, price, stats, grade, inventory, playerIQ) = await (
            catalogTask, priceTask, statsTask, gradeTask, inventoryTask, playerIQTask
        )

        return SearchResult(
            query: query,
            intent: intent,
            catalog: catalog,
            price: price,
            stats: stats,
            grade: grade,
            inventory: inventory,
            playerIQ: playerIQ,
            timestamp: Date()
        )
    }

    /// PlayerIQ blended score from the TS backend at
    /// {playerIQBaseURL}/api/playeriq/{playerName}. Returns nil silently when
    /// the player has no document yet (the next estimate call will seed it).
    private func fetchPlayerIQ(intent: SearchIntent) async -> SearchPlayerIQModule? {
        guard let player = intent.playerName?.nonEmpty else { return nil }
        guard let url = URL(
            string: "\(playerIQBaseURL)/api/playeriq/\(player.urlPathEncoded)"
        ) else { return nil }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = moduleTimeout
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        guard
            let (data, resp) = try? await session.data(for: req),
            let http = resp as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        let market = json["market"] as? [String: Any] ?? [:]
        let perf = json["performance"] as? [String: Any] ?? [:]
        return SearchPlayerIQModule(
            playerName: (json["playerName"] as? String) ?? player,
            playerId: json["playerId"] as? String,
            playerIQScore: (json["playerIQScore"] as? Double)
                ?? (json["playerIQScore"] as? Int).map(Double.init),
            playerIQDirection: json["playerIQDirection"] as? String,
            playerIQLabel: json["playerIQLabel"] as? String,
            marketScore: (market["marketScore"] as? Double)
                ?? (market["marketScore"] as? Int).map(Double.init),
            marketDirection: market["marketDirection"] as? String,
            marketTrendPct: market["marketTrendPct"] as? Double,
            cardCount: market["cardCount"] as? Int,
            topCardName: market["topCardName"] as? String,
            performanceScore: (perf["performanceScore"] as? Double)
                ?? (perf["performanceScore"] as? Int).map(Double.init),
            performanceDirection: perf["performanceDirection"] as? String,
            statLine: perf["statLine"] as? String,
            momentumRatio: perf["momentumRatio"] as? Double,
            confidence: json["confidence"] as? String,
            updatedAt: json["updatedAt"] as? String,
            dataSource: json["dataSource"] as? String
        )
    }

    // MARK: Module fetchers

    /// Card Hedge catalog search — proxied through our backend so the
    /// CARD_HEDGE_API_KEY stays server-side. Returns up to 8 image-bearing
    /// candidates the user can pick from in the Search UI.
    private func fetchCatalog(query: String, intent: SearchIntent) async -> SearchCatalogModule? {
        guard let url = URL(string: "\(backendBaseURL)/api/compiq/cardsearch") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = moduleTimeout
        let body: [String: Any] = ["query": query, "limit": 8]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        req.httpBody = data

        guard
            let (resp, http) = try? await session.data(for: req),
            let httpResp = http as? HTTPURLResponse,
            (200..<300).contains(httpResp.statusCode),
            let json = try? JSONSerialization.jsonObject(with: resp) as? [String: Any]
        else {
            #if DEBUG
            print("🟥 [SearchIQ.fetchCatalog] network/parse failed for query=\(query)")
            #endif
            return nil
        }

        let raw = (json["hits"] as? [[String: Any]]) ?? []
        #if DEBUG
        print("🟦 [SearchIQ.fetchCatalog] query=\(query) hits=\(raw.count) firstImage=\(String(describing: raw.first?["image_url"]))")
        #endif
        let hits: [SearchCatalogModule.Hit] = raw.compactMap { item in
            guard let id = item["card_id"] as? String, !id.isEmpty else { return nil }
            let title = (item["title"] as? String) ?? "Untitled card"
            let yr = item["year"] as? Int
            return SearchCatalogModule.Hit(
                id: id,
                title: title,
                imageURL: item["image_url"] as? String,
                setName: item["set"] as? String,
                year: yr,
                cardNumber: item["card_number"] as? String
            )
        }
        return SearchCatalogModule(hits: hits)
    }

    /// CompIQ price prediction via MCP — only if intent includes "price".
    private func fetchPrice(intent: SearchIntent) async -> SearchPriceModule? {
        guard let player = intent.playerName?.nonEmpty else { return nil }
        guard let url = URL(string: "\(mcpBaseURL)/api/compiq/predict") else { return nil }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = moduleTimeout

        var body: [String: Any] = ["playerName": player]
        if let y = intent.year       { body["year"] = y }
        if let s = intent.setName    { body["set"] = s }
        if let n = intent.cardNumber { body["cardNumber"] = n }
        if let g = intent.grade      { body["grade"] = g }
        if let v = intent.variant    { body["variant"] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        req.httpBody = data

        guard
            let (raw, http) = try? await session.data(for: req),
            let httpResp = http as? HTTPURLResponse,
            (200..<300).contains(httpResp.statusCode),
            let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
        else { return nil }

        let pred = (json["prediction"] as? [String: Any]) ?? json
        return SearchPriceModule(
            predicted72h:  (pred["predicted_price_72h"] as? Double)
                        ?? (pred["predicted72h"] as? Double),
            predicted7d:   (pred["predicted_price_7d"] as? Double)
                        ?? (pred["predicted7d"] as? Double),
            direction:     pred["predicted_direction"] as? String
                        ?? pred["direction"] as? String,
            confidence:    pred["confidence"] as? Int,
            keyDrivers:    (pred["key_drivers"] as? [String]) ?? [],
            riskFlags:     (pred["risk_flags"] as? [String]) ?? [],
            bestTimeToSell: pred["best_time_to_sell"] as? String
        )
    }

    /// MLB Stats API recent game log — only if intent includes "stats".
    private func fetchStats(intent: SearchIntent) async -> SearchStatsModule? {
        guard let player = intent.playerName?.nonEmpty else { return nil }

        // 1. Resolve playerId by search.
        guard
            let lookupURL = URL(string: "\(mlbStatsBaseURL)/people/search?names=\(player.urlPathEncoded)"),
            let (lookupData, lookupResp) = try? await session.data(from: lookupURL),
            let lookupHTTP = lookupResp as? HTTPURLResponse,
            (200..<300).contains(lookupHTTP.statusCode),
            let lookupJSON = try? JSONSerialization.jsonObject(with: lookupData) as? [String: Any],
            let people = lookupJSON["people"] as? [[String: Any]],
            let first = people.first,
            let playerID = first["id"] as? Int
        else { return nil }

        // 2. Fetch season game log (current season).
        let cal = Calendar(identifier: .gregorian)
        let season = cal.component(.year, from: Date())
        let logURL = URL(
            string: "\(mlbStatsBaseURL)/people/\(playerID)/stats?stats=gameLog&season=\(season)&group=hitting"
        )
        guard
            let url = logURL,
            let (data, resp) = try? await session.data(from: url),
            let http = resp as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let stats = json["stats"] as? [[String: Any]],
            let firstGroup = stats.first,
            let splits = firstGroup["splits"] as? [[String: Any]]
        else {
            return SearchStatsModule(playerName: player, last10Games: [])
        }

        let last10 = splits.suffix(10).map { split -> SearchStatsModule.StatLine in
            let date = (split["date"] as? String) ?? ""
            let stat = (split["stat"] as? [String: Any]) ?? [:]
            let hits = stat["hits"] as? Int ?? 0
            let ab   = stat["atBats"] as? Int ?? 0
            let hr   = stat["homeRuns"] as? Int ?? 0
            let rbi  = stat["rbi"] as? Int ?? 0
            let avgRaw = (stat["avg"] as? String).flatMap { Double($0) }
            let summary = "\(hits)-for-\(ab), \(hr) HR, \(rbi) RBI"
            return SearchStatsModule.StatLine(date: date, summary: summary, avg: avgRaw)
        }
        return SearchStatsModule(playerName: player, last10Games: Array(last10))
    }

    /// GradeIQ prediction — only if intent includes "grade".
    /// Calls Card Hedge for raw + PSA 10/9 prices, computes uplift % and
    /// recommendation purely client-side. Returns nil if not enough data.
    private func fetchGrade(intent: SearchIntent) async -> SearchGradeModule? {
        guard intent.playerName?.nonEmpty != nil else { return nil }
        guard let url = URL(string: "\(cardHedgeBaseURL)/cards/card-match") else { return nil }

        let parts: [String] = [
            intent.year.map(String.init) ?? "",
            intent.setName ?? "",
            intent.playerName ?? "",
            intent.cardNumber.map { "#\($0)" } ?? ""
        ].filter { !$0.isEmpty }
        let q = parts.joined(separator: " ")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = ProcessInfo.processInfo.environment["CARD_HEDGE_API_KEY"], !key.isEmpty {
            req.setValue(key, forHTTPHeaderField: "X-API-Key")
        }
        req.timeoutInterval = moduleTimeout
        let body: [String: Any] = ["query": q, "category": "Baseball"]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
        req.httpBody = data

        guard
            let (raw, http) = try? await session.data(for: req),
            let httpResp = http as? HTTPURLResponse,
            (200..<300).contains(httpResp.statusCode),
            let json = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
        else { return nil }

        let conf = (json["confidence"] as? Double) ?? 0.0
        guard conf >= 0.80 else { return nil }

        let prices = (json["prices"] as? [String: Any]) ?? [:]
        let rawPrice  = Self.priceFromAny(prices["raw"])
        let psa10     = Self.priceFromAny(prices["psa10"] ?? prices["PSA10"])
        let psa9      = Self.priceFromAny(prices["psa9"]  ?? prices["PSA9"])

        var uplift: Double? = nil
        if let r = rawPrice, r > 0, let p = psa10 {
            uplift = ((p - r) / r) * 100.0
        }

        let recommendation: String
        let reasoning: String
        if let r = rawPrice, let p = psa10 {
            let net = p - r - 25.0   // assume ~$25 grading + shipping
            if net > r * 0.5 {
                recommendation = "grade"
                reasoning = "PSA 10 nets ~$\(Int(net)) over raw after fees."
            } else if net > 0 {
                recommendation = "hold"
                reasoning = "Marginal grading upside — wait for raw price to rise."
            } else {
                recommendation = "sell-raw"
                reasoning = "Grading fees outweigh PSA 10 uplift."
            }
        } else {
            recommendation = "unknown"
            reasoning = "Not enough price data to evaluate grading."
        }

        return SearchGradeModule(
            rawPrice: rawPrice,
            psa10Price: psa10,
            psa9Price: psa9,
            upliftPct: uplift,
            recommendation: recommendation,
            reasoning: reasoning
        )
    }

    /// Local inventory match — pure SwiftData query, no network call. The TS
    /// backend has no `/api/inventory/search` route; inventory lives only on
    /// device. Returns nil when there is no player intent, no ModelContext
    /// attached, or zero matches (so the section stays hidden rather than
    /// rendering an empty list).
    private func fetchInventory(intent: SearchIntent) async -> SearchInventoryModule? {
        guard let player = intent.playerName?.nonEmpty else { return nil }
        guard let context = modelContext else { return nil }

        let needle = player.lowercased()
        let yearFilter = intent.year
        let setNeedle = intent.setName?.nonEmpty?.lowercased()
        let numberNeedle = intent.cardNumber?.nonEmpty?.lowercased()

        // SwiftData #Predicate cannot do case-insensitive contains reliably
        // across iOS 17/18, so fetch all CardItems and filter in Swift. The
        // local inventory is small (hundreds of cards at most), so this is
        // cheap and avoids predicate compatibility issues.
        let descriptor = FetchDescriptor<CardItem>()
        guard let allCards = try? context.fetch(descriptor), !allCards.isEmpty else {
            return nil
        }

        let filtered = allCards.filter { card in
            guard card.playerName.lowercased().contains(needle) else { return false }
            if let y = yearFilter, card.year != y { return false }
            if let s = setNeedle, !card.setName.lowercased().contains(s) { return false }
            if let n = numberNeedle, !card.cardNumber.lowercased().contains(n) { return false }
            return true
        }

        let matches: [SearchInventoryModule.Match] = filtered.map { card in
            let title: String = {
                let t = card.cardTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { return t }
                var parts: [String] = []
                if let y = card.year { parts.append(String(y)) }
                if !card.playerName.isEmpty { parts.append(card.playerName) }
                if !card.setName.isEmpty    { parts.append(card.setName) }
                if !card.cardNumber.isEmpty { parts.append("#\(card.cardNumber)") }
                return parts.isEmpty ? card.playerName : parts.joined(separator: " ")
            }()
            return SearchInventoryModule.Match(
                id: Self.routerId(for: card),
                title: title,
                year: card.year,
                setName: card.setName.isEmpty ? nil : card.setName,
                cardNumber: card.cardNumber.isEmpty ? nil : card.cardNumber,
                imageURL: card.photoURLs.first,
                costBasis: card.purchasePrice > 0 ? card.purchasePrice : nil
            )
        }

        guard !matches.isEmpty else { return nil }
        return SearchInventoryModule(matches: matches)
    }

    /// Stable per-card id derived from SwiftData persistentModelID. MUST stay
    /// identical to `CardDetailRouter.routerId(for:)` and
    /// `ListingComposerView.holdingId()` so navigation by `Match.id` resolves.
    private static func routerId(for card: CardItem) -> String {
        let raw = String(describing: card.persistentModelID)
        let alnum = raw.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        let cleaned = String(String.UnicodeScalarView(alnum))
        return String(cleaned.suffix(40))
    }

    // MARK: Helpers

    /// Wraps an async work item with a hard wall-clock timeout. Returns nil
    /// if the work doesn't finish in time. Never throws.
    private static func timed<T: Sendable>(
        seconds: TimeInterval,
        operation: @Sendable @escaping () async -> T?
    ) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask {
                await operation()
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Marker to keep the `async let` ternaries type-uniform.
    private static func nilModule<T: Sendable>() async -> T? { nil }

    /// Card Hedge sometimes returns prices as numeric strings in dollars.
    /// Coerce both shapes into Double; never divide by 100.
    private static func priceFromAny(_ v: Any?) -> Double? {
        if let n = v as? Double { return n }
        if let n = v as? Int { return Double(n) }
        if let s = v as? String { return Double(s) }
        return nil
    }
}

// MARK: - Tiny string helpers (file-private)

private extension String {
    var nonEmpty: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
    func trimmingTrailingSlash() -> String {
        hasSuffix("/") ? String(dropLast()) : self
    }
    var urlPathEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}
