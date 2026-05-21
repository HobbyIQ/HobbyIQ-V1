// PortfolioSyncService.swift
// HobbyIQ — portfolio sync service for offline-first card management.
//
// Architecture:
//   writePath(card:)  — CardItem → InventoryCard → APIService.addPortfolioHolding
//                       → write back serverHoldingId on local row
//   readPath()        — APIService.fetchPortfolioHoldings → upsert into ModelContext
//                       keyed by serverHoldingId first, falling back to clientId

import Foundation
import Observation
import SwiftData

// MARK: - PortfolioSyncService

/// @MainActor because the ModelContext delivered via @Environment(\.modelContext)
/// is main-actor-isolated in SwiftData's default configuration.
/// APIService is a value-type struct (implicitly Sendable), so its async methods
/// can be awaited from the main actor without isolation issues.
@MainActor
@Observable
final class PortfolioSyncService {
    private let modelContext: ModelContext
    private let apiService: APIService

    /// Whether the sync service is actively processing.
    private(set) var isSyncing = false

    /// Last error from a sync operation (cleared on next successful sync).
    private(set) var lastSyncError: String?

    /// Timestamp of last successful full sync (read + queue drain).
    private(set) var lastSyncDate: Date?

    init(modelContext: ModelContext, apiService: APIService) {
        self.modelContext = modelContext
        self.apiService = apiService
    }

    // MARK: - Auth-aware sync

    /// Whether the user is authenticated and sync can proceed.
    var isAuthenticated: Bool {
        AuthService.shared.isLoggedIn
    }

    /// Runs a full sync cycle: read path → process queue.
    /// No-ops if not authenticated. Safe to call repeatedly.
    func sync() async {
        guard isAuthenticated else {
            lastSyncError = PortfolioSyncError.notAuthenticated.localizedDescription
            return
        }

        isSyncing = true
        lastSyncError = nil

        do {
            try await readPath()
            try await processQueue()
            lastSyncDate = Date()
        } catch {
            lastSyncError = error.localizedDescription
        }

        isSyncing = false
    }

    /// Called when the user signs in — triggers an initial sync.
    func onSignIn() async {
        await sync()
    }

    /// Called when the user signs out — resets sync state.
    func onSignOut() {
        isSyncing = false
        lastSyncError = nil
        lastSyncDate = nil
    }

    // MARK: - Write path

    /// Pushes a local CardItem to the backend as a new holding.
    /// On success, writes the server-assigned holding ID back to
    /// `card.serverHoldingId`, clears `pendingSyncFields`, and saves.
    func writePath(card: CardItem) async throws {
        // Ensure clientId exists before sending to server
        if card.clientId == nil {
            card.clientId = UUID().uuidString
        }

        let holdingPayload = Self.mapCardItemToHolding(card)
        let result = try await apiService.addPortfolioHolding(holdingPayload)

        // Write back the server-assigned ID
        if let serverId = result.id {
            card.serverHoldingId = serverId
        } else if let returnedHolding = result.holding {
            card.serverHoldingId = returnedHolding.id.uuidString
        }

        card.pendingSyncFields = []
        card.updatedAt = Date()
        try modelContext.save()
    }

    // MARK: - Read path

    /// Fetches all holdings from the backend and upserts them into SwiftData.
    /// Upsert key priority: serverHoldingId first, then clientId.
    /// Respects `pendingSyncFields` — fields with pending local edits
    /// are NOT overwritten by the server value.
    func readPath() async throws {
        let holdings = try await apiService.fetchPortfolioHoldings()

        for holding in holdings {
            try upsert(holding: holding)
        }

        try modelContext.save()
    }

    // MARK: - Upsert helper

    private func upsert(holding: InventoryCard) throws {
        let serverId = holding.id.uuidString

        // First: try to match by serverHoldingId
        let byServerPredicate = #Predicate<CardItem> { item in
            item.serverHoldingId == serverId
        }
        var descriptor = FetchDescriptor<CardItem>(predicate: byServerPredicate)
        descriptor.fetchLimit = 1
        let byServer = try modelContext.fetch(descriptor)

        if let existing = byServer.first {
            // Skip soft-deleted rows — the delete intent will handle cleanup
            guard !existing.isDeleted else { return }
            Self.updateCardItem(existing, from: holding)
            return
        }

        // Second: try to match by clientId
        if let holdingClientId = holding.clientId {
            let byClientPredicate = #Predicate<CardItem> { item in
                item.clientId == holdingClientId
            }
            var clientDescriptor = FetchDescriptor<CardItem>(predicate: byClientPredicate)
            clientDescriptor.fetchLimit = 1
            let byClient = try modelContext.fetch(clientDescriptor)

