//
//  PortfolioIQViewModel.swift
//  HobbyIQ
//

import Combine
import Foundation
import UIKit
import os

@MainActor
final class PortfolioIQViewModel: ObservableObject {
    @Published private(set) var summary: PortfolioSummaryResponse?
    @Published private(set) var inventoryCards: [InventoryCard] = [] {
        didSet { recomputeCachedProperties() }
    }
    @Published private(set) var salesHistory: [Sale] = []
    @Published private(set) var apiLedgerEntries: [PortfolioLedgerEntry]?
    @Published private(set) var ledgerTotals: PortfolioLedgerTotals?
    /// CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): auto-imported eBay
    /// holdings the user hasn't confirmed yet. Never included in
    /// `inventoryCards` (backend excludes from `/api/portfolio`) — the
    /// review screen reads exclusively from here. Fetched in parallel
    /// with the main portfolio load.
    @Published private(set) var pendingReviewHoldings: [InventoryCard] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var pendingInventoryFilter: PortfolioInventoryFilter?

    // Cached derived data — recomputed only when inventoryCards changes
    @Published private(set) var cachedPriorityActions: [PortfolioPriorityAction] = []
    @Published private(set) var cachedTopMovers: [PortfolioMover] = []

    /// CF-LIVE-PANEL-CACHE (2026-07-09): per-holding grade curves fetched
    /// via `POST /api/compiq/observed-grade-curves-bulk`. Keyed by the
    /// backend cardId (String — not the UUID). Rows + detail sheet
    /// consult this cache so inventory list, holding detail, and
    /// comp card all render the same live number for the same holding's
    /// grade. Nil / empty entry → fall back to `card.fairMarketValue`.
    @Published private(set) var livePanelEntries: [String: [CardPanelGradeEntry]] = [:]

    /// P0.7 (2026-07-16, verdict-history-flip-surfaces.md): recent (last
    /// 7 days) verdict flips per player, keyed by the backend-normalized
    /// (lowercase-hyphenated) name. Populated by `loadRecentFlips()` on
    /// every portfolio open; `recentFlip(for:)` does the row-level lookup.
    /// Empty until first fetch; a stale-deploy 401 leaves it untouched.
    @Published private(set) var recentFlipsByPlayer: [String: VerdictFlip] = [:]

    /// Corpus signals (2026-07-17): per-player matched-cohort momentum
    /// cache. Keyed by normalized (lowercase-hyphenated) name to align
    /// with the backend slug. `playerTrend(for:)` does the row-level
    /// lookup; entries older than 12h re-fetch on next access.
    @Published private(set) var playerTrendsByPlayer: [String: PlayerTrendResponse] = [:]
    /// Tracks in-flight fetches so a rapid re-appear (list refresh) doesn't
    /// fire duplicate requests for the same player.
    private var playerTrendFetchesInFlight: Set<String> = []

    /// Corpus signals (2026-07-17, PR #518): portfolio-wide grade-worthy
    /// scan. Populated by `loadGradeWorthyAlerts()` on portfolio open;
    /// feeds the top-of-list banner and the drill-down list view.
    @Published private(set) var gradeWorthyAlerts: GradeWorthyAlertsResponse?

    /// 2026-07-18 canonical-FMV migration: server is the single source
    /// of truth for market value. Populated in a background batch after
    /// `load()` returns; rows consult this cache via `marketValue(for:)`
    /// which falls back to the private `syncFallbackMarketValue(for:)`
    /// chain when the entry is missing (cold cache, in-flight fetch,
    /// or backend `no-basis`).
    @Published private(set) var fmvCache: [FmvKey: CanonicalFmvResponse] = [:]
    /// True while the batch loader is populating `fmvCache`. Used by
    /// row skeletons + the "updated Xs ago" caption on the dashboard.
    @Published private(set) var isRefreshingFmvCache: Bool = false
    /// Wall-clock timestamp of the last successful batch completion.
    /// Feeds staleness copy on the dashboard total.
    @Published private(set) var fmvCacheLastUpdated: Date?
    /// Increments each time a batch starts so an in-flight run can be
    /// abandoned by a newer trigger without racing state.
    private var fmvBatchGeneration: Int = 0

    struct FmvKey: Hashable {
        let cardId: String
        let parallel: String?
        let gradeCompany: String?
        let gradeValue: Double?

        /// Normalized key derived from an InventoryCard — matches the
        /// wire body iOS sends to /canonical-fmv. Nil parallel = base
        /// holding, nil gradeCompany = raw.
        init(card: InventoryCard) {
            self.cardId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let trimmedParallel = card.parallel.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedParallel.isEmpty || trimmedParallel.lowercased() == "base" {
                self.parallel = nil
            } else {
                self.parallel = trimmedParallel
            }
            if let company = card.gradeCompany?.trimmingCharacters(in: .whitespacesAndNewlines),
               company.isEmpty == false {
                self.gradeCompany = company.uppercased()
            } else {
                self.gradeCompany = nil
            }
            self.gradeValue = card.gradeValue
        }
    }

    /// Cached-first-paint portfolio total. Read on cold start for the
    /// dashboard hero so users see a real number instantly; overwritten
    /// after the fresh batch resolves.
    private static let cachedPortfolioTotalKey = "hobbyiq.portfolio.total.cached"
    var cachedPortfolioTotal: Double? {
        get {
            let raw = UserDefaults.standard.double(forKey: Self.cachedPortfolioTotalKey)
            return raw > 0 ? raw : nil
        }
    }
    private func writeCachedPortfolioTotal(_ value: Double) {
        UserDefaults.standard.set(value, forKey: Self.cachedPortfolioTotalKey)
    }

    private let service: APIService
    private let logger = Logger(subsystem: "com.hobbyiq.app", category: "portfolio")

    init(service: APIService, initialSummary: PortfolioSummaryResponse? = nil) {
        self.service = service
        self.summary = initialSummary
        self.inventoryCards = []
    }

