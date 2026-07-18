//
//  AlertsModels.swift
//  HobbyIQ
//

import Foundation

// MARK: - Price Alert Models

struct PriceAlertItem: Codable, Identifiable, Hashable {
    let id: String
    let type: String?
    let playerName: String?
    let cardName: String?
    let threshold: Double?
    let active: Bool?
    let triggeredAt: String?
    let createdAt: String?
}

struct PriceAlertListResponse: Codable {
    let alerts: [PriceAlertItem]?
    let count: Int?
}

struct PriceAlertDeleteResponse: Codable {
    let message: String?
}

// MARK: - Advanced Alert Scope

enum AdvancedAlertScope: String, Codable, CaseIterable, Identifiable {
    case card
    case player
    case watchlist
    case holdings

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .card: return "Card"
        case .player: return "Player"
        case .watchlist: return "Watchlist"
        case .holdings: return "Holdings"
        }
    }
}

// MARK: - Advanced Alert Condition Types (backend-accepted ONLY)
// OMITTED: price_crosses, predicted_price_crosses — rejected by backend

enum AdvancedAlertConditionType: String, Codable, CaseIterable, Identifiable {
    case predictedDirection = "predicted_direction"
    case predictedPctMove = "predicted_pct_move"
    case trendiqComposite = "trendiq_composite"
    case trendiqCoverageMin = "trendiq_coverage_min"
    case confidenceMin = "confidence_min"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .predictedDirection: return "Predicted Direction"
        case .predictedPctMove: return "Predicted % Move"
        case .trendiqComposite: return "TrendIQ Composite"
        case .trendiqCoverageMin: return "TrendIQ Coverage Min"
        case .confidenceMin: return "Confidence Min"
        }
    }

    var configDescription: String {
        switch self {
        case .predictedDirection: return "Equals: up or down"
        case .predictedPctMove: return "Op: gte/lte, Value: -100..100"
        case .trendiqComposite: return "Op: gte/lte, Value: 0.5..2.0"
        case .trendiqCoverageMin: return "Value: coverage level"
        case .confidenceMin: return "Value: 0..100"
        }
    }

    var usesEquals: Bool { self == .predictedDirection }
    var usesOp: Bool { self == .predictedPctMove || self == .trendiqComposite }
    var usesValueOnly: Bool { self == .trendiqCoverageMin || self == .confidenceMin }
}

// MARK: - Advanced Alert Condition

struct AdvancedAlertCondition: Codable, Hashable {
    let type: String
    let equals: String?
    let op: String?
    let value: Double?

    init(type: String, equals: String? = nil, op: String? = nil, value: Double? = nil) {
        self.type = type
        self.equals = equals
        self.op = op
        self.value = value
    }
}

// MARK: - Advanced Alert Rule

struct AdvancedAlertRule: Codable, Identifiable, Hashable {
    let id: String
    let name: String?
    let scope: String?
    let scopeValue: String?
    let conditions: [AdvancedAlertCondition]?
    let combinator: String?
    let cooldownMinutes: Int?
    let active: Bool?
    let lastTriggered: String?
    let createdAt: String?
}

struct AdvancedAlertListResponse: Codable {
    let rules: [AdvancedAlertRule]?
    let count: Int?
}

struct AdvancedAlertCreateRequest: Codable {
    let name: String
    let scope: String
    let scopeValue: String?
    let conditions: [AdvancedAlertCondition]
    let combinator: String
    let cooldownMinutes: Int?
}

struct AdvancedAlertUpdateRequest: Codable {
    let name: String?
    let conditions: [AdvancedAlertCondition]?
    let combinator: String?
    let cooldownMinutes: Int?
    let active: Bool?
}

struct AdvancedAlertResponse: Codable {
    let rule: AdvancedAlertRule?
    let message: String?
}

struct AdvancedAlertDeleteResponse: Codable {
    let message: String?
}

// MARK: - PR #550: Popular Alert Presets

struct AlertPresetScope: Codable, Hashable {
    let type: String?
    let value: String?
}

struct AlertPreset: Codable, Identifiable, Hashable {
    let presetId: String
    let name: String?
    let category: String?
    let description: String?
    let whyItMatters: String?
    let scope: AlertPresetScope?
    let combinator: String?
    let conditions: [AdvancedAlertCondition]?
    let cooldownMin: Int?
    /// True when at least one of the preset's conditions is a
    /// `price_crosses` predicate that needs a user-supplied number
    /// before activation.
    let requiresPriceTarget: Bool?

    var id: String { presetId }
}

struct AlertPresetsResponse: Codable {
    let success: Bool?
    let presets: [AlertPreset]?
}

struct AlertPresetActivateRequest: Codable {
    let priceTarget: Double?
    let customName: String?
}

struct AlertPresetActivateResponse: Codable {
    let success: Bool?
    let rule: AdvancedAlertRule?
    let message: String?
}
