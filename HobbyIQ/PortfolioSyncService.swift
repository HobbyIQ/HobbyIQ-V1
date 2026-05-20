// PortfolioSyncService.swift
// HobbyIQ — portfolio sync service for offline-first card management.
//
// Architecture:
//   writePath(card:)  — CardItem → InventoryCard → APIService.addPortfolioHolding
//                       → write back serverHoldingId on local row
//   readPath()        — APIService.fetchPortfolioHoldings → upsert into ModelContext
//                       keyed by serverHoldingId first, falling back to clientId

import Foundation
import SwiftData

// MARK: - PortfolioSyncService

/// @MainActor because the ModelContext delivered via @Environment(\.modelContext)
/// is main-actor-isolated in SwiftData's default configuration.
/// APIService is a value-type struct (implicitly Sendable), so its async methods
/// can be awaited from the main actor without isolation issues.
@MainActor
final class PortfolioSyncService {
    private let modelContext: ModelContext
    private let apiService: APIService

    init(modelContext: ModelContext, apiService: APIService) {
        self.modelContext = modelContext
        self.apiService = apiService
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
