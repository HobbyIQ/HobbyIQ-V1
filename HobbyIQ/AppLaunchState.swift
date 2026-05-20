//
//  AppLaunchState.swift
//  HobbyIQ
//

import Foundation

enum AppLaunchState: Equatable {
    case launching
    case signedOut
    case paywall
    case ready
    case error(String)
}

struct AppUser: Equatable {
    let id: String
    let displayName: String
    let email: String?
}

enum AppSessionScenario: String, CaseIterable, Identifiable {
    case signedOut
    case noAccess
    case ready

    var id: String { rawValue }
}
