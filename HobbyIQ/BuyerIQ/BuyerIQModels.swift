//
//  BuyerIQModels.swift
//  HobbyIQ
//
//  CF-BUYERIQ (Drew, 2026-07-31). Shape mirrors the backend response
//  shape at src/services/buyeriq/buyeriqStore.service.ts. Kept as
//  plain Codable structs — no SwiftData for MVP. Add local offline
//  persistence in a follow-up once the server-only flow is proven.
//

import Foundation

// MARK: - List

struct BuyerIqList: Codable, Identifiable, Hashable {
    let id: String
    let userId: String
    let name: String
    let description: String?
    let showDate: String?           // ISO date; null for open lists
    let showLocation: String?
    let archived: Bool
    let createdAt: String
    let updatedAt: String
}

// MARK: - Target

/// Priority a user assigns to a target within a list. Shown as a
/// coloured chip on the cell so the user can eyeball their must-haves
/// at a busy show.
enum BuyerIqTargetPriority: String, Codable, CaseIterable, Identifiable {
    case high
    case medium
    case low
    var id: String { rawValue }
    var display: String {
        switch self {
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        }
    }
}

/// Buying status. "wanted" is still hunting; "acquired" and "passed"
/// close the row for post-show analytics.
enum BuyerIqTargetStatus: String, Codable, CaseIterable, Identifiable {
    case wanted
    case acquired
    case passed
    var id: String { rawValue }
    var display: String {
        switch self {
        case .wanted: return "Wanted"
        case .acquired: return "Acquired"
        case .passed: return "Passed"
        }
    }
}

struct BuyerIqTarget: Codable, Identifiable, Hashable {
    let id: String
    let userId: String
    let listId: String
    // Card identity — mirrors PortfolioHolding fields so pricing rails
    // snap in the same way.
    let hobbyiqCardId: String?
    let playerName: String
    let cardYear: Int?
    let cardNumber: String?
    let setName: String?
    let parallel: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Int?
    let imageUrl: String?
    // Buying intent
    let maxPrice: Double?
    let priority: BuyerIqTargetPriority
    let notes: String?
    let status: BuyerIqTargetStatus
    let acquiredAt: String?
    let acquiredPrice: Double?
    let createdAt: String
    let updatedAt: String
}

// MARK: - Response envelopes

struct BuyerIqListsResponse: Codable {
    let success: Bool
    let lists: [BuyerIqList]
}

struct BuyerIqListResponse: Codable {
    let success: Bool
    let list: BuyerIqList
}

struct BuyerIqTargetsResponse: Codable {
    let success: Bool
    let targets: [BuyerIqTarget]
}

struct BuyerIqTargetResponse: Codable {
    let success: Bool
    let target: BuyerIqTarget
}

// MARK: - Request bodies

struct BuyerIqListUpsertRequest: Codable {
    let name: String?
    let description: String?
    let showDate: String?
    let showLocation: String?
    let archived: Bool?
}

struct BuyerIqTargetUpsertRequest: Codable {
    let listId: String?
    let hobbyiqCardId: String?
    let playerName: String?
    let cardYear: Int?
    let cardNumber: String?
    let setName: String?
    let parallel: String?
    let isAuto: Bool?
    let gradeCompany: String?
    let gradeValue: Int?
    let imageUrl: String?
    let maxPrice: Double?
    let priority: String?
    let notes: String?
    let status: String?
    let acquiredAt: String?
    let acquiredPrice: Double?
}
