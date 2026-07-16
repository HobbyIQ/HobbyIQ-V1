//
//  VerdictFlipModels.swift
//  HobbyIQ
//
//  P0.7 (2026-07-16, backend PR #498 + verdict-history-flip-surfaces.md):
//  read models for the two verdict-history endpoints.
//
//  - GET /api/compiq/players/:player/verdict-history?days=90
//    Feeds the holding-detail 3-chip history strip.
//  - POST /api/compiq/portfolio/flips { players[], days }
//    Feeds the inventory-row freshness dot.
//
//  Every field decodes defensively (try? decodeIfPresent) so a shape drift
//  degrades to empty state instead of a crash. Verdict strings pass through
//  verbatim to VerdictStyle.from(_:) — this file never maps to display.
//

import Foundation

// MARK: - GET /api/compiq/players/:player/verdict-history?days=90

struct VerdictHistoryResponse: Codable {
    let success: Bool?
    let player: String?
    let days: Int?
    let history: [VerdictSnapshot]?
    let flips: [VerdictFlip]?
}

struct VerdictSnapshot: Codable, Hashable, Identifiable {
    /// `${normalizedPlayer}::${YYYY-MM-DD}` — stable per snapshot.
    let id: String?
    let player: String?
    /// YYYY-MM-DD.
    let date: String?
    let verdict: String?
    /// `"up" | "down" | "static" | null`.
    let salesDirection: String?
    /// `"up" | "down" | "static" | null`.
    let listingsDirection: String?
    /// ISO timestamp of the daily-cron snapshot.
    let generatedAt: String?

    /// Fallback id when the wire doc omits `id` — combines player + date
    /// so ForEach identity remains stable within a single response.
    var stableId: String {
        id ?? "\(player ?? "")::\(date ?? "")"
    }
}

// MARK: - POST /api/compiq/portfolio/flips

struct PortfolioFlipsRequest: Codable {
    let players: [String]
    let days: Int
}

struct PortfolioFlipsResponse: Codable {
    let success: Bool?
    let requestedPlayers: Int?
    let days: Int?
    let flips: [VerdictFlip]?
}

// MARK: - Shared flip shape (both endpoints emit it)

struct VerdictFlip: Codable, Hashable, Identifiable {
    /// Normalized (lowercase-hyphenated) player name as backend emitted it.
    let player: String?
    /// YYYY-MM-DD of the NEW verdict (i.e. the day of the flip).
    let date: String?
    let from: String?
    let to: String?
    /// `"major"` (bull ↔ bear boundary crossing — the push-notification
    /// gate) or `"minor"` (HOLD-adjacent nudge).
    let significance: String?

    var id: String {
        "\(player ?? "")::\(date ?? "")::\(from ?? "")::\(to ?? "")"
    }

    /// Parsed date at UTC noon so freshness math is timezone-neutral.
    /// Returns nil when the wire date is missing or malformed.
    var parsedDate: Date? {
        guard let date else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: "\(date)T12:00:00Z")
    }

    /// Days since the flip. `nil` when date can't be parsed. Used to gate
    /// the inventory-row dot's opacity + visibility per verdict-history-flip-surfaces.md.
    var daysSince: Int? {
        guard let parsed = parsedDate else { return nil }
        let seconds = Date().timeIntervalSince(parsed)
        return Int(seconds / 86_400.0)
    }

    /// True when the flip is fresh enough to surface at all (0..14 days).
    /// 0..6: full opacity; 7..13: 40% opacity; 14+: hidden.
    var isFresh: Bool {
        (daysSince ?? Int.max) < 14
    }

    /// Opacity for the inventory-row dot. Returns nil when the flip is stale.
    var dotOpacity: Double? {
        guard let d = daysSince else { return nil }
        if d < 7 { return 1.0 }
        if d < 14 { return 0.4 }
        return nil
    }

    /// True when this flip crossed the bull/bear boundary — the only class
    /// that fires a push notification when `preferences.pushOnMajorFlip == true`.
    var isMajor: Bool {
        significance?.lowercased() == "major"
    }
}

// MARK: - Freshness formatting for the detail-sheet chips

/// "3d" / "2w" / "1mo" / "1y+" per the verdict-history-flip-surfaces.md
/// design call. Returns nil when the days count is unavailable.
func formatFlipAge(daysSince: Int?) -> String? {
    guard let days = daysSince, days >= 0 else { return nil }
    if days < 7 { return "\(days)d" }
    if days < 28 { return "\(days / 7)w" }
    if days < 365 { return "\(days / 28)mo" }
    return "1y+"
}
