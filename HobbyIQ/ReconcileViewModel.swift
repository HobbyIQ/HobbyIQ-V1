//
//  ReconcileViewModel.swift
//  HobbyIQ
//
//  CF-PR-E-IOS-PHASE-1A (2026-06-16) — two-axis reconciliation VM.
//
//  Owns the unreconciled list + per-entry mutation responses; will replace
//  ERPReconciliationView's ad-hoc @State once Phase 1b swaps the inbox
//  subview in. The model is intentionally response-driven: every mutation
//  re-applies the server-enriched `entry` payload (carrying server-derived
//  `costsStatus` + `missingFields`) and lets the server's
//  `needsReconciliation` flag decide whether the row leaves the inbox
//  (finalize) or stays with the new display state (saved_pending_fees).
//
//  Two error surfaces, two colors:
//    • `errorMessage` — RED, existing failure surface for network / decode
//      / 5xx errors. Same semantics as ERPReconciliationView today.
//    • `infoMessage`  — CALM (muted/blue), 409 conflict signals. 409 here
//      means "this entry is already finalized — costs are locked" or
//      "can't dismiss right now" — not failures, informational. Never red.
//

import Combine
import Foundation

@MainActor
final class ReconcileViewModel: ObservableObject {
    @Published private(set) var entries: [LedgerEntryForErp] = []
    @Published private(set) var counts: UnreconciledCounts?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published var infoMessage: String?

    private let api: APIService

    init(api: APIService) {
        self.api = api
    }

    convenience init() {
        self.init(api: APIService.shared)
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await api.fetchUnreconciled()
            entries = response.entries
            counts = response.counts
        } catch {
            errorMessage = APIService.errorMessage(from: error)
        }
    }

    /// Save cost basis for an eBay-source unreconciled entry. The server
    /// returns an enriched `entry` (carries fresh `costsStatus` +
    /// `missingFields`). Finalize transition: server sets
    /// `needsReconciliation = false` only when both axes met → the entry
    /// leaves the inbox. Otherwise the row stays and its display flips to
    /// `saved_pending_fees`.
    @discardableResult
    func saveCosts(entryId: String, gradingCost: Double?, suppliesCost: Double?) async -> LedgerEntryForErp? {
        errorMessage = nil
        infoMessage = nil
        let request = ERPSaveCostsRequest(gradingCost: gradingCost, suppliesCost: suppliesCost)
        do {
            let response = try await api.saveLedgerCosts(entryId: entryId, request: request)
            guard let entry = response.entry else {
                errorMessage = response.error ?? "Couldn't save cost basis. Try again."
                return nil
            }
            applyUpdatedEntry(entry)
            return entry
        } catch let APIServiceError.httpError(statusCode, body) where statusCode == 409 {
            infoMessage = parseServerErrorMessage(body) ?? "This entry is already finalized — costs are locked."
            await load()
            return nil
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            return nil
        }
    }

    /// Submit a manual fee override for an unreconciled eBay entry. Same
    /// response shape as save-costs (server-enriched entry). Two-axis
    /// finalize runs server-side; this VM just re-applies the response.
    @discardableResult
    func submitOverride(entryId: String, request: ERPOverrideRequest) async -> LedgerEntryForErp? {
        errorMessage = nil
        infoMessage = nil
        do {
            let response = try await api.submitOverride(entryId: entryId, request: request)
            guard let entry = response.entry else {
                errorMessage = response.error ?? response.message ?? "Couldn't apply fee override. Try again."
                return nil
            }
            applyUpdatedEntry(entry)
            return entry
        } catch let APIServiceError.httpError(statusCode, body) where statusCode == 409 {
            infoMessage = parseServerErrorMessage(body) ?? "This entry is already finalized — fees are locked."
            await load()
            return nil
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            return nil
        }
    }

    /// Optimistic dismiss — row vanishes immediately. On non-409 failure:
    /// snap back to the pre-dismiss snapshot + surface errorMessage. On
    /// 409: surface infoMessage and reload to server truth.
    func dismiss(entryId: String, reason: String?) async {
        errorMessage = nil
        infoMessage = nil
        let snapshot = entries
        entries.removeAll { $0.id == entryId }
        do {
            _ = try await api.dismissLedgerEntry(entryId: entryId, reason: reason)
        } catch let APIServiceError.httpError(statusCode, body) where statusCode == 409 {
            infoMessage = parseServerErrorMessage(body) ?? "This entry can't be quieted right now."
            entries = snapshot
            await load()
        } catch {
            errorMessage = APIService.errorMessage(from: error)
            entries = snapshot
        }
    }

    // MARK: - Helpers

    /// Server-authoritative finalize: response entry with
    /// `needsReconciliation == false` leaves the inbox; everything else
    /// stays + reflects the new costsStatus / missingFields. New entries
    /// are appended (defensive — shouldn't happen in practice since
    /// save-costs / override only mutate existing rows).
    private func applyUpdatedEntry(_ entry: LedgerEntryForErp) {
        if entry.needsReconciliation == false {
            entries.removeAll { $0.id == entry.id }
        } else if let idx = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[idx] = entry
        } else {
            entries.append(entry)
        }
    }

    /// Backend 409 shape: `{ success: false, error: string, code: "..." }`.
    /// Pulls the human-readable `error` string out of a JSON body. Returns
    /// nil when the body isn't JSON or has no `error` field — caller
    /// falls back to a generic copy.
    private func parseServerErrorMessage(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = json["error"] as? String,
              !message.isEmpty else {
            return nil
        }
        return message
    }
}