            if let existing = byClient.first {
                guard !existing.isDeleted else { return }
                existing.serverHoldingId = serverId
                Self.updateCardItem(existing, from: holding)
                return
            }
        }

        // No match — check if we have a tombstone for this server ID
        // (card was deleted locally but server still returns it).
        // In that case, do NOT re-insert — the delete intent will clean up.
        let tombstonePredicate = #Predicate<CardItem> { item in
            item.serverHoldingId == serverId && item.deletedAt != nil
        }
        var tombstoneDescriptor = FetchDescriptor<CardItem>(predicate: tombstonePredicate)
        tombstoneDescriptor.fetchLimit = 1
        let tombstones = try modelContext.fetch(tombstoneDescriptor)
        guard tombstones.isEmpty else { return }

        // No match, no tombstone — insert new
        let newCard = Self.mapHoldingToNewCardItem(holding)
        modelContext.insert(newCard)
    }

    // MARK: - Mappers

    /// Maps a local CardItem to the InventoryCard wire type for POST/PATCH.
    static func mapCardItemToHolding(_ card: CardItem) -> InventoryCard {
        InventoryCard(
            playerName: card.playerName,
            cardName: card.cardTitle.isEmpty ? card.playerName : card.cardTitle,
            cost: card.purchasePrice,
            currentValue: card.currentValue,
            status: card.status,
            year: card.year.map(String.init) ?? "",
            setName: card.setName,
            parallel: card.parallel,
            grade: card.isRaw ? "" : card.grade,
            notes: card.notes.isEmpty ? nil : card.notes,
            isAuto: card.isAuto,
            photos: card.photoURLs.isEmpty ? nil : card.photoURLs,
            clientId: card.clientId
        )
    }

    /// Builds a new CardItem from a server-side InventoryCard holding.
    static func mapHoldingToNewCardItem(_ holding: InventoryCard) -> CardItem {
        let card = CardItem(
            playerName: holding.playerName,
            isRaw: holding.grade.isEmpty,
            cardTitle: holding.cardName,
            year: Int(holding.year),
            setName: holding.setName,
            parallel: holding.parallel,
            isAuto: holding.isAuto,
            grade: holding.grade,
            purchasePrice: holding.cost,
            currentValue: holding.currentValue,
            status: holding.status,
            notes: holding.notes ?? "",
            clientId: holding.clientId
        )
        card.serverHoldingId = holding.id.uuidString
        card.photoURLs = holding.photos ?? []
        return card
    }

    /// Updates an existing CardItem from a server holding.
    ///
    /// Server-authoritative fields (currentValue, serverHoldingId) are always
    /// overwritten. User-authoritative fields are guarded by `pendingSyncFields`:
    /// if a field name is in the set, the local value takes precedence.
    static func updateCardItem(_ card: CardItem, from holding: InventoryCard) {
        // Server-authoritative — always overwrite
        card.currentValue = holding.currentValue
        card.serverHoldingId = holding.id.uuidString

        let pending = Set(card.pendingSyncFields)

        // User-authoritative — skip if locally edited
        if !pending.contains("playerName")   { card.playerName = holding.playerName }
        if !pending.contains("cardTitle")    { card.cardTitle = holding.cardName }
        if !pending.contains("purchasePrice"){ card.purchasePrice = holding.cost }
        if !pending.contains("status")       { card.status = holding.status }
        if !pending.contains("year")         { card.year = Int(holding.year) }
        if !pending.contains("setName")      { card.setName = holding.setName }
        if !pending.contains("parallel")     { card.parallel = holding.parallel }
        if !pending.contains("grade") {
            card.grade = holding.grade
            card.isRaw = holding.grade.isEmpty
        }
        if !pending.contains("isAuto")       { card.isAuto = holding.isAuto }
        if !pending.contains("notes")        { card.notes = holding.notes ?? "" }
        if !pending.contains("photoURLs")    { card.photoURLs = holding.photos ?? [] }

        card.updatedAt = Date()
    }

    // MARK: - Intent enqueuing

    /// Enqueues a create intent for a newly added card.
    func enqueueCreate(card: CardItem) throws {
        if card.clientId == nil {
            card.clientId = UUID().uuidString
        }
        let intent = SyncIntent(
            action: .create,
            cardClientId: card.clientId!
        )
        modelContext.insert(intent)
        try modelContext.save()
    }

    /// Enqueues an update intent for a locally edited card.
    func enqueueUpdate(card: CardItem) throws {
        guard let serverId = card.serverHoldingId else {
            // Card hasn't been pushed yet — the existing create intent covers it
            return
        }
        // Coalesce: if a pending update intent already exists, skip
        let clientId = card.clientId ?? ""
        let pendingPredicate = #Predicate<SyncIntent> { intent in
            intent.cardClientId == clientId
            && intent.action == "update"
            && intent.status == "pending"
        }
        var descriptor = FetchDescriptor<SyncIntent>(predicate: pendingPredicate)
        descriptor.fetchLimit = 1
        let existing = try modelContext.fetch(descriptor)
        guard existing.isEmpty else { return }

        let intent = SyncIntent(
            action: .update,
            cardClientId: clientId,
            serverHoldingId: serverId
        )
        modelContext.insert(intent)
        try modelContext.save()
    }

    /// Enqueues a delete intent and soft-deletes the card.
    func enqueueDelete(card: CardItem) throws {
        card.markDeleted()

        if let serverId = card.serverHoldingId {
            let intent = SyncIntent(
                action: .delete,
                cardClientId: card.clientId ?? "",
                serverHoldingId: serverId
            )
            modelContext.insert(intent)
        }
        // If no serverHoldingId, the card was never pushed — just remove
        // any pending create intent for it
        else if let clientId = card.clientId {
            let createPredicate = #Predicate<SyncIntent> { intent in
                intent.cardClientId == clientId && intent.action == "create"
            }
            let creates = try modelContext.fetch(FetchDescriptor<SyncIntent>(predicate: createPredicate))
            for create in creates {
                modelContext.delete(create)
            }
            modelContext.delete(card)
        }

        try modelContext.save()
    }

    // MARK: - Queue processor

    private static let maxRetries = 5

    /// Processes all pending SyncIntents in FIFO order.
    /// Returns the number of intents successfully processed.
    @discardableResult
    func processQueue() async throws -> Int {
        let pendingStatus = SyncIntentStatus.pending.rawValue
        let pendingPredicate = #Predicate<SyncIntent> { intent in
            intent.status == pendingStatus
        }
        var descriptor = FetchDescriptor<SyncIntent>(
            predicate: pendingPredicate,
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        descriptor.fetchLimit = 50

        let intents = try modelContext.fetch(descriptor)
        var processed = 0

        for intent in intents {
            do {
                intent.intentStatus = .inFlight
                intent.lastAttemptedAt = Date()

                try await processIntent(intent)

                // Success — remove the intent
                modelContext.delete(intent)
                processed += 1
            } catch {
                intent.retryCount += 1
                intent.lastError = error.localizedDescription

                if intent.retryCount >= Self.maxRetries {
                    intent.intentStatus = .failed
                } else {
                    intent.intentStatus = .pending
                }
            }
        }

        try modelContext.save()
        return processed
    }

    private func processIntent(_ intent: SyncIntent) async throws {
        switch intent.intentAction {
        case .create:
            try await processCreateIntent(intent)
        case .update:
            try await processUpdateIntent(intent)
        case .delete:
            try await processDeleteIntent(intent)
        }
    }

    private func processCreateIntent(_ intent: SyncIntent) async throws {
        let clientId = intent.cardClientId
        let predicate = #Predicate<CardItem> { item in
            item.clientId == clientId
        }
        var descriptor = FetchDescriptor<CardItem>(predicate: predicate)
        descriptor.fetchLimit = 1
        guard let card = try modelContext.fetch(descriptor).first else { return }

        let holdingPayload = Self.mapCardItemToHolding(card)
        let result = try await apiService.addPortfolioHolding(holdingPayload)

        if let serverId = result.id {
            card.serverHoldingId = serverId
        } else if let returnedHolding = result.holding {
            card.serverHoldingId = returnedHolding.id.uuidString
        }

        card.clearPendingSyncFields()
        card.updatedAt = Date()
    }

    private func processUpdateIntent(_ intent: SyncIntent) async throws {
        let clientId = intent.cardClientId
        let predicate = #Predicate<CardItem> { item in
            item.clientId == clientId
        }
        var descriptor = FetchDescriptor<CardItem>(predicate: predicate)
        descriptor.fetchLimit = 1
        guard let card = try modelContext.fetch(descriptor).first else { return }

        let holdingPayload = Self.mapCardItemToHolding(card)
        _ = try await apiService.updatePortfolioHolding(holdingPayload)

        card.clearPendingSyncFields()
        card.updatedAt = Date()
    }

    private func processDeleteIntent(_ intent: SyncIntent) async throws {
        guard let serverId = intent.serverHoldingId else { return }

        _ = try await apiService.deletePortfolioHolding(holdingId: serverId)

        // Clean up tombstone row
        let predicate = #Predicate<CardItem> { item in
            item.serverHoldingId == serverId
        }
        let tombstones = try modelContext.fetch(FetchDescriptor<CardItem>(predicate: predicate))
        for tombstone in tombstones {
            modelContext.delete(tombstone)
        }
    }
}

// MARK: - Errors

enum PortfolioSyncError: Error, LocalizedError {
    case notAuthenticated
    case serverRejected(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Sign in to sync your portfolio."
        case .serverRejected(let message):
            return "Server rejected the sync request: \(message)"
        }
    }
}
