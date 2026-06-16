//
//  ReconcileModels.swift
//  HobbyIQ
//
//  CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16) — iOS contract for the PR E
//  reconciliation surface. Mirrors backend SHA 385906f.
//
//  Backend endpoints consumed:
//   GET   /api/portfolio/erp/unreconciled
//   POST  /api/portfolio/erp/unreconciled/:id/save-costs
//   PATCH /api/portfolio/ledger/:id            (dismiss flow)
//

import Foundation

// MARK: - CostsStatus

/// Derived UI bucket the backend computes per /unreconciled entry. Drives
/// the inbox chip + which CTA the detail screen shows.
///
/// - `needsAction`: marker unset → "Add cost basis" CTA, amber chip.
/// - `savedPendingFees`: user has saved cost basis, Finances enrichment
///   hasn't landed yet → "Fees pending" muted chip.
///
/// Finalized entries are excluded from /unreconciled by definition (server
/// filters); they never appear with a third CostsStatus value.
enum CostsStatus: String, Codable, Hashable {
    case needsAction = "needs_action"
    case savedPendingFees = "saved_pending_fees"
}

// MARK: - UnreconciledEntry

/// One row in the reconcile inbox. Decoded from
/// `GET /api/portfolio/erp/unreconciled` and from
/// `POST /api/portfolio/erp/unreconciled/:id/save-costs`'s `entry` field,
/// and from `POST /api/portfolio/erp/unreconciled/:id/override`'s `entry`.
///
/// IDENTITY GAP: this carries only `playerName` + `cardTitle` as display
/// strings. For rich identity (year / set / parallel / grade), join
/// `holdingId` against `InventoryCard.id.uuidString.lowercased()` via the
/// existing `PortfolioIQViewModel.inventoryCards`. Fall back to
/// `playerName / cardTitle` when no match.
///
/// CF-PR-E-COSTSSTATUS-AUTHORITATIVE (backend `00847c6`): `costsStatus`
/// AND `missingFields` are server-authoritative on every response shape
/// — `GET /unreconciled`, `POST /save-costs`, `POST /override`. Both are
/// non-optional. Client never re-derives them. `costsStatus` may return
/// `saved_pending_fees` on a finalized entry (`needsReconciliation==false`)
/// — that's harmless: views key finalize off `needsReconciliation`, not
/// the chip enum.
struct UnreconciledEntry: Codable, Identifiable, Hashable {
    // Identity
    let id: String
    let holdingId: String
    let playerName: String
    let cardTitle: String

    // Sale
    let unitSalePrice: Double
    let grossProceeds: Double
    let soldAt: String                       // ISO-8601 (may carry fractional seconds)
    let costBasisSold: Double                // acquisition snapshot (D3: display-only)
    let realizedProfitLoss: Double           // provisional while flagged
    let ebayOrderId: String?
    let source: String?                      // "ebay" expected for entries that surface here

    // Two-axis state — server-authoritative on every response shape.
    let needsReconciliation: Bool?           // always true while in inbox
    let missingFields: [String]              // names of null fee fields, server-supplied
    let costsStatus: CostsStatus             // server-derived; chip enum

    // Axis-2 marker (absent until first save-costs call)
    let userCostsProvidedAt: String?
    let userCostsProvidedBy: String?

    // Fee provenance (absent until fees first land)
    let feeSource: String?                   // "ebay_finances" | "manual_override"

    // Dismiss (UI-quieting; doesn't affect P&L exclusion)
    let dismissedAt: String?

    // Granular eBay fees — nullable for the "Pending from eBay" muted state
    let finalValueFee: Double?
    let paymentProcessingFee: Double?
    let promotedListingFee: Double?
    let adFee: Double?
    let otherFees: Double?
    let netPayout: Double?
    let actualShippingCost: Double?

    // User costs (LOCKED once needsReconciliation flips to false; UI gates
    // editability via `needsReconciliation`).
    let gradingCost: Double?
    let suppliesCost: Double?
}

extension UnreconciledEntry {
    /// True when at least one granular fee is null. Drives the
    /// "provisional — fees pending" label on the realized-gain line and the
    /// "Pending from eBay" muted state on the eBay-fees card. Reads
    /// server-provided `missingFields` directly — no client-side re-derivation.
    var hasPendingFees: Bool {
        missingFields.isEmpty == false
    }
}

// MARK: - GET /unreconciled

