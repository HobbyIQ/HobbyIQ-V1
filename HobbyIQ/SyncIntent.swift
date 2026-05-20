// SyncIntent.swift
// HobbyIQ — PR C.1: queued sync operations for offline-first portfolio sync.
//
// Each row represents a pending mutation that the SyncIntent queue processor
// (PR C.4) will replay against the backend in FIFO order.
//
// Lifecycle:
//   1. User edits/creates/deletes a CardItem → a SyncIntent is inserted.
//   2. Queue processor picks the oldest pending intent and executes it.
//   3. On success → intent is deleted.
//   4. On failure → retryCount increments; processor backs off.
//   5. After maxRetries → intent is marked .failed for manual resolution.

import Foundation
import SwiftData

// MARK: - SyncIntentAction

/// The type of mutation this intent represents.
enum SyncIntentAction: String, Codable {
    /// Push a new card to the backend (POST /api/portfolio/holdings).
    case create
    /// Push local edits to the backend (PATCH /api/portfolio/holdings/:id).
    case update
    /// Delete from backend (DELETE /api/portfolio/holdings/:id).
    case delete
}

// MARK: - SyncIntentStatus

/// Processing state of a queued intent.
enum SyncIntentStatus: String, Codable {
    /// Waiting to be processed.
    case pending
    /// Currently being sent to the backend.
    case inFlight
    /// All retries exhausted; requires manual resolution.
    case failed
}

// MARK: - SyncIntent

@Model
final class SyncIntent {

    /// The action to perform against the backend.
    var action: String          // SyncIntentAction.rawValue

    /// The clientId of the CardItem this intent applies to.
    /// Used to locate the local row for create/update payloads.
    var cardClientId: String

    /// The server-side holding ID (populated for update/delete intents).
    /// Nil for create intents until the backend assigns one.
    var serverHoldingId: String?

    /// Current processing state.
    var status: String          // SyncIntentStatus.rawValue

    /// Number of times this intent has been retried after failure.
    var retryCount: Int

    /// When this intent was created.
    var createdAt: Date

    /// When this intent was last attempted.
    var lastAttemptedAt: Date?

    /// Error message from the most recent failed attempt.
    var lastError: String?

    // MARK: Init

    init(
        action: SyncIntentAction,
        cardClientId: String,
        serverHoldingId: String? = nil
    ) {
        self.action = action.rawValue
        self.cardClientId = cardClientId
        self.serverHoldingId = serverHoldingId
        self.status = SyncIntentStatus.pending.rawValue
        self.retryCount = 0
        self.createdAt = Date()
    }

    // MARK: Computed helpers

    var intentAction: SyncIntentAction {
        SyncIntentAction(rawValue: action) ?? .update
    }

    var intentStatus: SyncIntentStatus {
        get { SyncIntentStatus(rawValue: status) ?? .pending }
        set { status = newValue.rawValue }
    }

    var isPending: Bool { intentStatus == .pending }
    var isFailed: Bool { intentStatus == .failed }
}
