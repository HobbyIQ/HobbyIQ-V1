//
//  AuthService.swift
//  HobbyIQ
//

import Foundation

protocol AuthServicing {
    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser?
    func signInWithApple() async throws -> AppUser
    func signInWithEmail() async throws -> AppUser
    func signOut() async
}

struct AuthService: AuthServicing {
    static let shared = AuthService()

    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser? {
        try await Task.sleep(for: .milliseconds(450))

        switch scenario {
        case .signedOut:
            return nil
        case .noAccess, .ready:
            return AppUser(id: "demo-user", displayName: "Drew", email: "demo@hobbyiq.app")
        }
    }

    func signInWithApple() async throws -> AppUser {
        // TODO: Replace with Sign in with Apple flow and credential handling.
        try await Task.sleep(for: .milliseconds(350))
        return AppUser(id: "apple-user", displayName: "Drew", email: "apple@hobbyiq.app")
    }

    func signInWithEmail() async throws -> AppUser {
        // TODO: Replace with real email / backend-auth flow.
        try await Task.sleep(for: .milliseconds(350))
        return AppUser(id: "email-user", displayName: "Drew", email: "email@hobbyiq.app")
    }

    func signOut() async {
        // TODO: Clear backend session / auth tokens here.
    }
}
