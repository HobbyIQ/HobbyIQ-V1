//
//  ReconcileViewModel.swift
//  HobbyIQ
//
//  CF-PR-E-TWO-AXIS-RECONCILIATION (2026-06-16) — iOS state for the
//  Reconcile inbox + detail views. Mac-side views compose against this VM.
//
//  Holdings join: this VM holds a reference to the existing
//  `PortfolioIQViewModel` to read its `inventoryCards` for the rich
//  identity line (year / set / parallel / grade). We do NOT trigger a
//  holdings fetch from here — the inbox renders immediately with the
//  `playerName / cardTitle` fallback if `inventoryCards` is empty.
//  Optional background `refresh` is the caller's choice.
//
//  Auth: APIService auto-injects x-session-id (mirrors holdings fetch
//  shape). No explicit session plumbing here.
//
//  Response-driven transitions: every mutation (save, dismiss) updates
//  `entries` off the server's authoritative response, not optimistic
//  guesses. The one exception is the dismiss flow's optimistic remove (the
//  user said "quiet" — we hide immediately and revert if the PATCH fails).
//

import Foundation

@MainActor
final class ReconcileViewModel: ObservableObject {

    // MARK: State

    @Published private(set) var entries: [UnreconciledEntry] = []
    @Published private(set) var counts: UnreconciledCounts?
    @Published private(set) var isLoading: Bool = false

    /// Hard error (request failed, network down). Shows as a banner with
    /// red-allowed framing on the inbox. Distinct from `infoMessage` —
    /// reconcile UI is "calm, never red" for normal flow transitions.
    @Published var errorMessage: String?

    /// Calm informational banner. Drives the 409 ALREADY_FINALIZED notice
    /// ("Reconciled by another device — refreshed") and similar
    /// state-converged-elsewhere reads. Views render this in muted, not red.
    @Published var infoMessage: String?

    // MARK: Collaborators

    private let service: APIService
    private weak var portfolioVM: PortfolioIQViewModel?

    init(service: APIService = .shared, portfolioVM: PortfolioIQViewModel?) {
        self.service = service
        self.portfolioVM = portfolioVM
    }

    // MARK: Loading

    func load() async {
        await fetch(preserveExistingOnError: false)
    }

    func refresh() async {
        await fetch(preserveExistingOnError: true)
    }