struct UnreconciledCounts: Codable, Hashable {
    let unreconciledTotal: Int
    let dismissedHidden: Int
}

struct UnreconciledResponse: Codable {
    let success: Bool
    let entries: [UnreconciledEntry]
    let counts: UnreconciledCounts
}

// MARK: - POST /save-costs

struct SaveCostsRequest: Codable {
    // Backend accepts either or both; ≥1 required server-side. iOS sends
    // both when both fields are touched; either-field for raw cards.
    let gradingCost: Double?
    let suppliesCost: Double?
}

struct SaveCostsResponse: Codable {
    let success: Bool
    /// The server-authoritative post-save entry. Drives UI transitions: if
    /// `needsReconciliation == false`, the entry has finalized and should
    /// leave the inbox; otherwise it stays with the marker now set.
    let entry: UnreconciledEntry
    /// Optional audit-row payload (not currently rendered on iOS; reserved
    /// for a future audit-history surface).
    let adjustment: LedgerFeeAdjustment?
}

// MARK: - PATCH /ledger/:id (dismiss)

struct DismissRequest: Codable {
    /// ISO-8601 string. iOS sets to `Date()` at call time.
    let dismissedAt: String?
    /// Optional free-text reason (≤500 chars server-side).
    let dismissedReason: String?
}

/// Minimal decode for the dismiss flow. The backend returns
/// `{ message, entry: PortfolioLedgerEntry }` but the iOS state transition
/// is "remove from inbox" regardless — we don't need to decode the entry.
struct LedgerPatchResponse: Codable {
    let message: String?
}

// MARK: - LedgerFeeAdjustment

/// Audit-row shape from the backend's `LedgerFeeAdjustment` type. Decoded
/// best-effort so iOS doesn't break if the backend adds fields. Currently
/// surfaced through `SaveCostsResponse.adjustment` only; no UI consumer
/// yet — kept Codable so adding an audit-history view later is a view
/// change, not a model change.
struct LedgerFeeAdjustment: Codable, Hashable {
    let adjustmentId: String
    let adjustedAt: String
    let adjustedBy: String
    let reason: String
}

// MARK: - Date parsing for "sold Nd ago"

/// Parse the backend's ISO-8601 timestamps. Backend writes both
/// fractional-seconds (`...18:30:55.960Z` — `Date().toISOString()` shape)
/// and integral-seconds variants depending on origin. Try the
/// fractional-seconds formatter first, fall back to the basic one so a
/// stray non-fractional timestamp doesn't silently break the "sold Nd ago"
/// label.
enum ReconcileDateParser {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let basic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ iso: String?) -> Date? {
        guard let iso, iso.isEmpty == false else { return nil }
        if let d = fractional.date(from: iso) { return d }
        return basic.date(from: iso)
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    /// "sold 5d ago" style. Returns "—" when the ISO string can't be parsed
    /// rather than silently returning nil — gives us a visible failure
    /// signal during Mac-side preview verification.
    static func relativeSoldString(from iso: String?, now: Date = Date()) -> String {
        guard let date = parse(iso) else { return "—" }
        return relative.localizedString(for: date, relativeTo: now)
    }

    /// Serialize an iOS `Date` to the fractional-seconds ISO-8601 shape the
    /// backend writes (matches `new Date().toISOString()` on the server).
    /// Used by the dismiss flow's `dismissedAt` body field.
    static func dismissedAtISOString(from date: Date) -> String {
        fractional.string(from: date)
    }
}

// MARK: - Preview fixtures

