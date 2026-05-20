// InventoryRefreshService.swift
// Refreshes CompIQ predicted market values for every owned card in the
// inventory. Each card is gated by a 6-hour cooldown (based on
// `updatedAt`) so we never pound the MCP server or eBay/Card Hedge APIs.
//
// Used by CardDashboardView and CardInventoryView in three places:
//   .task         — silent background refresh when a view appears, plus a
//                   periodic re-check loop while the view stays alive.
//   .refreshable  — pull-to-refresh forces a refresh of every stale card
//                   (still respects the 6h cooldown).
//   runPeriodic   — drives the recurring tick used inside .task.

import Foundation
import SwiftData
import Combine

@MainActor
final class InventoryRefreshService: ObservableObject {

    /// Shared instance so SwiftUI views can observe `lastRunAt` for a
    /// "Refreshed Xm ago" badge without each view holding its own state.
    static let shared = InventoryRefreshService()

    /// Timestamp of the last completed refresh pass (any cards updated or not).
    @Published private(set) var lastRunAt: Date? = nil

    /// True while a refresh pass is in flight. Drives UI spinners.
    @Published private(set) var isRefreshing: Bool = false

    /// Minimum time between automatic refreshes of the same card.
    static let cooldown: TimeInterval = 6 * 60 * 60   // 6 hours

    /// How often the periodic loop wakes up to look for stale cards.
    /// Cheap — does nothing unless at least one card crossed the cooldown.
    static let periodicInterval: TimeInterval = 30 * 60   // 30 min

    /// Maximum number of CompIQ fetches in flight at the same time.
    /// Keeps us well under eBay/OpenAI rate limits and avoids burst-throttling.
    private static let maxConcurrent = 3

    /// In-flight guard so a fast tab-switch doesn't kick off two passes.
    private static var refreshTask: Task<Void, Never>?

    /// Refresh every card whose `updatedAt` is older than `cooldown`.
    /// - Parameter cards: full owned inventory.
    /// - Parameter context: SwiftData context used to persist new values.
    /// - Parameter force: when true, ignore the per-card cooldown
    ///                    (used by pull-to-refresh).
    static func refreshStaleCards(_ cards: [CardItem], context: ModelContext, force: Bool = false) async {
        // De-dupe concurrent runs — if a refresh is already in flight, just await it.
        if let existing = refreshTask {
            await existing.value
            if !force { return }
        }

        shared.isRefreshing = true
        let task = Task { @MainActor in
            await runRefresh(cards: cards, context: context, force: force)
        }
        refreshTask = task
        await task.value
        refreshTask = nil
        shared.isRefreshing = false
        shared.lastRunAt = Date()
    }

    /// Long-running loop intended to be hosted by a SwiftUI `.task { ... }`.
    /// Runs an initial refresh on entry, then re-checks for stale cards every
    /// `periodicInterval`. When the hosting view disappears, SwiftUI cancels
    /// the Task and the loop terminates automatically.
    ///
    /// Always uses cooldown gating (never `force`), so this is safe to call
    /// from multiple views — overlapping calls de-dupe via `refreshTask`.
    static func runPeriodic(
        cardsProvider: @escaping @MainActor () -> [CardItem],
        context: ModelContext
    ) async {
        // Initial pass.
        await refreshStaleCards(cardsProvider(), context: context)

        // Tick until cancelled by the SwiftUI lifecycle.
        while !Task.isCancelled {
            do {
                try await Task.sleep(nanoseconds: UInt64(periodicInterval * 1_000_000_000))
            } catch {
                return // cancelled
            }
            if Task.isCancelled { return }
            await refreshStaleCards(cardsProvider(), context: context)
        }
    }

    private static func runRefresh(cards: [CardItem], context: ModelContext, force: Bool) async {
        let now = Date()
        let stale = cards.filter { card in
            // Skip sold cards entirely.
            guard !card.isSold else { return false }
            // Need at least a player name for CompIQ.
            guard !card.playerName.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
            if force { return true }
            return now.timeIntervalSince(card.updatedAt) >= cooldown
        }

        guard !stale.isEmpty else { return }

        // Bounded concurrency with a TaskGroup.
        await withTaskGroup(of: Void.self) { group in
            var iterator = stale.makeIterator()
            var inFlight = 0

            // Prime the pump.
            while inFlight < maxConcurrent, let card = iterator.next() {
                group.addTask { await refreshOne(card) }
                inFlight += 1
            }

            // As each task finishes, queue the next one.
            for await _ in group {
                if let card = iterator.next() {
                    group.addTask { await refreshOne(card) }
                }
            }
        }

        // Persist all the in-place mutations applied by refreshOne().
        do { try context.save() } catch {
            print("[InventoryRefresh] save failed: \(error)")
        }
    }

    /// Fetch one card's predicted price and update its model in place.
    /// Failures are swallowed (logged) so one bad card never blocks the others.
    private static func refreshOne(_ card: CardItem) async {
        do {
            let result = try await CompIQService.fetchMarketValue(
                playerName: card.playerName,
                year: card.year,
                setName: card.setName,
                cardNumber: card.cardNumber,
                parallel: card.parallel,
                isAuto: card.isAuto,
                isRaw: card.isRaw,
                gradingCompany: card.gradingCompany,
                grade: card.grade
            )
            await MainActor.run {
                card.currentValue = result.nextSaleEstimate
                card.updatedAt = Date()
            }
        } catch {
            // Bump updatedAt anyway on a soft error so we don't immediately retry
            // a card that has no comps. Hard network errors fall through and will
            // be retried on the next pass (since updatedAt isn't bumped).
            switch error {
            case CompIQServiceError.noEstimateReturned,
                 CompIQServiceError.insufficientWithComps(_):
                await MainActor.run { card.updatedAt = Date() }
            default:
                break
            }
            print("[InventoryRefresh] \(card.playerName): \(error.localizedDescription)")
        }
    }
}