    private func fetch(preserveExistingOnError: Bool) async {
        guard isLoading == false else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await service.fetchUnreconciled()
            entries = response.entries
            counts = response.counts
        } catch {
            if preserveExistingOnError == false {
                entries = []
                counts = nil
            }
            errorMessage = userFacingMessage(
                for: error,
                fallback: "Couldn't load reconcile inbox."
            )
        }
    }

    // MARK: Save cost basis

    /// Calls `POST /save-costs` and updates state off the response:
    ///   - `entry.needsReconciliation == false` → entry has finalized; REMOVE
    ///     from inbox (it's left the unreconciled pool).
    ///   - Otherwise → REPLACE the entry in place (now showing
    ///     `costsStatus: .savedPendingFees`).
    ///
    /// On 409 ALREADY_FINALIZED, drops the entry + refreshes + sets a calm
    /// `infoMessage` for the banner. On other errors, sets `errorMessage`
    /// and leaves state intact so the detail view can offer a retry.
    ///
    /// Returns `true` when the server confirmed the write, `false` on any
    /// failure path — the caller decides whether to navigate back to the
    /// inbox.
    @discardableResult
    func saveCosts(
        entryId: String,
        gradingCost: Double?,
        suppliesCost: Double?
    ) async -> Bool {
        errorMessage = nil
        infoMessage = nil
        do {
            let response = try await service.saveLedgerCosts(
                entryId: entryId,
                gradingCost: gradingCost,
                suppliesCost: suppliesCost
            )
            apply(savedEntry: response.entry)
            return true
        } catch APIServiceError.httpError(409, _) {
            // ALREADY_FINALIZED: the entry was finalized concurrently
            // (e.g. Finances enrichment landed on another path). Drop from
            // the inbox, refresh quietly, surface a calm note.
            entries.removeAll { $0.id == entryId }
            infoMessage = "Reconciled by another device — refreshed."
            await refresh()
            return false
        } catch {
            errorMessage = userFacingMessage(
                for: error,
                fallback: "Couldn't save cost basis."
            )
            return false
        }
    }

    /// Centralised post-save merge. Public-ish for tests; views go through
    /// `saveCosts`.
    func apply(savedEntry entry: UnreconciledEntry) {
        if entry.needsReconciliation == false {
            // Finalized — leaves the inbox.
            entries.removeAll { $0.id == entry.id }
            if let counts {
                self.counts = UnreconciledCounts(
                    unreconciledTotal: max(0, counts.unreconciledTotal - 1),
                    dismissedHidden: counts.dismissedHidden
                )
            }
            return
        }
        // Still flagged — replace in place so the costsStatus chip updates
        // to `savedPendingFees`.
        if let index = entries.firstIndex(where: { $0.id == entry.id }) {
            entries[index] = entry
        } else {
            // Edge: server returned an entry we no longer track (stale
            // local state). Append rather than silently drop so the user
            // doesn't lose it.
            entries.append(entry)
        }
    }

    // MARK: Dismiss ("Quiet for now")

    /// Optimistic remove + background PATCH. On failure, the entry is
    /// restored to its previous position so the user can retry. Distinct
    /// from save — dismiss is a UI-quieting signal that doesn't change the
    /// reconciliation state.
    @discardableResult
    func dismiss(entryId: String, reason: String? = nil) async -> Bool {
        errorMessage = nil
        infoMessage = nil

        guard let index = entries.firstIndex(where: { $0.id == entryId }) else {
            // Already gone locally (raced with a refresh) — fire-and-forget
            // the PATCH but don't surface to the user.
            _ = try? await service.dismissLedgerEntry(entryId: entryId, reason: reason)
            return true
        }

        let snapshot = entries[index]
        entries.remove(at: index)

        do {
            _ = try await service.dismissLedgerEntry(
                entryId: entryId,
                reason: reason
            )
            // Bump dismissedHidden in the cached counts so the UI stays
            // consistent without a full refetch.
            if let counts {
                self.counts = UnreconciledCounts(
                    unreconciledTotal: counts.unreconciledTotal,
                    dismissedHidden: counts.dismissedHidden + 1
                )
            }
            return true
        } catch {
            // Restore the entry at its original position.
            entries.insert(snapshot, at: min(index, entries.count))
            errorMessage = userFacingMessage(
                for: error,
                fallback: "Couldn't quiet this entry."
            )
            return false
        }
    }

    // MARK: Identity line + holding join

    /// Lookup the joined `InventoryCard` for an entry. Lowercased
    /// uuidString comparison handles the canonical join — backend
    /// `holdingId` is a string, iOS `InventoryCard.id` is a UUID.
    func holding(for entry: UnreconciledEntry) -> InventoryCard? {
        guard let portfolioVM else { return nil }
        let needle = entry.holdingId.lowercased()
        return portfolioVM.inventoryCards.first { card in
            card.id.uuidString.lowercased() == needle
        }
    }

    /// Rich identity line for the inbox row + detail header. Joins on
    /// `holdingId` when possible (year · set · player · parallel · grade);
    /// falls back to the entry's denormalized `playerName` /  `cardTitle`
    /// when the holding is orphaned or `inventoryCards` is empty.
    func identityLine(for entry: UnreconciledEntry) -> String {
        if let card = holding(for: entry) {
            let parts = [card.year, card.setName, card.playerName, card.parallel, card.grade]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.isEmpty == false }
            if parts.isEmpty == false {
                return parts.joined(separator: " · ")
            }
        }
        let player = entry.playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = entry.cardTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        if player.isEmpty == false, title.isEmpty == false {
            return "\(player) — \(title)"
        }
        return title.isEmpty == false ? title : player
    }

    // MARK: - Error formatting

    private func userFacingMessage(for error: Error, fallback: String) -> String {
        if let apiError = error as? APIServiceError, let description = apiError.errorDescription {
            return description
        }
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? fallback : message
    }
}
