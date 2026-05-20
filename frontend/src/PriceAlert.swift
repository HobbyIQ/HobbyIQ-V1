//  PriceAlert.swift
//  HobbyIQ — Wire-format models for the /api/alerts CRUD endpoints. The
//  same shape is persisted to the Cosmos `compiq_alerts` container by the
//  TS backend and read by fn-price-alert-checker.

import Foundation

/// Direction the alert fires in. `above` triggers when the current predicted
/// price rises to (or above) `targetPrice`; `below` triggers when it falls
/// to (or below) `targetPrice`.
enum PriceAlertDirection: String, Codable, CaseIterable, Identifiable {
    case above
    case below

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .above: return "Rises above"
        case .below: return "Drops below"
        }
    }

    var systemImage: String {
        switch self {
        case .above: return "arrow.up.right"
        case .below: return "arrow.down.right"
        }
    }
}

/// Snapshot of the card's identity at the time the alert was created.
/// fn-price-alert-checker uses this exact payload to call
/// `POST /api/compiq/predict` so it can recompute the live price without
/// having to look the card up by SwiftData UUID.
struct PriceAlertCardSnapshot: Codable, Hashable {
    let playerName: String
    let year: Int?
    let setName: String?
    let cardNumber: String?
    let grade: String?
    let variant: String?
    let printRun: Int?
    let isRookie: Bool?
}

/// Persisted alert record. `id` is server-assigned on POST.
struct PriceAlert: Codable, Identifiable, Hashable {
    let alertId: String
    let userId: String
    let cardId: String
    let playerName: String
    let targetPrice: Double
    let direction: PriceAlertDirection
    let currentPrice: Double?
    let createdAt: String
    let triggeredAt: String?
    let isActive: Bool
    let cardSnapshot: PriceAlertCardSnapshot?

    /// Map `id` to `alertId` so SwiftUI ForEach works without extra plumbing.
    var id: String { alertId }
}

/// POST /api/alerts request body.
struct CreatePriceAlertRequest: Codable {
    let cardId: String
    let playerName: String
    let targetPrice: Double
    let direction: PriceAlertDirection
    let currentPrice: Double?
    let cardSnapshot: PriceAlertCardSnapshot?
}

/// Common server response for list / single-alert endpoints.
struct PriceAlertResponse: Codable {
    let success: Bool
    let alert: PriceAlert?
    let alerts: [PriceAlert]?
    let error: String?
}

/// POST /api/devices/token — registers an APNs device token against the
/// signed-in user so the backend can target DailyIQ + price-alert pushes.
struct RegisterDeviceTokenRequest: Codable {
    let token: String
    let platform: String   // "ios"
    let bundleId: String?
}
