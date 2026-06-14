//
//  AuthService.swift
//  HobbyIQ
//

import AuthenticationServices
import Combine
import Foundation

protocol AuthServicing {
    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser?
    /// Sync prelude — loads stored session into `session` and returns the
    /// cached user, or nil if no stored session. Used by launch paths that
    /// want to parallelize the network validation with other launch work
    /// (see AppSessionViewModel.checkSessionOnLaunch).
    func loadStoredSessionSync() -> AppUser?
    /// Network validation — calls /api/auth/session and updates `session`.
    /// Assumes loadStoredSessionSync() was called first; honors the
    /// CF-LAUNCH-FETCHSESSION-TTL skip when the cached validation is fresh.
    func validateSession() async throws -> AppUser?
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
    private let sessionValidatedAtKey = "auth.sessionValidatedAt"
    private static let sessionValidationTTL: TimeInterval = 90

    var isLoggedIn: Bool {
        session != nil
    }

    var userId: String? {
        session?.userId
    }

    func restoreSession(for scenario: AppSessionScenario) async throws -> AppUser? {
        guard loadStoredSessionSync() != nil else { return nil }
        return try await validateSession()
    }

    func loadStoredSessionSync() -> AppUser? {
        guard let storedSession = loadStoredSession() else {
            session = nil
            clearStoredSession()
            return nil
        }
        let cachedUser = AppUser(id: storedSession.userId, displayName: storedSession.profileName, email: storedSession.profileName)
        session = AuthSession(user: cachedUser, token: storedSession.token)
        return cachedUser
    }

    func validateSession() async throws -> AppUser? {
        guard let currentSession = session else { return nil }
        let storedToken = currentSession.token
        let cachedUser = AppUser(id: currentSession.userId, displayName: currentSession.profileName, email: currentSession.profileName)

        // CF-LAUNCH-FETCHSESSION-TTL: skip the /api/auth/session round-trip
        // when the cached session was validated within the TTL window. Trades
        // a small staleness window for ~100-300ms (warm) up to ~5s (slow net)
        // off cold-launch wall-clock. Invalidated on 401, sign-out, and any
        // clearStoredSession() path.
        let lastValidatedAt = UserDefaults.standard.double(forKey: sessionValidatedAtKey)
        if lastValidatedAt > 0,
           Date().timeIntervalSince1970 - lastValidatedAt < Self.sessionValidationTTL {
            return cachedUser
        }

        do {
            let response = try await withTimeout(seconds: 5) {
                try await APIService.shared.fetchSession()
            }
            guard response.success, let backendUser = response.user else {
                session = nil
                clearStoredSession()
                return nil
            }
            let user = AppUser(id: backendUser.userId, displayName: backendUser.email, email: backendUser.email)
            session = AuthSession(user: user, token: storedToken)
            UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: sessionValidatedAtKey)
            return user
        } catch let error as APIServiceError {
            if case .httpError(let code, _) = error, code == 401 {
                session = nil
                clearStoredSession()
                return nil
            }
            return cachedUser
        } catch {
            return cachedUser
        }
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
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: sessionValidatedAtKey)
        return user
    }

    func signOut() async {
        _ = try? await APIService.shared.signOutSession()
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
        UserDefaults.standard.removeObject(forKey: sessionValidatedAtKey)
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
