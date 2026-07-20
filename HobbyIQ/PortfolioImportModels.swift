//
//  PortfolioImportModels.swift
//  HobbyIQ
//
//  2026-07-20 (spec: Portfolio Settings › Data). Wire models for the
//  three-step bulk import flow — preview → conflict resolution →
//  commit — backing the Portfolio Data section. Same backend
//  contract the web already talks to; iOS just needs the request /
//  response shapes.
//

import Foundation

// MARK: - Preview request

/// POST /api/portfolio/import/preview body. `file` is a base64-encoded
/// spreadsheet (xlsx or csv); `format` is the discriminator the
/// backend uses to route to the right parser.
struct PortfolioImportPreviewRequest: Encodable {
    let file: String
    let format: String
}

// MARK: - Preview response

/// Preview response. Small imports (< ~40 rows) return `envelopes`
/// directly with `status == "ready"`. Larger files return `jobId`
/// with `status == "processing"` and callers must poll
/// `pollImportJob(jobId:)` every ~2s until the status transitions
/// to `"ready"`, at which point `envelopes` is populated.
struct PortfolioImportPreviewResponse: Decodable, Hashable {
    let jobId: String?
    let status: String?
    let envelopes: [PortfolioImportEnvelope]?
    let summary: PortfolioImportSummary?
    /// Server-side idempotency token — must be echoed on the commit
    /// request. UI should retain this until the commit succeeds.
    let idempotencyToken: String?
    /// When the preview goes stale (default 15 min after this
    /// timestamp). UI should redirect back to Step A on expiry.
    let expiresAt: String?
    /// Optional user-facing failure — populated when preview parsing
    /// fatals before producing envelopes.
    let error: String?

    var isReady: Bool { (status?.lowercased() ?? "ready") == "ready" }
    var isProcessing: Bool { (status?.lowercased() ?? "") == "processing" }
    var isFailed: Bool {
        let s = status?.lowercased() ?? ""
        return s == "failed" || s == "error"
    }
}

/// Bucketed counts for the preview summary card. Backend may return
/// this even when envelopes are still loading (progress signal).
struct PortfolioImportSummary: Decodable, Hashable {
    let add: Int?
    let update: Int?
    let conflict: Int?
    let reject: Int?
}

// MARK: - Envelope

/// A single row's proposed change. `bucket` drives the UI treatment:
/// - `add`: new holding will be created (no conflict to resolve)
/// - `update`: existing holding will be modified (diff shown)
/// - `conflict`: importer can't resolve — user must choose action
/// - `reject`: row has errors; won't be applied regardless of action
///
/// The `id` field is stable across preview and commit — commit
/// actions reference envelopes by this id.
struct PortfolioImportEnvelope: Codable, Hashable, Identifiable {
    let id: String
    let bucket: String
    let rowIndex: Int?
    let cardId: String?
    let playerName: String?
    let displayLabel: String?
    /// For `reject` bucket — human-readable reason (bad price,
    /// unknown player, etc.).
    let reason: String?
    /// Small preview fields the UI renders in the row summary.
    let year: String?
    let setName: String?
    let cardNumber: String?
    let parallel: String?
    let gradeCompany: String?
    let gradeValue: Double?
    let quantity: Int?
    let purchasePrice: Double?
    /// For `update` / `conflict` — the current on-server value the
    /// row would replace. Rendered next to the incoming value for
    /// visual diff.
    let currentSnapshot: PortfolioImportSnapshot?

    var bucketKind: PortfolioImportBucket {
        switch bucket.lowercased() {
        case "add": return .add
        case "update": return .update
        case "conflict": return .conflict
        case "reject": return .reject
        default: return .reject
        }
    }
}

enum PortfolioImportBucket: String {
    case add, update, conflict, reject

    var label: String {
        switch self {
        case .add: return "Add"
        case .update: return "Update"
        case .conflict: return "Conflict"
        case .reject: return "Rejected"
        }
    }

    var iconSystemName: String {
        switch self {
        case .add: return "plus.circle"
        case .update: return "pencil.circle"
        case .conflict: return "exclamationmark.triangle"
        case .reject: return "xmark.octagon"
        }
    }
}

/// Snapshot of the current on-server holding a row would replace.
/// Every field optional so the wire tolerates partial data.
struct PortfolioImportSnapshot: Codable, Hashable {
    let quantity: Int?
    let purchasePrice: Double?
    let gradeCompany: String?
    let gradeValue: Double?
    let parallel: String?
}

// MARK: - Commit

/// POST /api/portfolio/import/commit body. `actions` maps
/// envelopeId → action ("add" / "update" / "skip"). Envelopes in
/// the `reject` bucket are never actionable and should be omitted
/// from `actions`.
struct PortfolioImportCommitRequest: Encodable {
    let idempotencyToken: String
    let envelopes: [PortfolioImportEnvelope]
    let actions: [String: String]
}

struct PortfolioImportCommitResponse: Decodable, Hashable {
    let success: Bool?
    let holdingsAdded: Int?
    let holdingsUpdated: Int?
    let holdingsSkipped: Int?
    let error: String?

    /// Backend returns `"idempotency_expired"` (or a matching error
    /// code) when the preview is > 15 minutes old. Callers should
    /// tear down and restart the import from Step A.
    var isIdempotencyExpired: Bool {
        (error ?? "").lowercased().contains("idempotency")
    }
}
