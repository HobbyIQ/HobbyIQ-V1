//
//  AgeTier.swift
//  HobbyIQ
//

import Foundation

enum AgeTier: String, CaseIterable, Identifiable {
    case young    // Under 18
    case standard // 18+

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .young:    return "Under 18"
        case .standard: return "18+"
        }
    }

    // MARK: - UserDefaults persistence

    private static let key = "hobbyiq.user.ageTier"

    /// The current age tier. Defaults to `.standard` if not set,
    /// so existing users see no change.
    static var current: AgeTier {
        get {
            guard let raw = UserDefaults.standard.string(forKey: key),
                  let tier = AgeTier(rawValue: raw) else {
                return .standard
            }
            return tier
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: key)
        }
    }
}
