//
//  ListingDraftStore.swift
//  HobbyIQ
//
//  2026-07-20: per-holding draft persistence for the Listing Review
//  screen. If the user opens Review, edits some fields, then leaves
//  without publishing, the draft survives — reopening the screen
//  for the same holding restores the last edited state. Drafts
//  expire after 24h to avoid stale wire-shape mismatches after
//  backend deploys.
//
//  Storage: UserDefaults, keyed by holdingId. Small enough (~2KB
//  per draft) that we don't need a real DB.
//

import Foundation

struct ListingDraft: Codable {
    let holdingId: String
    let savedAt: Date
    let listing: PreparedListing

    /// 24-hour freshness gate. Older drafts are stale and dropped
    /// silently — the review screen re-fetches from the backend.
    var isFresh: Bool {
        Date().timeIntervalSince(savedAt) < 24 * 60 * 60
    }
}

/// Small facade around UserDefaults so the Review screen doesn't
/// touch keys directly. Everything is holding-scoped.
enum ListingDraftStore {
    private static let keyPrefix = "hobbyiq.listingDraft."

    private static func key(for holdingId: String) -> String {
        keyPrefix + holdingId
    }

    static func load(holdingId: String) -> ListingDraft? {
        guard let data = UserDefaults.standard.data(forKey: key(for: holdingId)) else {
            return nil
        }
        do {
            let draft = try JSONDecoder().decode(ListingDraft.self, from: data)
            if draft.isFresh { return draft }
            // Stale → clear and treat as absent.
            clear(holdingId: holdingId)
            return nil
        } catch {
            // Wire shape drift after a backend deploy leaves the
            // encoded draft undecodable — clear so we don't keep
            // trying every open.
            clear(holdingId: holdingId)
            return nil
        }
    }

    static func save(holdingId: String, listing: PreparedListing) {
        let draft = ListingDraft(
            holdingId: holdingId,
            savedAt: Date(),
            listing: listing
        )
        if let data = try? JSONEncoder().encode(draft) {
            UserDefaults.standard.set(data, forKey: key(for: holdingId))
        }
    }

    /// Called after a successful publish so a subsequent open
    /// re-fetches from `/prepare` rather than restoring a
    /// now-published draft.
    static func clear(holdingId: String) {
        UserDefaults.standard.removeObject(forKey: key(for: holdingId))
    }
}
