//
//  VerifyCardModels.swift
//  HobbyIQ
//
//  PR #441 (2026-07-14): Verify Card sheet — dry-run suggestion API
//  request / response types. The user edits fields, iOS debounces
//  and calls POST /api/portfolio/holdings/dry-run-suggest, backend
//  echoes back the normalized fields, the diff of what was cleaned,
//  and the best-guess catalog match + up to two alternatives.
//
//  Everything decodes defensively (try? decodeIfPresent) so a shape
//  drift degrades to an empty sheet, not a crash.
//

import Foundation

// MARK: - Request

struct DryRunSuggestRequest: Codable {
    let playerName: String?
    let cardYear: Int?
    let setName: String?
    let parallel: String?
    let cardNumber: String?
    let isAuto: Bool?
    let isRookie: Bool?
}

// MARK: - Response

struct DryRunSuggestResponse: Codable {
    let success: Bool?
    let suggestion: CardIdSuggestion?
    let normalized: NormalizedPayload?
}

struct NormalizedPayload: Codable {
    let fields: NormalizedFields?
    let changes: [NormalizedChange]?
}

struct NormalizedFields: Codable, Hashable {
    let playerName: String?
    let cardYear: Int?
    let setName: String?
    let parallel: String?
    let cardNumber: String?
    let isAuto: Bool?
}

/// One rule-fire from the normalizer. `rule` is a machine key
/// (e.g. `"setName_strip_year_prefix"`) that iOS maps to a human
/// label; `before` / `after` are the raw diff for the affected field.
struct NormalizedChange: Codable, Hashable, Identifiable {
    let rule: String?
    let field: String?
    let before: String?
    let after: String?

    var id: String { (rule ?? "rule") + "-" + (field ?? "field") }

    /// Human-friendly label for the rule enum. Unknown rules fall
    /// through to `.rule` verbatim so backend can ship new rules
    /// without an iOS deploy.
    var displayLabel: String {
        switch rule {
        case "setName_strip_year_prefix": return "Removed year from set name"
        case "setName_title_case": return "Fixed casing"
        case "parallel_strip_subset_prefix": return "Removed set/subset from parallel"
        case "playerName_strip_leading_noise": return "Stripped noise from name"
        case "cardNumber_uppercase_trim": return "Uppercased card number"
        default: return rule ?? "Normalized field"
        }
    }
}

/// Backend candidate + confidence. `alternatives` is nil when
/// suggestion is tier "high" — the picker skips the "or pick an
/// alternative" section in that case.
struct CardIdSuggestion: Codable, Hashable, Identifiable {
    let cardId: String
    let confidence: Double?
    let confidenceTier: String?
    let candidateSource: String?
    let matchBreakdown: SuggestionMatchBreakdown?
    let candidate: SuggestionCandidate?
    let alternatives: [CardIdSuggestion]?

    var id: String { cardId }

    /// Human-friendly source label for the row caption
    /// ("via CardHedge" / "via Cardsight").
    var sourceLabel: String {
        switch candidateSource {
        case "cardhedge": return "via CardHedge"
        case "cardsight-uuid": return "via Cardsight"
        default: return candidateSource ?? "—"
        }
    }
}

// MARK: - Tier badge branding (shared across best-match + alt rows)

enum SuggestionTier: String {
    case high, medium, low, none

    static func from(_ raw: String?) -> SuggestionTier {
        switch raw?.lowercased() {
        case "high": return .high
        case "medium": return .medium
        case "low": return .low
        default: return .none
        }
    }
}