#if DEBUG
extension UnreconciledEntry {
    /// Shared fixture factory for SwiftUI previews on Mac. Defaults model
    /// the "fresh unreconciled eBay sale, fees pending" baseline; overrides
    /// flip the marker, populate fees, or simulate the saved-pending-fees
    /// state without re-typing the whole shape.
    static func preview(
        id: String = "L-preview-1",
        holdingId: String = "00000000-0000-0000-0000-0000000000aa",
        playerName: String = "Mike Trout",
        cardTitle: String = "2011 Topps Update US175 Mike Trout RC",
        unitSalePrice: Double = 250,
        grossProceeds: Double = 250,
        soldAt: String = "2026-06-10T15:30:00.000Z",
        costBasisSold: Double = 80,
        realizedProfitLoss: Double = 170,
        ebayOrderId: String? = "12-34567-89012",
        source: String? = "ebay",
        needsReconciliation: Bool? = true,
        missingFields: [String] = [
            "finalValueFee", "paymentProcessingFee", "promotedListingFee",
            "adFee", "otherFees", "netPayout", "actualShippingCost",
        ],
        costsStatus: CostsStatus = .needsAction,
        userCostsProvidedAt: String? = nil,
        userCostsProvidedBy: String? = nil,
        feeSource: String? = nil,
        dismissedAt: String? = nil,
        finalValueFee: Double? = nil,
        paymentProcessingFee: Double? = nil,
        promotedListingFee: Double? = nil,
        adFee: Double? = nil,
        otherFees: Double? = nil,
        netPayout: Double? = nil,
        actualShippingCost: Double? = nil,
        gradingCost: Double? = nil,
        suppliesCost: Double? = nil
    ) -> UnreconciledEntry {
        UnreconciledEntry(
            id: id, holdingId: holdingId,
            playerName: playerName, cardTitle: cardTitle,
            unitSalePrice: unitSalePrice, grossProceeds: grossProceeds,
            soldAt: soldAt, costBasisSold: costBasisSold,
            realizedProfitLoss: realizedProfitLoss,
            ebayOrderId: ebayOrderId, source: source,
            needsReconciliation: needsReconciliation,
            missingFields: missingFields, costsStatus: costsStatus,
            userCostsProvidedAt: userCostsProvidedAt,
            userCostsProvidedBy: userCostsProvidedBy,
            feeSource: feeSource, dismissedAt: dismissedAt,
            finalValueFee: finalValueFee,
            paymentProcessingFee: paymentProcessingFee,
            promotedListingFee: promotedListingFee,
            adFee: adFee, otherFees: otherFees,
            netPayout: netPayout, actualShippingCost: actualShippingCost,
            gradingCost: gradingCost, suppliesCost: suppliesCost
        )
    }

    /// `needs_action` + fees populated (eBay enrichment landed, user
    /// hasn't yet saved costs).
    static var previewNeedsActionFeesPopulated: UnreconciledEntry {
        .preview(
            id: "L-preview-fees-in",
            missingFields: [],
            costsStatus: .needsAction,
            feeSource: "ebay_finances",
            finalValueFee: 32, paymentProcessingFee: 8,
            promotedListingFee: 0, adFee: 0, otherFees: 0,
            netPayout: 205, actualShippingCost: 5
        )
    }

    /// `saved_pending_fees`: user saved costs, fees still null.
    static var previewSavedPendingFees: UnreconciledEntry {
        .preview(
            id: "L-preview-saved",
            costsStatus: .savedPendingFees,
            userCostsProvidedAt: "2026-06-12T18:00:00.000Z",
            userCostsProvidedBy: "user-preview",
            gradingCost: 15, suppliesCost: 2
        )
    }

    /// Raw-card preset: save-costs with `gradingCost: 0, suppliesCost: 0`
    /// satisfies axis 2 (action, not value) — drives the demonstration of
    /// the 0/0 finalize semantic in detail-view previews.
    static var previewRawCardZeroCosts: UnreconciledEntry {
        .preview(
            id: "L-preview-raw",
            playerName: "Steele Hall",
            cardTitle: "2025 Bowman Draft Chrome Prospect Auto Blue Refractor /150 CPA-SHA",
            costsStatus: .savedPendingFees,
            userCostsProvidedAt: "2026-06-15T20:00:00.000Z",
            userCostsProvidedBy: "user-preview",
            gradingCost: 0, suppliesCost: 0
        )
    }

    /// Inbox empty-state companion fixture (the inbox view renders the
    /// "All caught up" row when `entries.isEmpty`).
    static var previewEmptyResponse: UnreconciledResponse {
        UnreconciledResponse(
            success: true, entries: [],
            counts: UnreconciledCounts(unreconciledTotal: 0, dismissedHidden: 0)
        )
    }

    /// Inbox mixed-state fixture: 2 `needsAction` + 1 `savedPendingFees`.
    static var previewMixedResponse: UnreconciledResponse {
        UnreconciledResponse(
            success: true,
            entries: [
                .preview(),
                .previewNeedsActionFeesPopulated,
                .previewSavedPendingFees,
            ],
            counts: UnreconciledCounts(unreconciledTotal: 3, dismissedHidden: 1)
        )
    }
}
#endif
