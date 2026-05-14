import Foundation

// MARK: - Auth Models
struct AuthUser: Codable {
    let userId: String
    let email: String
    let plan: String
    let createdAt: String
    // Username is optional because Apple Sign-In users won't have one until
    // they claim one via POST /api/auth/username.
    let username: String?
    let fullName: String?
}

struct AuthSignInRequest: Codable {
    let email: String
    let username: String
    let password: String
}

/// Body sent to POST /api/auth/register for email + password sign-up.
/// `username` is REQUIRED by the backend (3–30 chars, letters/numbers/._-)
/// — we collect it on the iOS create-account screen.
struct AuthRegisterRequest: Codable {
    let email: String
    let username: String
    let password: String
    let fullName: String?
}

/// Body sent to POST /api/auth/apple. The TS backend verifies
/// `identityToken` against Apple's JWKS, looks up / creates the user keyed on
/// the token's `sub` (Apple user id), and returns the standard AuthResponse.
struct AppleSignInRequest: Codable {
    let identityToken: String
    let authorizationCode: String?
    let nonce: String?
    let fullName: String?
    let email: String?
}

struct AuthResponse: Codable {
    let success: Bool
    let user: AuthUser?
    let sessionId: String?
    let error: String?
}

// MARK: - Auth Networking
enum AuthAPI {
    private static let base = "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"

    static func signIn(email: String, password: String) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/signin")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(AuthSignInRequest(email: email, username: email, password: password))
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    /// Create a new HobbyIQ account. `username` is required by the backend
    /// (3–30 chars, letters/digits/`._-`); duplicate username or email
    /// returns HTTP 409 with `error: "Username already taken"` /
    /// `"Email already registered"`.
    static func register(
        email: String,
        username: String,
        password: String,
        fullName: String?
    ) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/register")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(
            AuthRegisterRequest(
                email: email,
                username: username,
                password: password,
                fullName: fullName
            )
        )
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    static func signOut(sessionId: String) async throws {
        let url = URL(string: base + "/api/auth/signout")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        req.httpBody = "{}".data(using: .utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    static func fetchSession(sessionId: String) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/session")!
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 15
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    /// Exchange an Apple identity token (from ASAuthorizationAppleIDCredential)
    /// for a HobbyIQ session. Backend returns the same AuthResponse contract
    /// as email/password sign-in.
    static func signInWithApple(_ body: AppleSignInRequest) async throws -> AuthResponse {
        let url = URL(string: base + "/api/auth/apple")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }

    /// Claim or change the username on an existing signed-in account.
    /// Backend returns 409 if the username is taken, 401 if the session is
    /// invalid, 400 if the username fails regex validation.
    static func setUsername(sessionId: String, username: String) async throws -> AuthResponse {
        struct Body: Codable { let username: String }
        let url = URL(string: base + "/api/auth/username")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "x-session-id")
        req.timeoutInterval = 30
        req.httpBody = try JSONEncoder().encode(Body(username: username))
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(AuthResponse.self, from: data)
    }
}

// MARK: - Auth State
@MainActor
final class AuthManager: ObservableObject {
    static let shared = AuthManager()

    @Published private(set) var currentUser: AuthUser?
    @Published var isLoading = false
    @Published var errorMessage: String?

    private let sessionKey = "auth.sessionId"
    private var hasRestoredSession = false

    private init() {
        Task { await restoreSessionIfNeeded() }
    }

    var isAuthenticated: Bool { currentUser != nil }

    /// Username from the backend if it's been set; falls back to email for
    /// display until the user claims a handle.
    var username: String { currentUser?.username ?? currentUser?.email ?? "" }

