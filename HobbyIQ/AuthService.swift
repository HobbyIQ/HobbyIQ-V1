//
//  AuthService.swift
//  HobbyIQ
//

import AuthenticationServices
import Combine
import Foundation

protocol AuthServicing {
    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser?
    func signInWithApple(identityToken: String, email: String?, fullName: String?, username: String) async throws -> AppUser
    func signInWithEmail(email: String, password: String) async throws -> AppUser
    func signInWithEmail() async throws -> AppUser
    func signUpWithEmail(email: String, password: String, username: String) async throws -> AppUser
    func signOut() async
}

@MainActor
final class AuthService: ObservableObject, AuthServicing {
    static let shared = AuthService()

    @Published var session: AuthSession?
    private let sessionStorageKey = "auth.sessionId"
    private let legacySessionStorageKey = "HobbyIQ.AuthService.session"

    var isLoggedIn: Bool {
        session != nil
    }

    var userId: String? {
        session?.userId
    }

    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser? {
        if let storedSession = loadStoredSession() {
            let user = AppUser(id: storedSession.userId, displayName: storedSession.profileName, email: storedSession.profileName)
            session = AuthSession(user: user, token: storedSession.token)
            return user
        }

        session = nil
        clearStoredSession()
        return nil
    }

    func signInWithApple(identityToken: String, email: String?, fullName: String?, username: String) async throws -> AppUser {
        let response = try await withTimeout(seconds: 8) {
            try await APIService.shared.signInWithApple(identityToken: identityToken, email: email, fullName: fullName, username: username)
        }
        return try applySession(from: response)
    }

    func signInWithEmail(email: String, password: String) async throws -> AppUser {
        let response = try await withTimeout(seconds: 8) {
            try await APIService.shared.signInWithEmail(email: email, password: password)
        }
        return try applySession(from: response)
    }

    func signInWithEmail() async throws -> AppUser {
        throw AuthError.credentialsRequired
    }

    func signUpWithEmail(email: String, password: String, username: String) async throws -> AppUser {
        let response = try await withTimeout(seconds: 8) {
            try await APIService.shared.signUpWithEmail(email: email, password: password, username: username)
        }
        return try applySession(from: response)
    }

    private func applySession(from response: AuthSignInResponse) throws -> AppUser {
        guard let backendUser = response.user, let token = response.sessionId else {
            throw APIServiceError.invalidResponse
        }
        let user = AppUser(id: backendUser.userId, displayName: backendUser.email, email: backendUser.email)
        session = AuthSession(user: user, token: token)
        saveSession(session)
        return user
    }

    func signOut() async {
        session = nil
        clearStoredSession()
    }

    func logout() async {
        await signOut()
    }

    private func saveSession(_ session: AuthSession?) {
        guard let session else {
            clearStoredSession()
            return
        }
        UserDefaults.standard.set(session.token, forKey: sessionStorageKey)
        UserDefaults.standard.set(session.userId, forKey: "auth.userId")
        UserDefaults.standard.set(session.profileName, forKey: "auth.displayName")
        UserDefaults.standard.removeObject(forKey: legacySessionStorageKey)
    }

    private func loadStoredSession() -> StoredAuthSession? {
        if let token = UserDefaults.standard.string(forKey: sessionStorageKey)?.trimmingCharacters(in: .whitespacesAndNewlines),
           token.isEmpty == false {
            return StoredAuthSession(token: token)
        }

        guard let data = UserDefaults.standard.data(forKey: legacySessionStorageKey) else { return nil }
        if let legacy = try? JSONDecoder().decode(StoredAuthSession.self, from: data) {
            UserDefaults.standard.set(legacy.token, forKey: sessionStorageKey)
            return legacy
        }

        return nil
    }

    private func clearStoredSession() {
        UserDefaults.standard.removeObject(forKey: sessionStorageKey)
        UserDefaults.standard.removeObject(forKey: "auth.userId")
        UserDefaults.standard.removeObject(forKey: "auth.displayName")
        UserDefaults.standard.removeObject(forKey: legacySessionStorageKey)
    }

    private func withTimeout<T>(seconds: Double, operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }

            group.addTask {
                let nanos = UInt64(seconds * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanos)
                throw TimeoutError.timedOut
            }

            defer { group.cancelAll() }

            guard let result = try await group.next() else {
                throw TimeoutError.timedOut
            }

            return result
        }
    }
}

private struct StoredAuthSession: Codable {
    let token: String
    let userId: String
    let profileName: String
    let accountNumber: String

    init(token: String, userId: String = "", profileName: String = "", accountNumber: String = "") {
        self.token = token
        self.userId = userId
        self.profileName = profileName
        self.accountNumber = accountNumber
    }
}

private enum AuthError: LocalizedError {
    case credentialsRequired

    var errorDescription: String? {
        "Email and password are required to sign in."
    }
}

private enum TimeoutError: LocalizedError {
    case timedOut

    var errorDescription: String? {
        "The backend took too long to respond."
    }
}