    convenience init(initialSummary: PortfolioSummaryResponse? = nil) {
        self.init(service: APIService.shared, initialSummary: initialSummary)
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

    var heroSummary: PortfolioHeroSummary {
        let inventory = inventorySummary ?? PortfolioInventorySummary(
            totalCost: 0,
            totalCurrentValue: 0,
            totalProfitLoss: 0,
            roi: 0,
            activeCount: inventoryCards.count
        )

        return PortfolioHeroSummary(
            totalCards: accountSnapshot?.totalCards ?? inventory.activeCount,
            totalValue: accountSnapshot?.totalValue ?? inventory.totalCurrentValue,
            costBasis: accountSnapshot?.totalCost ?? inventory.totalCost,
            unrealizedPnL: accountSnapshot?.totalProfitLoss ?? inventory.totalProfitLoss,
            roi: accountSnapshot?.roi ?? inventory.roi,
            lastRefreshText: accountSnapshot?.generatedAtFormatted ?? "—"
        )
    }

    var priorityActions: [PortfolioPriorityAction] { cachedPriorityActions }

    var topMovers: [PortfolioMover] { cachedTopMovers }

    // CF-IOS-DIRECTION-SWEEP (2026-06-18): hasMovementSignals,
    // movementPulseSummary, portfolioImpliedPct, portfolioComposite
    // removed — all four derived from movementDirection /
    // predictedPrice and fed the now-removed Movement Pulse card.

    private func recomputeCachedProperties() {
        // CF-PRIORITY-COUNT-FIX (2026-07-06): the row's `cardCount`
        // MUST match the size of the list `PriorityActionListView`
        // renders, otherwise the pill on PortfolioIQ ("12") disagrees
        // with the count in the pushed page. Compute the full match
        // set using the same predicates InventoryIQView uses for
        // `.sellWatch` / `.losers` / `.stale`, then use `.prefix(3)`
        // ONLY for the subtitle preview names.
        let sellWatchAll = inventoryCards.filter {
            $0.profitLoss < 0 || $0.status.lowercased().contains("sell")
        }
        let highRiskAll = inventoryCards.filter { $0.profitLoss < 0 }
        let staleAll = inventoryCards.filter { $0.freshnessChipText == "Stale" }

        var actions: [PortfolioPriorityAction] = []

        if sellWatchAll.isEmpty == false {
            let preview = sellWatchAll.prefix(3).map(\.playerName)
            actions.append(
                PortfolioPriorityAction(
                    id: "sell-watch",
                    kind: .sellWatch,
                    title: "Sell-watch cards",
                    subtitle: preview.joined(separator: ", "),
                    detail: "\(sellWatchAll.count) cards are flagged for the sell queue.",
                    cardCount: sellWatchAll.count
                )
            )
        }

        if highRiskAll.isEmpty == false {
            let preview = highRiskAll.prefix(3).map(\.playerName)
            actions.append(
                PortfolioPriorityAction(
                    id: "high-risk",
                    kind: .highRisk,
                    title: "High risk cards",
                    subtitle: preview.joined(separator: ", "),
                    detail: "\(highRiskAll.count) cards are currently underwater.",
                    cardCount: highRiskAll.count
                )
            )
        }

        if staleAll.isEmpty == false {
            let preview = staleAll.prefix(3).map(\.playerName)
            actions.append(
                PortfolioPriorityAction(
                    id: "stale-pricing",
                    kind: .stalePricing,
                    title: "Stale pricing cards",
                    subtitle: preview.joined(separator: ", "),
                    detail: "\(staleAll.count) cards need a fresh comp check.",
                    cardCount: staleAll.count
                )
            )
        }

        cachedPriorityActions = actions

        // CF-IOS-DIRECTION-SWEEP (2026-06-18): top-movers is now always
        // P/L-ranked (Gainers / Losers). The prior `hasMovementSignals`
        // branch ranked by direction-derived $ impact (predictedPrice
        // − fairMarketValue) — direction-class. Backtest established
        // direction is at-chance; honest historical P/L sign read
        // replaces it.
        // CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): pending-review
        // rows never contribute to totals / movers / actions. Backend
        // excludes them from `/api/portfolio`; this client-side filter
        // is a belt for any wire path that still leaks them through.
        let activeCards = inventoryCards.filter {
            let s = $0.status.lowercased()
            return s != "sold" && s != "pending-review"
        }

        let gainers = activeCards
            .sorted { $0.profitLoss > $1.profitLoss }
            .prefix(3)
            .map { card in
                PortfolioMover(
                    id: "gain-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    trendLabel: "Gainer",
                    trendDetail: card.trendChipText,
                    imageUrl: card.imageFrontUrl ?? card.catalogImageUrl,
                    actionRecommendation: card.actionRecommendation
                )
            }

        let losers = activeCards
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .map { card in
                PortfolioMover(
                    id: "loss-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    trendLabel: "Loser",
                    trendDetail: card.trendChipText,
                    imageUrl: card.imageFrontUrl ?? card.catalogImageUrl,
                    actionRecommendation: card.actionRecommendation
                )
            }

        cachedTopMovers = Array(gainers) + Array(losers)
    }

    var ledgerEntries: [PortfolioLedgerEntry] {
        if let api = apiLedgerEntries { return api }
        return salesHistory
            .sorted { $0.date > $1.date }
            .prefix(10)
            .enumerated()
            .map { index, sale in PortfolioLedgerEntry(fromSale: sale, index: index) }
    }

    func fetchLedger() async {
        do {
            let response = try await service.fetchPortfolioLedger()
            apiLedgerEntries = response.entries ?? []
            ledgerTotals = response.totals
        } catch {
            logger.error("Ledger fetch failed, falling back to local sales: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// CF-EBAY-REVIEW-QUEUE (backend PRs #383-#388): loads the queue of
    /// auto-imported holdings the user still needs to confirm. Failure
    /// is non-fatal (empty queue displays same as "no pending").
    func fetchPendingReview() async {
        do {
            pendingReviewHoldings = try await service.fetchPendingReviewHoldings()
        } catch {
            logger.error("Pending-review fetch failed: \(error.localizedDescription, privacy: .public)")
            pendingReviewHoldings = []
        }
    }

    /// CF-CARDID-SUGGEST (backend PR #389) + CF-PROGRESSIVE-BUCKETS
    /// (PR #393): when the queue opens, if any row lacks a
    /// `suggestedCardId` (or tier), ask the server to compute
    /// suggestions across the pending queue, then reload. `force=true`
    /// (pull-to-refresh) re-runs even for rows that already have a
    /// suggestion — used to promote medium → high after a Cardsight
    /// catalog update.
    func generatePendingSuggestionsIfNeeded(force: Bool = false) async {
        if force == false {
            let anyMissing = pendingReviewHoldings.contains {
                $0.suggestedCardId == nil || $0.suggestionConfidenceTier == nil
            }
            guard anyMissing else { return }
        }
        do {
            _ = try await service.generateHoldingSuggestions(force: force)
            await fetchPendingReview()
        } catch {
            logger.error("Generate suggestions failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Confirms one pending row. On success, drops it from the queue
    /// and asks the main portfolio to reload so the new active
    /// holding shows up in inventory.
    func confirmPendingHolding(id: String, patch: HoldingConfirmRequest) async -> Bool {
        do {
            let response = try await service.confirmPendingHolding(id: id, patch: patch)
            #if DEBUG
            let h = response.holding
            print("[Confirm] response status=\(response.status ?? "-") corrections=\(response.correctionCount ?? -1)")
            if let h {
                print("[Confirm] backend holding after: player=\(h.playerName) set=\(h.setName) year=\(h.year) parallel=\(h.parallel) cardId=\(h.cardId ?? "-") backendId=\(h.backendId ?? "-")")
            } else {
                print("[Confirm] backend returned no holding in response")
            }
            #endif
            pendingReviewHoldings.removeAll {
                $0.backendId == id || $0.id.uuidString == id || $0.cardId == id
            }
            await fetch(preserveExistingSummaryOnError: true)
            NotificationCenter.default.post(name: .portfolioSaleRecorded, object: nil)
            return true
        } catch {
            logger.error("Confirm pending holding \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = APIService.errorMessage(from: error)
            return false
        }
    }

    /// Rejects one pending row — auto-import misfire. Backend deletes
    /// the holding and unlinks it from its source purchase.
    func rejectPendingHolding(id: String) async -> Bool {
        do {
            _ = try await service.rejectPendingHolding(id: id)
            pendingReviewHoldings.removeAll { $0.id.uuidString == id || $0.cardId == id }
            return true
        } catch {
            logger.error("Reject pending holding \(id, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = APIService.errorMessage(from: error)
            return false
        }
    }

    /// One-tap batch confirmation of every holding in the queue whose
    /// confidence bucket is `.high`. Sends an empty patch per row —
    /// the user hasn't edited anything, so we don't spend backend
    /// diff cycles updating fields.
    func batchConfirmHighConfidence() async -> Int {
        let highConf = pendingReviewHoldings.filter { $0.reviewConfidenceBucket == .high }
        var confirmed = 0
        for holding in highConf {
            let identifier = holding.cardId ?? holding.id.uuidString
            if await confirmPendingHolding(id: identifier, patch: .empty) {
                confirmed += 1
            }
        }
        return confirmed
    }

    func dismissLedgerEntry(id: String, reason: String?) async throws {
        let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = LedgerPatchBody(
            dismissedAt: .some(ISO8601DateFormatter().string(from: Date())),
            dismissedReason: .some(trimmed?.isEmpty == false ? trimmed : nil)
        )
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    func undismissLedgerEntry(id: String) async throws {
        let body = LedgerPatchBody(
            dismissedAt: .some(nil),
            dismissedReason: .some(nil)
        )
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    func updateLedgerEntryCosts(id: String, gradingCost: Double??, suppliesCost: Double??) async throws {
        let body = LedgerPatchBody(gradingCost: gradingCost, suppliesCost: suppliesCost)
        let updated = try await service.updateLedgerEntry(id: id, body: body)
        replaceEntry(updated)
    }

    private func replaceEntry(_ updated: PortfolioLedgerEntry) {
        guard var entries = apiLedgerEntries,
              let idx = entries.firstIndex(where: { $0.id == updated.id }) else { return }
        entries[idx] = updated
        apiLedgerEntries = entries
    }

    func exportLedgerCSV(includeUnreconciled: Bool) -> URL? {
        let entries = ledgerEntries
        let filtered = includeUnreconciled ? entries : entries.filter { $0.needsReconciliation != true }

        var lines: [String] = []
        let header = [
            "Date", "Player", "Card", "Source", "Sale Price", "Gross Proceeds",
            "Final Value Fee", "Payment Processing Fee", "Promoted Listing Fee",
            "Ad Fee", "Shipping Cost", "Other Fees", "Total Fees",
            "Net Proceeds", "Cost Basis", "Grading Cost", "Supplies Cost",
            "Realized P&L", "ROI %", "Needs Reconciliation"
        ].map { csvEscape($0) }.joined(separator: ",")
        lines.append(header)

        let isoFmt = ISO8601DateFormatter()
        isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoStd = ISO8601DateFormatter()
        isoStd.formatOptions = [.withInternetDateTime]
        let dateFmt = DateFormatter()
        dateFmt.dateFormat = "yyyy-MM-dd"

        for entry in filtered {
            let dateStr: String = {
                guard let soldAt = entry.soldAt, !soldAt.isEmpty,
                      let date = isoFmt.date(from: soldAt) ?? isoStd.date(from: soldAt) else {
                    return entry.dateText
                }
                return dateFmt.string(from: date)
            }()

            let unreconciledFlag = (includeUnreconciled && entry.needsReconciliation == true) ? "YES" : ""

            let row = [
                csvEscape(dateStr),
                csvEscape(entry.playerName),
                csvEscape(entry.cardName),
                csvEscape(entry.source ?? "manual"),
                csvNum(entry.unitSalePrice),
                csvNum(entry.grossProceeds),
                csvNum(entry.finalValueFee),
                csvNum(entry.paymentProcessingFee),
                csvNum(entry.promotedListingFee),
                csvNum(entry.adFee),
                csvNum(entry.actualShippingCost),
                csvNum(entry.otherFees),
                csvNum(entry.totalGranularFees),
                csvNum(entry.netProceeds),
                csvNum(entry.costBasisSold),
                csvNum(entry.gradingCost),
                csvNum(entry.suppliesCost),
                csvNum(entry.realizedProfitLoss),
                entry.realizedProfitLossPct.map { String(format: "%.2f", $0) } ?? "",
                unreconciledFlag
            ].joined(separator: ",")
            lines.append(row)
        }

        let csv = lines.joined(separator: "\n")
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("hobbyiq_tax_export_\(dateFmt.string(from: Date())).csv")
        do {
            try csv.write(to: fileURL, atomically: true, encoding: .utf8)
            return fileURL
        } catch {
            logger.error("CSV export failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func csvEscape(_ value: String) -> String {
        if value.contains(",") || value.contains("\"") || value.contains("\n") {
            return "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
        }
        return value
    }

    private func csvNum(_ value: Double?) -> String {
        guard let value else { return "" }
        return String(format: "%.2f", value)
    }

    func load() async {
        // CF-CANCELLATION-FIX (2026-07-12): `async let _ = …` binds the
        // child task to the enclosing scope, so when this function
        // returns (as soon as `fetch` completes) the ledger and
        // pending-review calls get cancelled mid-flight. Detached
        // `Task {}` lets them finish independently and populate their
        // own `@Published` slots without racing the parent.
        Task { await fetchLedger() }
        Task { await fetchPendingReview() }
        await fetch(preserveExistingSummaryOnError: false)
        // 2026-07-18: warm the canonical-FMV cache in the background so
        // rows / dashboard total start reading canonical values.
        Task { await refreshCanonicalFmvCache(forceRefresh: false) }
    }

    /// CF-LIVE-PANEL-CACHE (2026-07-09): populates `livePanelEntries`
    /// by calling the bulk grade-curves endpoint for every holding
    /// with a non-empty backend cardId. Cheap on the server (12h
    /// cached) so it's safe to fire whenever the inventory list
    /// appears. Failures degrade silently — rows just fall back to
    /// the cached `fairMarketValue` snapshot.
    func refreshLivePanelValues() async {
        let cardIds = Array(Set(
            inventoryCards
                .compactMap { $0.cardId?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.isEmpty == false }
        ))
        guard cardIds.isEmpty == false else {
            livePanelEntries = [:]
            return
        }
        do {
            let response = try await service.fetchBulkGradeCurves(cardIds: cardIds)
            var next: [String: [CardPanelGradeEntry]] = [:]
            for curve in response.curves ?? [] {
                guard let id = curve.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
                      id.isEmpty == false else { continue }
                next[id] = curve.entries ?? []
            }
            livePanelEntries = next
        } catch {
            // Silent — the row falls back to `card.fairMarketValue`.
            logger.error("bulk grade curves failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// 2026-07-15: push freshly-fetched per-card panel entries (e.g.
    /// from the holding detail sheet's `/card-panel` fetch) into the
    /// shared cache so the inventory row / grid / sort read the same
    /// value the detail hero is showing. Trimmed cardId is required —
    /// callers that don't have one should skip.
    func writeLivePanelEntries(cardId: String, entries: [CardPanelGradeEntry]) {
        let trimmed = cardId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return }
        livePanelEntries[trimmed] = entries
    }

    // MARK: - Canonical FMV cache (2026-07-18 migration)

    /// Layered market-value read. Prefers the canonical cache; falls
    /// back to the legacy sync chain when the entry is missing
    /// (cold cache, in-flight fetch, or backend `no-basis`).
    ///
    /// Returned value is already qty-scaled to match the legacy helper.
    func marketValue(for card: InventoryCard) -> Double {
        let qty = max(1.0, card.quantity ?? 1.0)
        let key = FmvKey(card: card)
        if key.cardId.isEmpty == false,
           let cached = fmvCache[key],
           cached.isRenderable,
           let fmv = cached.fmv, fmv > 0 {
            return fmv * qty
        }
        return syncFallbackMarketValue(for: card)
    }

    /// Canonical FMV envelope for a holding, if resolved. Nil when the
    /// cache is cold OR the pipeline returned `no-basis`. Callers that
    /// need method / provenance / confidence read this directly.
    func canonicalFmv(for card: InventoryCard) -> CanonicalFmvResponse? {
        let key = FmvKey(card: card)
        guard key.cardId.isEmpty == false else { return nil }
        return fmvCache[key]
    }

    /// Batches canonical-FMV fetches at concurrency 8. Called after
    /// `load()` returns and on pull-to-refresh (`forceRefresh: true`
    /// bypasses server Redis via `freshCompute`). Publishing to
    /// `fmvCache` per-entry lets rows re-render as data flows in.
    func refreshCanonicalFmvCache(forceRefresh: Bool = false) async {
        fmvBatchGeneration &+= 1
        let generation = fmvBatchGeneration
        // Dedupe by FmvKey so a 100-quantity holding fires one request.
        var seen: Set<FmvKey> = []
        var requests: [(FmvKey, CanonicalFmvRequest)] = []
        for card in inventoryCards {
            let key = FmvKey(card: card)
            guard key.cardId.isEmpty == false else { continue }
            guard seen.insert(key).inserted else { continue }
            let request = canonicalFmvRequest(for: card, key: key, freshCompute: forceRefresh)
            requests.append((key, request))
        }
        guard requests.isEmpty == false else {
            if forceRefresh { fmvCache = [:] }
            fmvCacheLastUpdated = Date()
            return
        }
        if forceRefresh {
            fmvCache = [:]
        }
        isRefreshingFmvCache = true
        defer {
            // Only clear the loading flag when we're still the current
            // generation — an interleaved refresh keeps ownership.
            if generation == fmvBatchGeneration {
                isRefreshingFmvCache = false
            }
        }
        await withTaskGroup(of: (FmvKey, CanonicalFmvResponse?).self) { group in
            var iterator = requests.makeIterator()
            let concurrency = min(8, requests.count)
            for _ in 0..<concurrency {
                guard let next = iterator.next() else { break }
                group.addTask { [service] in
                    do {
                        let response = try await service.fetchCanonicalFmv(next.1)
                        return (next.0, response)
                    } catch {
                        return (next.0, nil)
                    }
                }
            }
            while let result = await group.next() {
                // Abandon results from a superseded batch.
                guard generation == fmvBatchGeneration else { continue }
                if let response = result.1 {
                    fmvCache[result.0] = response
                }
                if let next = iterator.next() {
                    group.addTask { [service] in
                        do {
                            let response = try await service.fetchCanonicalFmv(next.1)
                            return (next.0, response)
                        } catch {
                            return (next.0, nil)
                        }
                    }
                }
            }
        }
        guard generation == fmvBatchGeneration else { return }
        fmvCacheLastUpdated = Date()
        let total = inventoryCards.reduce(0.0) { sum, card in
            sum + marketValue(for: card)
        }
        if total > 0 {
            writeCachedPortfolioTotal(total)
        }
    }

    /// Invalidate a single key and refetch — used after a user commits a
    /// comp (confirm holding, add manual sale) so the affected holding
    /// snaps to fresh math without waiting for the batch TTL.
    func invalidateCanonicalFmv(for card: InventoryCard, freshCompute: Bool = true) async {
        let key = FmvKey(card: card)
        guard key.cardId.isEmpty == false else { return }
        fmvCache.removeValue(forKey: key)
        let request = canonicalFmvRequest(for: card, key: key, freshCompute: freshCompute)
        do {
            let response = try await service.fetchCanonicalFmv(request)
            fmvCache[key] = response
        } catch {
            // Silent — row falls back to the legacy chain until next batch.
        }
    }

    private func canonicalFmvRequest(
        for card: InventoryCard,
        key: FmvKey,
        freshCompute: Bool
    ) -> CanonicalFmvRequest {
        let cardYear = Int(card.year.trimmingCharacters(in: .whitespaces))
        let productTrimmed = card.setName.trimmingCharacters(in: .whitespacesAndNewlines)
        let playerTrimmed = card.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return CanonicalFmvRequest(
            cardId: key.cardId,
            parallel: key.parallel,
            gradeCompany: key.gradeCompany,
            gradeValue: key.gradeValue,
            cardYear: cardYear,
            product: productTrimmed.isEmpty ? nil : productTrimmed,
            player: playerTrimmed.isEmpty ? nil : playerTrimmed,
            cardNumber: nil,
            freshCompute: freshCompute
        )
    }

    /// Canonical single-source-of-truth market value for a holding.
    /// Every surface — inventory row, grid card, detail hero, header
    /// total, sort — reads this so the same card can never show
    /// different numbers across the app. Fallback order: live-panel
    /// cache → observed FMV → cached currentValue → engine estimate →
    /// best-known fallback (low/high midpoint, at-cost). Always
    /// scaled by quantity.
    ///
    /// 2026-07-19 (card-show batch): renamed from a previously-public
    /// helper so the codebase's grep returns zero matches on the old
    /// name. The fallback logic itself is load-bearing during cold-
    /// cache renders (canonical FMV is async) so we keep the chain
    /// intact — just scoped as a private implementation detail of
    /// `marketValue(for:)`.
    private func syncFallbackMarketValue(for card: InventoryCard) -> Double {
        let qty = max(1.0, card.quantity ?? 1.0)
        if let live = liveMarketValue(for: card), live > 0 { return live * qty }
        if let v = card.fairMarketValue, v > 0 { return v * qty }
        if card.currentValue > 0 { return card.currentValue }
        if let v = card.estimatedValue, v > 0 { return v * qty }
        if let best = card.bestKnownMarketValue { return best.perUnit * qty }
        return 0
    }

    /// CF-LIVE-PANEL-CACHE (2026-07-09): resolves the market value for
    /// a holding by looking up its grade in the cached bulk-fetched
    /// entries. Returns nil when the cache hasn't loaded yet, the
    /// holding has no backend cardId, or no entry matches the grade —
    /// callers fall back to `card.fairMarketValue`.
    func liveMarketValue(for card: InventoryCard) -> Double? {
        guard let rawId = card.cardId?.trimmingCharacters(in: .whitespacesAndNewlines),
              rawId.isEmpty == false else { return nil }
        guard let entries = livePanelEntries[rawId], entries.isEmpty == false else { return nil }
        let key = holdingGradeKey(for: card)
        let match = entries.first { entry in
            GradePillPanel.normalizedKey(grade: entry.grade, grader: entry.grader) == key
        }
        return match?.resolvedMarketValue
    }

    private func holdingGradeKey(for card: InventoryCard) -> String {
        if let company = card.gradeCompany?.trimmingCharacters(in: .whitespaces),
           let value = card.gradeValue,
           company.isEmpty == false {
            let valueStr = value.truncatingRemainder(dividingBy: 1) == 0
                ? String(format: "%.0f", value)
                : String(format: "%.1f", value)
            return GradePillPanel.normalizedKey(grade: valueStr, grader: company)
        }
        return "raw"
    }

    private func userFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIError, let description = apiError.errorDescription {
            return description
        }

        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }

    func refresh() async {
        // CF-CANCELLATION-FIX (2026-07-12): see load() — detached
        // Task so the pending-review call outlives this coroutine.
        Task { await fetchPendingReview() }
        await fetch(preserveExistingSummaryOnError: true)
        // 2026-07-18: pull-to-refresh bypasses the server Redis via
        // freshCompute so the user sees fresh canonical FMV.
        Task { await refreshCanonicalFmvCache(forceRefresh: true) }
    }

    /// Reload the holdings list straight from `LocalPortfolioProvider`
    /// (already patched by the edit path's `save()`). Skips the backend
    /// re-fetch so an edit is reflected on the list immediately, even
    /// while backend eventual consistency catches up. The next natural
    /// `refresh()` (pull-to-refresh, tab reappear) reconciles with
    /// authoritative data.
    func applyLocalHoldingsUpdate() async {
        let cached = await LocalPortfolioProvider.shared.getInventory()
        inventoryCards = cached
        summary = Self.composeSummary(
            backendSummary: nil,
            holdings: cached,
            userId: resolvedUserId()
        )
    }

    func removeHolding(_ card: InventoryCard) async -> Bool {
        let userId = resolvedUserId()
        let currentInventory = inventoryCards.isEmpty ? await LocalPortfolioProvider.shared.getInventory() : inventoryCards
        let remaining = currentInventory.filter { $0.id != card.id }

        inventoryCards = remaining
        summary = Self.composeSummary(
            backendSummary: nil,
            holdings: remaining,
            userId: userId
        )
        await LocalPortfolioProvider.shared.saveInventory(remaining)

        do {
            _ = try await service.removePortfolioHolding(userId: userId, cardId: card.id.uuidString)
            return true
        } catch {
            errorMessage = "Removed from this device. Live portfolio sync failed."
            logger.error("Remove holding sync failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return true
        }
    }

    func markHoldingSold(
        _ card: InventoryCard,
        salePrice: Double,
        fees: Double,
        date: Date,
        notes: String? = nil,
        salesChannel: String? = nil,
        channelNote: String? = nil,
        paymentMethod: String? = nil,
        paymentNote: String? = nil,
        saleLocation: PortfolioIQSaleLocation? = nil
    ) async -> Bool {
        let userId = resolvedUserId()

        do {
            _ = try await service.markPortfolioHoldingSold(
                userId: userId,
                cardId: card.id.uuidString,
                salePrice: salePrice,
                fees: fees,
                date: date,
                notes: notes,
                salesChannel: salesChannel,
                channelNote: channelNote,
                paymentMethod: paymentMethod,
                paymentNote: paymentNote,
                saleLocation: saleLocation
            )
            await PortfolioService(provider: LocalPortfolioProvider.shared).markCardAsSold(
                card: card,
                salePrice: salePrice,
                fees: fees,
                date: date
            )
            await fetch(preserveExistingSummaryOnError: true)
            #if DEBUG
            print("[Financials] posting .portfolioSaleRecorded for cardId=\(card.id.uuidString)")
            #endif
            NotificationCenter.default.post(name: .portfolioSaleRecorded, object: nil)
            return true
        } catch {
            // CF-SELL-TRACKING (2026-07-11): backend returns a structured
            // 400 with an `error` key when validation fails (e.g. an
            // "other" channel/payment missing its required note, or an
            // invalid channel enum). Surface that so the sheet can show
            // a real reason instead of the "updated cache" fallback,
            // which would silently mask a bad payload.
            if let message = APIService.validationErrorMessage(from: error) {
                errorMessage = message
                logger.error("Mark sold rejected by backend for \(card.id.uuidString, privacy: .public): \(message, privacy: .public)")
                #if DEBUG
                print("[Financials] mark-sold VALIDATION error: \(message)")
                #endif
                return false
            }
            #if DEBUG
            print("[Financials] mark-sold BACKEND error (falling back to local cache): \(APIService.errorMessage(from: error))")
            #endif
            await PortfolioService(provider: LocalPortfolioProvider.shared).markCardAsSold(
                card: card,
                salePrice: salePrice,
                fees: fees,
                date: date
            )
            await fetch(preserveExistingSummaryOnError: true)
            errorMessage = "Live sale save failed. Updated cached inventory instead."
            logger.error("Mark sold sync failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func previewEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> PortfolioEbayListingResponse? {
        await submitEbayListing(
            card: card,
            request: request,
            pathKind: .draft
        )
    }

    func publishEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> PortfolioEbayListingResponse? {
        await submitEbayListing(
            card: card,
            request: request,
            pathKind: .listing
        )
    }

    func createEbayListing(for card: InventoryCard, request: PortfolioEbayListingRequest) async -> Bool {
        guard let response = await publishEbayListing(for: card, request: request) else { return false }
        return response.success ?? true
    }

    func uploadCardPhoto(
        for card: InventoryCard,
        image: UIImage,
        side: CardPhotoSide
    ) async -> CardPhotoUploadResponse? {
        guard let payload = CardPhotoFormat.payload(for: image) else {
            errorMessage = "Could not process that photo."
            return nil
        }

        do {
            let sasResponse = try await APIService.shared.requestCardPhotoSAS(fileExtension: "jpg")
            guard let uploadUrl = sasResponse.uploadUrl, let blobUrl = sasResponse.blobUrl else {
                errorMessage = "Server did not return upload URLs."
                return nil
            }
            try await APIService.shared.uploadImageToSAS(
                uploadUrl: uploadUrl,
                imageData: payload.data,
                contentType: sasResponse.contentType ?? "image/jpeg"
            )
            let response = CardPhotoUploadResponse(sasUrl: blobUrl)

            let updatedCard = InventoryCard(
                id: card.id,
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                status: card.status,
                year: card.year,
                setName: card.setName,
                parallel: card.parallel,
                grade: card.grade,
                gradeCompany: card.gradeCompany,
                gradeValue: card.gradeValue,
                purchaseDate: card.purchaseDate,
                purchasePlatform: card.purchasePlatform,
                quantity: card.quantity,
                notes: card.notes,
                imageFrontUrl: side == .front ? response.resolvedURL : card.imageFrontUrl,
                imageBackUrl: side == .back ? response.resolvedURL : card.imageBackUrl,
                lowValue: card.lowValue,
                highValue: card.highValue,
                confidence: card.confidence,
                method: card.method,
                summary: card.summary,
                isAuto: card.isAuto,
                photos: card.photos,
                clientId: card.clientId,
                fairMarketValue: card.fairMarketValue,
                valuationStatus: card.valuationStatus
            )

            let currentInventory = inventoryCards.isEmpty ? await LocalPortfolioProvider.shared.getInventory() : inventoryCards
            let updatedInventory = currentInventory.map { $0.id == card.id ? updatedCard : $0 }
            inventoryCards = updatedInventory
            await LocalPortfolioProvider.shared.saveInventory(updatedInventory)
            return response
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            logger.error("Card photo upload failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private enum EbayListingPathKind {
        case draft
        case listing
    }

    private func submitEbayListing(
        card: InventoryCard,
        request: PortfolioEbayListingRequest,
        pathKind: EbayListingPathKind
    ) async -> PortfolioEbayListingResponse? {
        let sessionId = resolvedSessionId()

        do {
            let response: PortfolioEbayListingResponse
            switch pathKind {
            case .draft:
                response = try await service.ebayPreviewListing(
                    body: request,
                    sessionId: sessionId
                )
            case .listing:
                response = try await service.ebayPublishListing(
                    body: request,
                    sessionId: sessionId
                )
            }

            if let message = response.message, message.isEmpty == false {
                errorMessage = message
            } else {
                errorMessage = nil
            }

            return response
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            logger.error("eBay listing request failed for \(card.id.uuidString, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    private func resolvedSessionId() -> String? {
        let candidates = [
            AuthService.shared.session?.token,
            UserDefaults.standard.string(forKey: "auth.sessionId")
        ]

        for candidate in candidates {
            let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if value.isEmpty == false {
                return value
            }
        }

        return nil
    }

    private func fetch(preserveExistingSummaryOnError: Bool) async {
        guard isLoading == false else { return }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let userId = resolvedUserId()
        let cachedHoldings = await LocalPortfolioProvider.shared.getInventory()
        let cachedSales = await LocalPortfolioProvider.shared.getSales()
        var fetchedHoldings: [InventoryCard] = cachedHoldings
        var backendSummary: PortfolioIQBackendSummaryResponse?
        var loadMessages: [String] = []
        var didLoadLiveHoldings = false

        if cachedHoldings.isEmpty == false, preserveExistingSummaryOnError == false || summary == nil {
            inventoryCards = cachedHoldings
            summary = Self.composeSummary(
                backendSummary: nil,
                holdings: cachedHoldings,
                userId: userId
            )
        }

        do {
            let liveHoldings = try await service.fetchPortfolioHoldings(userId: userId)
            didLoadLiveHoldings = true
            // Backend is the authoritative source. The previous "union
            // cached-only items" guard was removed (CF 2026-06-28): it
            // hid sync bugs by surfacing stale local-only items. Refresh
            // now mirrors the backend's holdings list verbatim, and the
            // local cache is overwritten on success so the next launch
            // starts from a clean snapshot. Live-empty guard remains so
            // a transient empty response doesn't wipe a non-empty list.
            if liveHoldings.isEmpty, preserveExistingSummaryOnError, !inventoryCards.isEmpty {
                loadMessages.append("Live data returned empty. Keeping your current inventory.")
            } else {
                fetchedHoldings = liveHoldings
                await LocalPortfolioProvider.shared.saveInventory(liveHoldings)
            }
            // Derive summary from holdings instead of separate API call
            let totalCost = fetchedHoldings.reduce(0) { $0 + $1.cost }
            let totalValue = fetchedHoldings.reduce(0) { $0 + $1.currentValue }
            let totalPL = totalValue - totalCost
            let roi = totalCost > 0 ? (totalPL / totalCost) * 100 : 0
            backendSummary = PortfolioIQBackendSummaryResponse(
                inventory: PortfolioInventorySummary(
                    totalCost: totalCost,
                    totalCurrentValue: totalValue,
                    totalProfitLoss: totalPL,
                    roi: roi,
                    activeCount: fetchedHoldings.count
                ),
                month: nil,
                year: nil
            )
        } catch is CancellationError {
            // The fetch task was cancelled (typically by SwiftUI's .refreshable
            // closure or a view re-render). This is not a user-facing failure —
            // a fresh load will be triggered by the next onAppear / refreshable
            // gesture. Do NOT append a "live holdings unavailable" message: it
            // surfaces a banner for what is, semantically, a no-op.
            logger.info("Portfolio holdings fetch cancelled (cooperative cancellation, not a failure).")
        } catch {
            logger.error("Portfolio holdings load failed: \(error.localizedDescription, privacy: .public)")
            if cachedHoldings.isEmpty {
                fetchedHoldings = await LocalPortfolioProvider.shared.getInventory()
            }
            loadMessages.append("Live holdings unavailable. Showing cached portfolio data.")
        }

        if fetchedHoldings.isEmpty {
            // During refresh, don't wipe existing inventory if we already have cards
            if preserveExistingSummaryOnError, !inventoryCards.isEmpty {
                salesHistory = cachedSales
                if loadMessages.isEmpty == false {
                    errorMessage = loadMessages.joined(separator: " ")
                }
                return
            }
            inventoryCards = []
            salesHistory = cachedSales
            summary = Self.composeSummary(
                backendSummary: backendSummary,
                holdings: [],
                userId: userId
            )
            if didLoadLiveHoldings == false {
                if preserveExistingSummaryOnError == false {
                    errorMessage = loadMessages.isEmpty ? "Could not load PortfolioIQ right now." : loadMessages.joined(separator: " ")
                } else if loadMessages.isEmpty == false {
                    errorMessage = loadMessages.joined(separator: " ")
                }
            } else if loadMessages.isEmpty == false {
                errorMessage = loadMessages.joined(separator: " ")
            }
            return
        }

        inventoryCards = fetchedHoldings
        salesHistory = cachedSales
        summary = Self.composeSummary(
            backendSummary: backendSummary,
            holdings: fetchedHoldings,
            userId: userId
        )

        if loadMessages.isEmpty == false {
            errorMessage = loadMessages.joined(separator: " ")
        }

        // P0.7 (2026-07-16): kick off the batch flips fetch after the
        // inventory list settles. Detached so a slow /flips call doesn't
        // hold up the rest of the load — the dot appears when the network
        // returns, matches the spec's 15-min refresh cadence.
        Task { await self.loadRecentFlips() }

        // Corpus signals (2026-07-17): portfolio-wide grade-worthy scan
        // fires alongside the flips batch. Both are best-effort — hidden
        // banner on failure, no user-visible error.
        Task { await self.loadGradeWorthyAlerts() }

        // Corpus signals (2026-07-17, PR #517): pre-warm per-player
        // trends for every holding's player so inventory rows render
        // arrows without a per-row fetch delay. Detached, best-effort.
        Task { await self.preloadPlayerTrends() }
    }

    /// Look up the most recent 14-day flip for a given holding. Returns
    /// nil when no fresh flip exists (which suppresses the inventory-row
    /// dot). Match key is `lowercase + spaces→hyphens` — the closest
    /// parseable approximation of backend's normalization.
    func recentFlip(for card: InventoryCard) -> VerdictFlip? {
        let key = Self.normalizedPlayerKey(card.playerName)
        guard key.isEmpty == false else { return nil }
        return recentFlipsByPlayer[key]
    }

    /// P0.7 (2026-07-16): fetches the 7-day flip window for every unique
    /// player in the current inventory. Batches by 200 (spec cap). Silently
    /// swallows failures — the dot is nice-to-have, never blocks the row.
    func loadRecentFlips() async {
        let players = Set(inventoryCards.map { $0.playerName })
            .compactMap { name -> String? in
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
        guard players.isEmpty == false else {
            recentFlipsByPlayer = [:]
            return
        }

        var accumulated: [String: VerdictFlip] = [:]
        let chunks = stride(from: 0, to: players.count, by: 200).map {
            Array(players[$0..<min($0 + 200, players.count)])
        }

        for batch in chunks {
            do {
                let response = try await service.fetchPortfolioFlips(players: batch, days: 7)
                for flip in response.flips ?? [] {
                    let key = Self.normalizedPlayerKey(flip.player ?? "")
                    guard key.isEmpty == false else { continue }
                    // Backend returns newest-first — keep the first, skip
                    // older flips for the same player.
                    if accumulated[key] == nil {
                        accumulated[key] = flip
                    }
                }
            } catch {
                logger.info("Portfolio flips fetch failed (best-effort): \(error.localizedDescription, privacy: .public)")
            }
        }

        recentFlipsByPlayer = accumulated
    }

    /// Backend normalizes display names to lowercase-hyphenated per
    /// verdict-history-flip-surfaces.md. Match that here so per-card
    /// lookups align with the wire keys.
    static func normalizedPlayerKey(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
           .lowercased()
           .replacingOccurrences(of: " ", with: "-")
    }

    // MARK: - Corpus signals (2026-07-17)

    /// Row-level lookup of the cached player trend. Nil when the trend
    /// hasn't been fetched yet (returned entries populate after
    /// `preloadPlayerTrends()`) or the entry is stale (>12h).
    func playerTrend(for card: InventoryCard) -> PlayerTrendResponse? {
        let key = Self.normalizedPlayerKey(card.playerName)
        guard let cached = playerTrendsByPlayer[key] else { return nil }
        // Session cache expires at 12h per the spec — treat older
        // entries as absent so callers re-fetch on next tap.
        if let age = cached.ageHours, age > 12 { return nil }
        return cached
    }

    /// Fire-and-forget trend fetch for every unique player in the
    /// current inventory. Dedupes per-name so a 200-holding portfolio
    /// with 15 distinct players issues only 15 requests. In-flight
    /// requests are skipped so a repeat call within the same session
    /// doesn't re-fire. Backend serves from `nightly_cache` (millisecond
    /// hits) so the fan-out is cheap.
    func preloadPlayerTrends() async {
        let uniquePlayers: Set<String> = Set(
            inventoryCards
                .map { $0.playerName.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.isEmpty == false }
        )
        for player in uniquePlayers {
            let key = Self.normalizedPlayerKey(player)
            if playerTrendFetchesInFlight.contains(key) { continue }
            if let existing = playerTrendsByPlayer[key],
               let age = existing.ageHours, age <= 12 {
                continue
            }
            playerTrendFetchesInFlight.insert(key)
            do {
                let response = try await service.fetchPlayerTrend(player: player)
                playerTrendsByPlayer[key] = response
            } catch {
                // Best-effort — leave the last-known snapshot in place.
                logger.info("Player trend fetch failed for \(player, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
            playerTrendFetchesInFlight.remove(key)
        }
    }

    /// PR #518: portfolio-wide grade-worthy scan. Populates
    /// `gradeWorthyAlerts` (and hides the banner if the count is zero
    /// or the fetch fails).
    func loadGradeWorthyAlerts() async {
        do {
            gradeWorthyAlerts = try await service.fetchGradeWorthyAlerts()
        } catch {
            logger.info("Grade-worthy alerts fetch failed (best-effort): \(error.localizedDescription, privacy: .public)")
            // Preserve the last-known good response on failure so a
            // transient network blip doesn't collapse the banner.
        }
    }

    private func resolvedUserId() -> String {
        (AuthService.shared.userId ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func composeSummary(
        backendSummary: PortfolioIQBackendSummaryResponse?,
        holdings: [InventoryCard],
        userId: String
    ) -> PortfolioSummaryResponse {
        let totalCost = holdings.reduce(0) { $0 + $1.cost }
        let totalValue = holdings.reduce(0) { $0 + $1.currentValue }
        let totalProfitLoss = totalValue - totalCost
        let roi = totalCost > 0 ? (totalProfitLoss / totalCost) * 100 : 0

        let inventory = backendSummary?.inventory ?? PortfolioInventorySummary(
            totalCost: totalCost,
            totalCurrentValue: totalValue,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            activeCount: holdings.count
        )

        let accountSnapshot = PortfolioAccountSnapshot(
            userId: userId,
            totalCards: holdings.count,
            totalValue: totalValue,
            totalCost: totalCost,
            totalProfitLoss: totalProfitLoss,
            roi: roi,
            generatedAt: ISO8601DateFormatter().string(from: .now)
        )

        let inventoryDetails = holdings.enumerated().map { index, card in
            PortfolioCardDetail(
                id: "\(index)-\(card.id.uuidString)",
                playerName: card.playerName,
                cardName: card.cardName,
                cost: card.cost,
                currentValue: card.currentValue,
                profitLoss: card.profitLoss,
                roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                purchasePlatform: card.purchasePlatform,
                notes: card.notes,
                lastPricedAt: card.purchaseDate,
                signal: card.profitLoss >= 0 ? "hold" : "sell",
                format: card.grade.isEmpty ? nil : card.grade,
                sellReason: card.summary
            )
        }

        let bestCardsToSellNow = holdings
            .sorted { $0.profitLoss < $1.profitLoss }
            .prefix(3)
            .enumerated()
            .map { index, card in
                PortfolioBestSellCard(
                    id: "best-\(index)-\(card.id.uuidString)",
                    playerName: card.playerName,
                    cardName: card.cardName,
                    cost: card.cost,
                    currentValue: card.currentValue,
                    profitLoss: card.profitLoss,
                    roi: card.cost > 0 ? (card.profitLoss / card.cost) * 100 : 0,
                    signal: card.profitLoss >= 0 ? "hold" : "sell",
                    format: card.grade.isEmpty ? nil : card.grade,
                    recommendation: card.profitLoss >= 0 ? "Hold for now." : "Consider trimming."
                )
            }

        return PortfolioSummaryResponse(
            inventory: inventory,
            accountSnapshot: accountSnapshot,
            inventoryDetails: inventoryDetails,
            bestCardsToSellNow: bestCardsToSellNow,
            month: backendSummary?.month,
            year: backendSummary?.year
        )
    }
}
