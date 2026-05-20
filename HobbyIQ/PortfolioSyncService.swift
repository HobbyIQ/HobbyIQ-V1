// PortfolioSyncService.swift
// HobbyIQ — PR B.5 concurrency spike.
//
// Minimal sync skeleton proving the actor isolation model compiles
// cleanly under strict Swift 6 concurrency BEFORE PR C builds the
// full sync layer on top.
//
// What this file ships:
//   writePath(card:)  — CardItem → InventoryCard → APIService.addPortfolioHolding
//                       → write back serverHoldingId on local row
//   readPath()        — APIService.fetchPortfolioHoldings → upsert into ModelContext
//                       keyed by serverHoldingId first, falling back to clientId
//
// What this file does NOT ship (PR C scope):
//   - pendingSyncFields guard (prevents pull from clobbering local edits)
//   - SyncIntent @Model + queue
//   - Tombstones for soft-delete
//   - Working mapper implementations (fatalError stubs below)

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
    /// `card.serverHoldingId` and saves the context.
    ///
    /// - Note: This method does NOT guard against pending local edits.
    ///   PR C adds `pendingSyncFields` to prevent clobbering in-flight changes.
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

        card.updatedAt = Date()
        try modelContext.save()
    }

    // MARK: - Read path

    /// Fetches all holdings from the backend and upserts them into SwiftData.
    /// Upsert key priority: serverHoldingId first, then clientId.
    ///
    /// - Note: For the spike, this uses simple last-write-wins.
    ///   PR C adds `pendingSyncFields` guard to prevent the pull from
    ///   overwriting user-authoritative fields that have unsaved local edits.
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
                existing.serverHoldingId = serverId
                Self.updateCardItem(existing, from: holding)
                return
            }
        }

        // No match — insert new
        let newCard = Self.mapHoldingToNewCardItem(holding)
        modelContext.insert(newCard)
    }

    // MARK: - Mappers
    //
    // These are stubbed with fatalError for the spike. PR C implements
    // real mapping once the field-by-field decisions are finalized.

    /// Maps a local CardItem to the InventoryCard wire type for POST.
    static func mapCardItemToHolding(_ card: CardItem) -> InventoryCard {
        // Wire mapping: CardItem (SwiftData) → InventoryCard (Codable wire type)
        //
        // The InventoryCard init has defaults for most fields, so we map
        // what CardItem actually tracks.
        InventoryCard(
            playerName: card.playerName,
            cardName: card.cardTitle.isEmpty ? card.playerName : card.cardTitle,
            cost: card.purchasePrice,
            currentValue: card.currentValue,
            status: card.status,
            year: card.year.map(String.init) ?? "",
            setName: card.setName,
            parallel: card.parallel,
            grade: card.grade,
            notes: card.notes.isEmpty ? nil : card.notes,
            isAuto: card.isAuto,
            clientId: card.clientId
        )
    }

    /// Builds a new CardItem from a server-side InventoryCard holding.
    static func mapHoldingToNewCardItem(_ holding: InventoryCard) -> CardItem {
        let card = CardItem(
            playerName: holding.playerName,
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
        return card
    }

    /// Updates server-authoritative fields on an existing CardItem from a holding.
    ///
    /// For the spike, this does simple last-write-wins on all fields.
    /// PR C adds a `pendingSyncFields` guard: user-authoritative fields
    /// (purchasePrice, photos, notes) are NOT overwritten when the local
    /// row has unsaved edits.
    static func updateCardItem(_ card: CardItem, from holding: InventoryCard) {
        // Server-authoritative fields — always overwrite
        card.currentValue = holding.currentValue
        card.serverHoldingId = holding.id.uuidString

        // TODO: PR C — guard user-authoritative fields behind pendingSyncFields.
        // For the spike, last-write-wins on everything:
        card.playerName = holding.playerName
        card.cardTitle = holding.cardName
        card.purchasePrice = holding.cost
        card.status = holding.status
        card.year = Int(holding.year)
        card.setName = holding.setName
        card.parallel = holding.parallel
        card.grade = holding.grade
        card.isAuto = holding.isAuto
        card.notes = holding.notes ?? ""

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