    /// True only when the account has a claimed username (vs. just an email
    /// from Apple Sign-In). Used by AccountView to show the "Choose Username"
    /// prompt.
    var hasUsername: Bool {
        guard let u = currentUser?.username else { return false }
        return !u.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isAdminTestingAccount: Bool {
        username.caseInsensitiveCompare("drew@justtheboysandcards.com") == .orderedSame
    }

    var isOwnerPersonalAccount: Bool {
        username.caseInsensitiveCompare("JusttheBoysandCards") == .orderedSame
    }

    var accountRoleLabel: String {
        if isOwnerPersonalAccount { return "Owner / Personal" }
        if isAdminTestingAccount { return "Admin / Testing" }
        return "Standard Account"
    }

    var planLabel: String {
        (currentUser?.plan ?? "free")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    func signIn(email: String, password: String) async {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !password.isEmpty else {
            errorMessage = "Email and password required"
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            let response = try await AuthAPI.signIn(email: trimmed, password: password)
            guard response.success, let user = response.user, let sid = response.sessionId else {
                errorMessage = response.error ?? "Invalid username or password"
                isLoading = false
                return
            }
            UserDefaults.standard.set(sid, forKey: sessionKey)
            currentUser = user
        } catch {
            errorMessage = "Network error – check your connection"
        }
        isLoading = false
    }

    /// Create a new account. Username is REQUIRED — the backend validates
    /// 3–30 chars (letters, digits, `._-`) and rejects duplicates with HTTP
    /// 409. On success the user is signed in and a session is persisted.
    func register(
        email: String,
        username: String,
        password: String,
        fullName: String?
    ) async {
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = fullName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyOrNil

        guard !trimmedEmail.isEmpty else {
            errorMessage = "Email is required"
            return
        }
        guard !trimmedUsername.isEmpty else {
            errorMessage = "Username is required"
            return
        }
        // Mirror backend USERNAME_RE so we don't make a round-trip just to
        // surface a validation error.
        let usernameRegex = #"^[a-zA-Z0-9_.-]{3,30}$"#
        guard trimmedUsername.range(of: usernameRegex, options: .regularExpression) != nil else {
            errorMessage = "Username must be 3–30 chars (letters, numbers, . _ -)"
            return
        }
        guard password.count >= 8 else {
            errorMessage = "Password must be at least 8 characters"
            return
        }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await AuthAPI.register(
                email: trimmedEmail,
                username: trimmedUsername,
                password: password,
                fullName: trimmedName
            )
            guard response.success,
                  let user = response.user,
                  let sid = response.sessionId else {
                errorMessage = response.error ?? "Could not create account"
                return
            }
            UserDefaults.standard.set(sid, forKey: sessionKey)
            UserDefaults.standard.set(user.userId, forKey: "auth.userId")
            if let displayName = trimmedName ?? response.user?.email {
                UserDefaults.standard.set(displayName, forKey: "auth.displayName")
            }
            currentUser = user
            NotificationCenter.default.post(name: .authSignInSucceeded, object: nil)
        } catch {
            errorMessage = "Network error – check your connection"
        }
    }

    /// Claim or change the username on the currently signed-in account.
    /// Validates the same regex as registration and surfaces backend errors
    /// (409 already taken, 401 invalid session) via `errorMessage`. Returns
    /// true on success.
    @discardableResult
    func setUsername(_ raw: String) async -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let regex = #"^[a-zA-Z0-9_.-]{3,30}$"#
        guard trimmed.range(of: regex, options: .regularExpression) != nil else {
            errorMessage = "Username must be 3–30 chars (letters, numbers, . _ -)"
            return false
        }
        guard let sid = UserDefaults.standard.string(forKey: sessionKey) else {
            errorMessage = "You must be signed in"
            return false
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let response = try await AuthAPI.setUsername(sessionId: sid, username: trimmed)
            guard response.success, let user = response.user else {
                errorMessage = response.error ?? "Could not save username"
                return false
            }
            currentUser = user
            return true
        } catch {
            errorMessage = "Network error – check your connection"
            return false
        }
    }

    func signOut() async {
        // Best-effort: tell the backend to drop our push token first so
        // pushes stop immediately. Must run while sessionId is still set.
        await PriceAlertService.shared.unregisterDeviceTokenFromBackend()
        if let sid = UserDefaults.standard.string(forKey: sessionKey) {
            try? await AuthAPI.signOut(sessionId: sid)
        }
        UserDefaults.standard.removeObject(forKey: sessionKey)
        UserDefaults.standard.removeObject(forKey: "auth.userId")
        UserDefaults.standard.removeObject(forKey: "auth.displayName")
        currentUser = nil
    }

    /// Apple Sign-In entry. Pass the raw token bytes from
    /// ASAuthorizationAppleIDCredential along with the nonce that was attached
    /// to the request. Updates `currentUser` on success and persists session +
    /// userId + displayName to UserDefaults.
    func signInWithApple(
        identityToken: Data,
        authorizationCode: Data?,
        nonce: String?,
        fullName: String?,
        email: String?
    ) async {
        guard let idTokenString = String(data: identityToken, encoding: .utf8) else {
            errorMessage = "Invalid Apple identity token"
            return
        }
        let codeString = authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        let trimmedName = fullName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyOrNil
        let trimmedEmail = email?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmptyOrNil

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let body = AppleSignInRequest(
                identityToken: idTokenString,
                authorizationCode: codeString,
                nonce: nonce,
                fullName: trimmedName,
                email: trimmedEmail
            )
            let response = try await AuthAPI.signInWithApple(body)
            guard response.success,
                  let user = response.user,
                  let sid = response.sessionId else {
                errorMessage = response.error ?? "Apple sign-in failed"
                return
            }
            UserDefaults.standard.set(sid, forKey: sessionKey)
            UserDefaults.standard.set(user.userId, forKey: "auth.userId")
            if let displayName = trimmedName ?? response.user?.email {
                UserDefaults.standard.set(displayName, forKey: "auth.displayName")
            }
            currentUser = user
            NotificationCenter.default.post(name: .authSignInSucceeded, object: nil)
        } catch {
            errorMessage = "Network error – check your connection"
        }
    }

    func restoreSessionIfNeeded() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        guard let sid = UserDefaults.standard.string(forKey: sessionKey) else { return }
        do {
            let response = try await AuthAPI.fetchSession(sessionId: sid)
            if response.success, let user = response.user {
                currentUser = user
                UserDefaults.standard.set(user.userId, forKey: "auth.userId")
            } else {
                UserDefaults.standard.removeObject(forKey: sessionKey)
            }
        } catch {
            // Network blip on cold start — don't wipe the saved session here.
            // The next authenticated call will fail and trigger sign-out.
        }
    }
}

extension Notification.Name {
    /// Posted by AuthManager after a successful Apple Sign-In completes.
    /// SignInView listens for this so the cover can dismiss without polling.
    static let authSignInSucceeded = Notification.Name("auth.signInSucceeded")
}

private extension String {
    var nonEmptyOrNil: String? { isEmpty ? nil : self }
}
